import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * A tiny HTTP server that streams the chosen video to the device playing it.
 *
 * TVs and casting receivers will not read a file path - they fetch a URL over
 * the network. So the file stays where it is and this serves it from the
 * machine's LAN address.
 *
 * Range requests are mandatory, not an optimisation: most DLNA renderers issue
 * a `Range: bytes=0-` probe and refuse to start if the server answers 200
 * instead of 206, and seeking does not work at all without them.
 */

export interface SharedMedia {
  id: string;
  filePath: string;
  fileName: string;
  size: number;
  mimeType: string;
  /** URL the receiver should fetch, on the LAN address. */
  url: string;
}

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.m2ts': 'video/mp2t',
  '.ts': 'video/mp2t',
  '.3gp': 'video/3gpp',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt',
};

export const VIDEO_EXTENSIONS = [
  'mp4', 'm4v', 'mkv', 'mov', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', 'ts', '3gp', 'ogv',
];

export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg'];

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Parses a single-range `Range: bytes=start-end` header. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, startRaw, endRaw] = match;
  if (startRaw === '' && endRaw === '') return null;

  let start: number;
  let end: number;

  if (startRaw === '') {
    // Suffix form: `bytes=-500` means the last 500 bytes.
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? size - 1 : Number(endRaw);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

export class MediaServer {
  private server?: http.Server;
  private port = 0;
  private readonly shared = new Map<string, Omit<SharedMedia, 'url'>>();

  constructor(private host: string) {}

  get address(): string | undefined {
    return this.server ? `http://${this.host}:${this.port}` : undefined;
  }

  /** Starts on an ephemeral port bound to all interfaces. Idempotent. */
  async start(host: string): Promise<string> {
    this.host = host;
    if (this.server) return this.address!;

    const server = http.createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });

    // Receivers can be slow to start reading; do not drop them early.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 70_000;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    this.server = server;
    return this.address!;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    this.shared.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  /** Publishes a file and returns the URL a receiver should fetch. */
  async share(filePath: string): Promise<SharedMedia> {
    if (!this.server) throw new Error('Media server is not running');

    let stats: Stats;
    try {
      stats = await stat(filePath);
    } catch {
      throw new Error(`Cannot read ${filePath}`);
    }
    if (!stats.isFile()) throw new Error(`${filePath} is not a file`);

    const id = randomUUID();
    const fileName = path.basename(filePath);
    const entry = { id, filePath, fileName, size: stats.size, mimeType: mimeTypeFor(filePath) };
    this.shared.set(id, entry);

    // The filename is in the path because some renderers infer the container
    // from the URL extension rather than from Content-Type.
    return { ...entry, url: `${this.address}/media/${id}/${encodeURIComponent(fileName)}` };
  }

  unshare(id: string): void {
    this.shared.delete(id);
  }

  /**
   * Serves a file under a different MIME type than its extension implies.
   *
   * Needed because renderers reject content whose `Content-Type` is not one
   * they advertised, even when they can decode it - the DLNA client negotiates
   * an accepted spelling and the served headers have to match.
   */
  setMimeType(id: string, mimeType: string): void {
    const entry = this.shared.get(id);
    if (entry) this.shared.set(id, { ...entry, mimeType });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? this.host}`);
    const match = /^\/media\/([0-9a-f-]{36})\//.exec(url.pathname);
    const entry = match ? this.shared.get(match[1]) : undefined;

    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': entry.mimeType,
      'Accept-Ranges': 'bytes',
      // DLNA renderers check these before they will start a stream.
      'transferMode.dlna.org': 'Streaming',
      'contentFeatures.dlna.org': 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000',
      Connection: 'keep-alive',
    };

    // HEAD is how most renderers check the file before committing to play it.
    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'Content-Length': entry.size });
      res.end();
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }

    const rangeHeader = req.headers.range;
    const range = parseRange(Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader, entry.size);

    if (rangeHeader && !range) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${entry.size}` });
      res.end();
      return;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? entry.size - 1;

    res.writeHead(range ? 206 : 200, {
      ...headers,
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${entry.size}` } : {}),
    });

    const stream = createReadStream(entry.filePath, { start, end });
    stream.on('error', () => res.destroy());
    // A receiver that seeks simply drops the connection; that is normal.
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}
