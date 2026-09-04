/**
 * HTTP banner grabbing.
 *
 * Embedded devices identify themselves in their `Server:` header and page
 * title far more reliably than their MAC vendor does. A TP-Link Deco mesh
 * satellite answers `Server: SHIP 2.0`, a Synology NAS says `nginx` with a
 * DSM title, cameras run `Boa` or `GoAhead`. That is direct evidence about
 * what a box *is*, rather than an inference from who made it.
 *
 * Only the first few KB are read, and only from ports that already answered a
 * TCP probe.
 */

export interface HttpBanner {
  port: number;
  scheme: 'http' | 'https';
  status: number;
  server?: string;
  title?: string;
  /** `WWW-Authenticate` realm, which often names the product. */
  realm?: string;
  poweredBy?: string;
  location?: string;
}

/** Ports worth asking for a banner, most informative first. */
const BANNER_PORTS = [80, 443, 8080, 8443, 8008, 5000, 9090, 8000, 8888];

const MAX_BODY_BYTES = 24 * 1024;

async function grabOne(ip: string, port: number, timeoutMs: number): Promise<HttpBanner | undefined> {
  const scheme = port === 443 || port === 8443 ? 'https' : 'http';
  const url = `${scheme}://${ip}:${port}/`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
      headers: { 'User-Agent': 'LANMediaScout/1.0', Accept: 'text/html,*/*' },
    });

    let title: string | undefined;
    const contentType = response.headers.get('content-type') ?? '';

    if (/text\/html|text\/plain|application\/xml/i.test(contentType)) {
      // Read a bounded prefix - some devices stream an endless page.
      const body = await readPrefix(response, MAX_BODY_BYTES);
      title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(body)?.[1]?.trim() || undefined;
    } else {
      await response.body?.cancel();
    }

    return {
      port,
      scheme,
      status: response.status,
      server: response.headers.get('server') ?? undefined,
      title,
      realm: /realm="([^"]{1,80})"/i.exec(response.headers.get('www-authenticate') ?? '')?.[1],
      poweredBy: response.headers.get('x-powered-by') ?? undefined,
      location: response.headers.get('location') ?? undefined,
    };
  } catch {
    return undefined;
  }
}

async function readPrefix(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.length;
      if (total >= limit) break;
    }
  } catch {
    // Truncated response; whatever arrived is still usable.
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8', 0, limit);
}

/**
 * Grabs a banner from the most informative open web port on a host. Stops at
 * the first port that answers with something identifying.
 */
export async function grabHttpBanner(
  ip: string,
  openPorts: number[],
  timeoutMs = 3500,
): Promise<HttpBanner | undefined> {
  const candidates = BANNER_PORTS.filter((port) => openPorts.includes(port));
  if (candidates.length === 0) return undefined;

  let fallback: HttpBanner | undefined;

  for (const port of candidates.slice(0, 3)) {
    const banner = await grabOne(ip, port, timeoutMs);
    if (!banner) continue;
    if (banner.server || banner.title || banner.realm) return banner;
    fallback ??= banner;
  }

  return fallback;
}
