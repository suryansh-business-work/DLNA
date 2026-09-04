import tls from 'node:tls';
import type { SharedMedia } from './mediaServer';

/**
 * Minimal Google Cast (CASTV2) client.
 *
 * The wire format is a 4-byte big-endian length followed by a protobuf
 * `CastMessage`. That message has only seven fields, all of them strings or
 * varints, so it is hand-encoded here rather than pulling in a protobuf runtime
 * and a .proto file for one message type.
 *
 *   message CastMessage {
 *     ProtocolVersion protocol_version = 1;  // varint, always 0
 *     string source_id                 = 2;
 *     string destination_id            = 3;
 *     string namespace                 = 4;
 *     PayloadType payload_type         = 5;  // varint, 0 = STRING
 *     string payload_utf8              = 6;
 *     bytes  payload_binary            = 7;  // unused here
 *   }
 */

const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';
const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
const NS_MEDIA = 'urn:x-cast:com.google.cast.media';

/** Google's Default Media Receiver - plays a URL with no custom app needed. */
const DEFAULT_MEDIA_RECEIVER = 'CC1AD845';

const CAST_PORT = 8009;
const SENDER_ID = 'sender-0';
const RECEIVER_ID = 'receiver-0';

interface CastFrame {
  sourceId: string;
  destinationId: string;
  namespace: string;
  payload: string;
}

/* ---------------------------------------------------------------- protobuf */

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function lengthDelimited(fieldNumber: number, value: string): Buffer {
  const payload = Buffer.from(value, 'utf8');
  return Buffer.concat([
    Buffer.from([(fieldNumber << 3) | 2]),
    varint(payload.length),
    payload,
  ]);
}

function encodeFrame(frame: CastFrame): Buffer {
  const message = Buffer.concat([
    Buffer.from([0x08, 0x00]), // protocol_version = CASTV2_1_0
    lengthDelimited(2, frame.sourceId),
    lengthDelimited(3, frame.destinationId),
    lengthDelimited(4, frame.namespace),
    Buffer.from([0x28, 0x00]), // payload_type = STRING
    lengthDelimited(6, frame.payload),
  ]);

  const header = Buffer.alloc(4);
  header.writeUInt32BE(message.length, 0);
  return Buffer.concat([header, message]);
}

function decodeFrame(buffer: Buffer): CastFrame | undefined {
  const frame: CastFrame = { sourceId: '', destinationId: '', namespace: '', payload: '' };
  let offset = 0;

  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    while (offset < buffer.length) {
      const byte = buffer[offset++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  };

  while (offset < buffer.length) {
    const key = readVarint();
    const fieldNumber = key >>> 3;
    const wireType = key & 0x07;

    if (wireType === 0) {
      readVarint();
      continue;
    }
    if (wireType !== 2) return undefined; // Not a shape this message uses.

    const length = readVarint();
    const value = buffer.subarray(offset, offset + length);
    offset += length;

    switch (fieldNumber) {
      case 2:
        frame.sourceId = value.toString('utf8');
        break;
      case 3:
        frame.destinationId = value.toString('utf8');
        break;
      case 4:
        frame.namespace = value.toString('utf8');
        break;
      case 6:
        frame.payload = value.toString('utf8');
        break;
      default:
        break;
    }
  }

  return frame;
}

/* ---------------------------------------------------------------- client */

export interface CastMediaStatus {
  state: 'PLAYING' | 'PAUSED' | 'BUFFERING' | 'IDLE' | 'UNKNOWN';
  position: number;
  duration: number;
}

export class ChromecastClient {
  private socket?: tls.TLSSocket;
  private buffer = Buffer.alloc(0);
  private requestId = 1;
  private transportId?: string;
  private sessionId?: string;
  private mediaSessionId?: number;
  private heartbeat?: NodeJS.Timeout;
  private lastStatus: CastMediaStatus = { state: 'UNKNOWN', position: 0, duration: 0 };
  private readonly waiters = new Map<number, (payload: Record<string, unknown>) => void>();
  private closed = false;

  constructor(private readonly ip: string) {}

  get status(): CastMediaStatus {
    return this.lastStatus;
  }

  private send(namespace: string, payload: Record<string, unknown>, destination: string): void {
    if (!this.socket || this.closed) return;
    this.socket.write(
      encodeFrame({
        sourceId: SENDER_ID,
        destinationId: destination,
        namespace,
        payload: JSON.stringify(payload),
      }),
    );
  }

  /** Sends a request and resolves with the reply carrying the same requestId. */
  private request(
    namespace: string,
    payload: Record<string, unknown>,
    destination: string,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    const requestId = this.requestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new Error(`Chromecast did not answer ${String(payload.type)} in time`));
      }, timeoutMs);

      this.waiters.set(requestId, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });

      this.send(namespace, { ...payload, requestId }, destination);
    });
  }

  async connect(): Promise<void> {
    if (this.socket) return;

    this.socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const socket = tls.connect(
        {
          host: this.ip,
          port: CAST_PORT,
          // Cast devices present a self-signed certificate. The connection is
          // to a fixed IP on the local network and carries no credentials.
          rejectUnauthorized: false,
          timeout: 10_000,
        },
        () => resolve(socket),
      );
      socket.once('error', reject);
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error(`Timed out connecting to ${this.ip}:${CAST_PORT}`));
      });
    });

    this.socket.on('data', (chunk: Buffer | string) => {
      this.onData(typeof chunk === 'string' ? Buffer.from(chunk, 'binary') : chunk);
    });
    this.socket.on('error', () => this.close());
    this.socket.on('close', () => this.close());

    this.send(NS_CONNECTION, { type: 'CONNECT' }, RECEIVER_ID);

    // The receiver drops senders that go quiet for ~10 seconds.
    this.heartbeat = setInterval(() => this.send(NS_HEARTBEAT, { type: 'PING' }, RECEIVER_ID), 4500);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      if (this.buffer.length < 4) return;
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + length) return;

      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);

      const frame = decodeFrame(body);
      if (frame) this.onFrame(frame);
    }
  }

  private onFrame(frame: CastFrame): void {
    if (frame.namespace === NS_HEARTBEAT) {
      if (frame.payload.includes('"PING"')) this.send(NS_HEARTBEAT, { type: 'PONG' }, RECEIVER_ID);
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(frame.payload) as Record<string, unknown>;
    } catch {
      return;
    }

    if (frame.namespace === NS_MEDIA) this.absorbMediaStatus(payload);

    const requestId = typeof payload.requestId === 'number' ? payload.requestId : undefined;
    if (requestId !== undefined) {
      const waiter = this.waiters.get(requestId);
      if (waiter) {
        this.waiters.delete(requestId);
        waiter(payload);
      }
    }
  }

  private absorbMediaStatus(payload: Record<string, unknown>): void {
    const statuses = payload.status;
    if (!Array.isArray(statuses) || statuses.length === 0) return;

    const status = statuses[0] as Record<string, unknown>;
    if (typeof status.mediaSessionId === 'number') this.mediaSessionId = status.mediaSessionId;

    const media = status.media as Record<string, unknown> | undefined;
    const rawState = String(status.playerState ?? 'UNKNOWN');

    this.lastStatus = {
      state: (['PLAYING', 'PAUSED', 'BUFFERING', 'IDLE'] as const).find((s) => s === rawState) ?? 'UNKNOWN',
      position: Number(status.currentTime ?? 0),
      duration: Number(media?.duration ?? this.lastStatus.duration ?? 0),
    };
  }

  /** Launches the default media receiver and returns its transport id. */
  private async launch(): Promise<string> {
    if (this.transportId) return this.transportId;

    const reply = await this.request(
      NS_RECEIVER,
      { type: 'LAUNCH', appId: DEFAULT_MEDIA_RECEIVER },
      RECEIVER_ID,
      15_000,
    );

    if (reply.type === 'LAUNCH_ERROR') {
      throw new Error(`Chromecast refused to launch the media receiver: ${String(reply.reason ?? '')}`);
    }

    const status = reply.status as Record<string, unknown> | undefined;
    const applications = (status?.applications ?? []) as Array<Record<string, unknown>>;
    const application = applications.find((app) => app.appId === DEFAULT_MEDIA_RECEIVER) ?? applications[0];

    const transportId = application?.transportId;
    if (typeof transportId !== 'string') throw new Error('Chromecast did not return a transport id');

    this.transportId = transportId;
    this.sessionId = typeof application?.sessionId === 'string' ? application.sessionId : undefined;

    // A separate virtual connection is required per destination.
    this.send(NS_CONNECTION, { type: 'CONNECT' }, transportId);
    return transportId;
  }

  async play(media: SharedMedia): Promise<void> {
    await this.connect();
    const transportId = await this.launch();

    const reply = await this.request(
      NS_MEDIA,
      {
        type: 'LOAD',
        sessionId: this.sessionId,
        autoplay: true,
        currentTime: 0,
        media: {
          contentId: media.url,
          contentType: media.mimeType,
          streamType: 'BUFFERED',
          metadata: { metadataType: 0, type: 0, title: media.fileName },
        },
      },
      transportId,
      20_000,
    );

    if (reply.type === 'LOAD_FAILED' || reply.type === 'INVALID_REQUEST') {
      throw new Error(
        `Chromecast could not play this file (${String(reply.reason ?? reply.type)}). ` +
          'Cast devices only handle a limited set of codecs - MP4/H.264 is the safest.',
      );
    }
  }

  private async mediaCommand(type: string): Promise<void> {
    if (!this.transportId || this.mediaSessionId === undefined) {
      throw new Error('Nothing is playing on this device yet');
    }
    await this.request(NS_MEDIA, { type, mediaSessionId: this.mediaSessionId }, this.transportId);
  }

  pause(): Promise<void> {
    return this.mediaCommand('PAUSE');
  }

  resume(): Promise<void> {
    return this.mediaCommand('PLAY');
  }

  async stop(): Promise<void> {
    await this.mediaCommand('STOP').catch(() => undefined);
    if (this.sessionId) {
      await this.request(NS_RECEIVER, { type: 'STOP', sessionId: this.sessionId }, RECEIVER_ID).catch(
        () => undefined,
      );
    }
    this.transportId = undefined;
    this.sessionId = undefined;
    this.mediaSessionId = undefined;
  }

  async seek(seconds: number): Promise<void> {
    if (!this.transportId || this.mediaSessionId === undefined) return;
    await this.request(
      NS_MEDIA,
      { type: 'SEEK', mediaSessionId: this.mediaSessionId, currentTime: Math.max(0, seconds) },
      this.transportId,
    );
  }

  async setVolume(percent: number): Promise<void> {
    await this.connect();
    await this.request(
      NS_RECEIVER,
      { type: 'SET_VOLUME', volume: { level: Math.max(0, Math.min(1, percent / 100)) } },
      RECEIVER_ID,
    );
  }

  /** Refreshes and returns the receiver's media status. */
  async refreshStatus(): Promise<CastMediaStatus> {
    if (!this.transportId || this.closed) return this.lastStatus;
    await this.request(NS_MEDIA, { type: 'GET_STATUS' }, this.transportId, 5000).catch(
      () => undefined,
    );
    return this.lastStatus;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const waiter of this.waiters.values()) waiter({ type: 'CLOSED' });
    this.waiters.clear();
    this.socket?.destroy();
    this.socket = undefined;
  }
}
