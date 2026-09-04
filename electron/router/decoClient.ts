import { createCipheriv, createDecipheriv, createHash, createPublicKey, publicEncrypt, constants } from 'node:crypto';

/**
 * TP-Link Deco / Omada local API client.
 *
 * This is the same interface the Deco phone app uses, and it is the only way to
 * learn which mesh node a client is actually joined to - Wi-Fi association is
 * not visible anywhere on the wire.
 *
 * The transport is unusual enough to be worth spelling out:
 *
 *  1. `POST /login?form=keys` returns a 1024-bit RSA public key used to encrypt
 *     the password.
 *  2. `POST /login?form=auth` returns a 512-bit RSA key used to sign requests,
 *     plus a per-session sequence number.
 *  3. Every subsequent request body is JSON, AES-128-CBC encrypted with a
 *     per-session key, base64'd, and posted as form data alongside an RSA
 *     signature over `key/iv/password-hash/sequence`.
 *
 * None of this is documented by TP-Link; the scheme is well known from the
 * Home Assistant `tplink_deco` integration and equivalents. It can change with
 * a firmware update, so every failure path here reports a readable reason
 * rather than throwing something opaque.
 */

const USERNAME = 'admin';
const TIMEOUT_MS = 12_000;

export interface DecoNode {
  /** MAC of the Deco unit itself. */
  mac: string;
  ip?: string;
  name: string;
  /** 'master' for the unit doing the routing, 'slave' for a satellite. */
  role?: string;
  hardwareVersion?: string;
  softwareVersion?: string;
}

export interface DecoClient {
  mac: string;
  ip?: string;
  name: string;
  /** MAC of the Deco unit this client is connected through. */
  nodeMac?: string;
  /** 'wired' or a wireless band such as 'band5' / 'band2_4'. */
  connection?: string;
  wireType?: string;
  online: boolean;
  /** Everything the router returned, so unmapped fields stay inspectable. */
  raw: Record<string, unknown>;
}

export interface DecoSnapshot {
  nodes: DecoNode[];
  clients: DecoClient[];
  fetchedAt: number;
}

/* ------------------------------------------------------------------ crypto */

function evenHex(hex: string): string {
  const clean = hex.trim().replace(/^0x/i, '');
  return clean.length % 2 === 1 ? `0${clean}` : clean;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Builds a public key from the hex modulus/exponent the router hands out. */
function publicKeyFrom(nHex: string, eHex: string) {
  let modulus = Buffer.from(evenHex(nHex), 'hex');
  // JWK requires the modulus without leading zero padding.
  let start = 0;
  while (start < modulus.length - 1 && modulus[start] === 0) start++;
  modulus = modulus.subarray(start);

  return {
    key: createPublicKey({
      key: { kty: 'RSA', n: base64Url(modulus), e: base64Url(Buffer.from(evenHex(eHex), 'hex')) },
      format: 'jwk',
    }),
    byteLength: modulus.length,
  };
}

/**
 * RSA/PKCS#1 v1.5, chunked to the key size and hex-concatenated - which is how
 * the router's own JavaScript does it, so anything else is rejected.
 */
function rsaEncrypt(data: string, nHex: string, eHex: string): string {
  const { key, byteLength } = publicKeyFrom(nHex, eHex);
  const chunkSize = byteLength - 11;
  if (chunkSize <= 0) throw new Error('Router returned an unusable RSA key');

  const input = Buffer.from(data, 'utf8');
  let out = '';
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    const chunk = input.subarray(offset, offset + chunkSize);
    out += publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, chunk).toString('hex');
  }
  return out;
}

/** 16 ASCII digits, matching the key shape the router's client generates. */
function randomDigits(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += Math.floor(Math.random() * 10);
  return out;
}

function aesEncrypt(plain: string, key: string, iv: string): string {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
}

function aesDecrypt(encoded: string, key: string, iv: string): string {
  const decipher = createDecipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  return Buffer.concat([decipher.update(Buffer.from(encoded, 'base64')), decipher.final()]).toString('utf8');
}

const md5 = (value: string): string => createHash('md5').update(value).digest('hex');

/** Deco returns display names base64-encoded. */
function decodeName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    // Only trust it if it round-trips and looks like text.
    if (Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '')) {
      // eslint-disable-next-line no-control-regex
      return /^[\x20-\x7E -￿]*$/.test(decoded) ? decoded : value;
    }
  } catch {
    // Not base64 - use it as-is.
  }
  return value;
}

function normalizeMac(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (raw.length !== 12) return undefined;
  return raw.match(/.{2}/g)!.join(':');
}

/* ------------------------------------------------------------------ client */

export class DecoRouterClient {
  private aesKey = '';
  private aesIv = '';
  private hash = '';
  private seq = 0;
  private signKey?: [string, string];
  private stok?: string;

  constructor(private readonly host: string) {}

  private url(path: string, stok = ''): string {
    return `http://${this.host}/cgi-bin/luci/;stok=${stok}${path}`;
  }

  private async postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(this.url(path), {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Referer: `http://${this.host}/` },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Router replied HTTP ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }

  /** Sends an encrypted+signed request and returns the decrypted payload. */
  private async postEncrypted(
    path: string,
    body: unknown,
    options: { isLogin?: boolean; stok?: string } = {},
  ): Promise<Record<string, unknown>> {
    if (!this.signKey) throw new Error('Not connected to the router');

    const encrypted = aesEncrypt(JSON.stringify(body), this.aesKey, this.aesIv);
    const signature = rsaEncrypt(
      options.isLogin
        ? `k=${this.aesKey}&i=${this.aesIv}&h=${this.hash}&s=${this.seq + encrypted.length}`
        : `h=${this.hash}&s=${this.seq + encrypted.length}`,
      this.signKey[0],
      this.signKey[1],
    );

    const form = new URLSearchParams({ sign: signature, data: encrypted });

    const response = await fetch(this.url(path, options.stok ?? this.stok ?? ''), {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `http://${this.host}/` },
      body: form.toString(),
    });
    if (!response.ok) throw new Error(`Router replied HTTP ${response.status}`);

    const envelope = (await response.json()) as Record<string, unknown>;
    if (typeof envelope.data !== 'string') {
      throw new Error(describeError(envelope));
    }

    const decrypted = JSON.parse(aesDecrypt(envelope.data, this.aesKey, this.aesIv)) as Record<
      string,
      unknown
    >;
    if (decrypted.error_code !== 0) throw new Error(describeError(decrypted));
    return decrypted;
  }

  /** Authenticates and stores the session token. */
  async login(password: string): Promise<void> {
    this.aesKey = randomDigits(16);
    this.aesIv = randomDigits(16);
    this.hash = md5(USERNAME + password);

    const keys = await this.postJson('/login?form=keys', { operation: 'read' });
    const passwordKey = readKeyPair(keys, 'password');
    if (!passwordKey) throw new Error('Router did not return a password key');

    const auth = await this.postJson('/login?form=auth', { operation: 'read' });
    const signKey = readKeyPair(auth, 'key');
    const seq = readSeq(auth);
    if (!signKey || seq === undefined) throw new Error('Router did not return a signing key');

    this.signKey = signKey;
    this.seq = seq;

    let result: Record<string, unknown>;
    try {
      result = await this.postEncrypted(
        '/login?form=login',
        { operation: 'login', params: { password: rsaEncrypt(password, passwordKey[0], passwordKey[1]) } },
        { isLogin: true, stok: '' },
      );
    } catch (error) {
      // Some Deco models are managed only through the phone app: they expose
      // the encrypted transport and the key exchange, but register no local
      // `login` callback at all, so there is no password to be right about.
      // Saying so beats reporting a raw protocol error the user cannot act on.
      if (/no such callback/i.test((error as Error).message)) {
        throw new Error(
          'This router has no local login. Some Deco models are managed only through the ' +
            'TP-Link app, so the per-node client list is not reachable on the LAN.',
        );
      }
      throw error;
    }

    const stok = (result.result as Record<string, unknown> | undefined)?.stok;
    if (typeof stok !== 'string' || stok.length === 0) {
      throw new Error('Router accepted the request but returned no session token');
    }
    this.stok = stok;
  }

  /** The mesh units themselves. */
  async listNodes(): Promise<DecoNode[]> {
    const response = await this.postEncrypted('/admin/device?form=device_list', { operation: 'read' });
    const list = (response.result as Record<string, unknown> | undefined)?.device_list;
    if (!Array.isArray(list)) return [];

    return list.flatMap((entry) => {
      const item = entry as Record<string, unknown>;
      const mac = normalizeMac(item.mac ?? item.device_mac);
      if (!mac) return [];
      return [
        {
          mac,
          ip: typeof item.device_ip === 'string' ? item.device_ip : undefined,
          name:
            decodeName(item.custom_nickname) ??
            decodeName(item.nickname) ??
            decodeName(item.device_model) ??
            'Deco unit',
          role: typeof item.role === 'string' ? item.role : undefined,
          hardwareVersion: typeof item.hardware_ver === 'string' ? item.hardware_ver : undefined,
          softwareVersion: typeof item.software_ver === 'string' ? item.software_ver : undefined,
        },
      ];
    });
  }

  /** Connected clients, each tagged with the mesh unit it is joined to. */
  async listClients(): Promise<DecoClient[]> {
    const response = await this.postEncrypted('/admin/client?form=client_list', {
      operation: 'read',
      params: { device_mac: 'default' },
    });

    const list = (response.result as Record<string, unknown> | undefined)?.client_list;
    if (!Array.isArray(list)) return [];

    return list.flatMap((entry) => {
      const item = entry as Record<string, unknown>;
      const mac = normalizeMac(item.mac);
      if (!mac) return [];

      // Firmware revisions disagree on the field naming for "which unit is this
      // client on", so accept any of the spellings seen in the wild.
      const nodeMac =
        normalizeMac(item.owner_mac) ??
        normalizeMac(item.device_mac) ??
        normalizeMac(item.access_host) ??
        normalizeMac(item.connected_deco);

      return [
        {
          mac,
          ip: typeof item.ip === 'string' ? item.ip : undefined,
          name: decodeName(item.name) ?? mac,
          nodeMac,
          connection: typeof item.connection_type === 'string' ? item.connection_type : undefined,
          wireType: typeof item.wire_type === 'string' ? item.wire_type : undefined,
          online: item.online !== false,
          raw: item,
        },
      ];
    });
  }

  async snapshot(): Promise<DecoSnapshot> {
    const [nodes, clients] = await Promise.all([
      this.listNodes().catch(() => [] as DecoNode[]),
      this.listClients(),
    ]);
    return { nodes, clients, fetchedAt: Date.now() };
  }
}

/* ------------------------------------------------------------------ helpers */

function readKeyPair(payload: Record<string, unknown>, field: string): [string, string] | undefined {
  const result = payload.result as Record<string, unknown> | undefined;
  const pair = result?.[field];
  if (!Array.isArray(pair) || pair.length < 2) return undefined;
  const [n, e] = pair;
  if (typeof n !== 'string' || typeof e !== 'string') return undefined;
  return [n, e];
}

function readSeq(payload: Record<string, unknown>): number | undefined {
  const result = payload.result as Record<string, unknown> | undefined;
  return typeof result?.seq === 'number' ? result.seq : undefined;
}

/** Turns the router's numeric error codes into something worth showing a user. */
function describeError(payload: Record<string, unknown>): string {
  const code = payload.error_code;
  const map: Record<string, string> = {
    '-5002': 'Wrong router password.',
    '-5000': 'Wrong router password.',
    '-40401': 'Session expired - reconnecting.',
    '-40210': 'Too many failed attempts; the router is rate-limiting logins. Wait a minute and retry.',
  };
  const known = map[String(code)];
  if (known) return known;
  if (typeof payload.msg === 'string' && payload.msg.length > 0) {
    return `Router error ${String(code)}: ${payload.msg}`;
  }
  return `Router refused the request (error ${String(code)})`;
}
