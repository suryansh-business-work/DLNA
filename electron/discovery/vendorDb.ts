import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { VendorDbStatus } from '../../shared/types';
import { lookupVendor, normalizeMac, type VendorMatch } from './oui';

/**
 * Optional full vendor database.
 *
 * The bundled OUI table in `oui.ts` covers common consumer gear, but plenty of
 * real hardware sits outside it. Wireshark publishes the complete IEEE
 * registry - MA-L (24-bit), MA-M (28-bit) and MA-S (36-bit) blocks - as a
 * single plain-text file, which we can cache locally.
 *
 * This is opt-in: nothing is downloaded unless the user asks for it, and every
 * lookup falls back to the bundled table when no database is loaded.
 */

const MANUF_URL = 'https://www.wireshark.org/download/automated/data/manuf';
const CACHE_FILE = 'vendor-db.json';
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface CacheFile {
  version: 1;
  fetchedAt: number;
  /** Prefix (hex, no separators) -> vendor name, keyed by nibble length. */
  m24: Record<string, string>;
  m28: Record<string, string>;
  m36: Record<string, string>;
}

/** Trailing legal boilerplate that adds nothing in a device list. */
const LEGAL_SUFFIX =
  /[\s,]*\b(?:inc|inc\.|incorporated|corp|corp\.|corporation|co|co\.|company|ltd|ltd\.|limited|llc|l\.l\.c\.|gmbh|ag|s\.a\.|sa|sas|s\.a\.s|b\.v\.|bv|n\.v\.|nv|pty|plc|oy|ab|a\/s|as|kg|kk|k\.k\.|pte|sdn|bhd|srl|s\.r\.l|spa|s\.p\.a|technologies|technology|tech|electronics|electronic|international|holdings?|group|systems?)\b\.?/gi;

/** Turns "Samsung Electronics Co.,Ltd" into "Samsung". */
export function tidyVendor(name: string): string {
  let tidy = name.replace(/\([^)]*\)/g, ' ');
  let previous: string;
  do {
    previous = tidy;
    tidy = tidy.replace(LEGAL_SUFFIX, ' ');
  } while (tidy !== previous);

  tidy = tidy.replace(/[\s,.]+$/g, '').replace(/\s{2,}/g, ' ').trim();
  return tidy || name.trim();
}

export class VendorDatabase {
  private m24 = new Map<string, string>();
  private m28 = new Map<string, string>();
  private m36 = new Map<string, string>();
  private fetchedAt?: number;
  private source: VendorDbStatus['source'] = 'bundled';
  private lastError?: string;

  constructor(private readonly cacheDir: string) {}

  private get cachePath(): string {
    return path.join(this.cacheDir, CACHE_FILE);
  }

  get status(): VendorDbStatus {
    return {
      loaded: this.m24.size > 0,
      entryCount: this.m24.size + this.m28.size + this.m36.size,
      fetchedAt: this.fetchedAt,
      source: this.source,
      error: this.lastError,
    };
  }

  /** Loads a previously cached database, if one exists and is not stale. */
  async loadFromCache(): Promise<VendorDbStatus> {
    try {
      const raw = await readFile(this.cachePath, 'utf8');
      const cache = JSON.parse(raw) as CacheFile;
      if (cache.version !== 1) throw new Error('Unsupported cache version');
      if (Date.now() - cache.fetchedAt > CACHE_MAX_AGE_MS) {
        this.lastError = 'Cached vendor database is older than 30 days';
        return this.status;
      }

      this.m24 = new Map(Object.entries(cache.m24));
      this.m28 = new Map(Object.entries(cache.m28));
      this.m36 = new Map(Object.entries(cache.m36));
      this.fetchedAt = cache.fetchedAt;
      this.source = 'cache';
      this.lastError = undefined;
    } catch {
      // No cache yet, or it is unreadable - stay on the bundled table.
    }
    return this.status;
  }

  /** Downloads and caches the full registry. Only called on explicit request. */
  async refresh(timeoutMs = 30000): Promise<VendorDbStatus> {
    try {
      const response = await fetch(MANUF_URL, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'LANMediaScout/1.0' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const text = await response.text();
      const { m24, m28, m36 } = parseManuf(text);
      if (m24.size === 0) throw new Error('Downloaded database was empty');

      this.m24 = m24;
      this.m28 = m28;
      this.m36 = m36;
      this.fetchedAt = Date.now();
      this.source = 'network';
      this.lastError = undefined;

      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(
        this.cachePath,
        JSON.stringify({
          version: 1,
          fetchedAt: this.fetchedAt,
          m24: Object.fromEntries(m24),
          m28: Object.fromEntries(m28),
          m36: Object.fromEntries(m36),
        } satisfies CacheFile),
        'utf8',
      );
    } catch (error) {
      this.lastError = (error as Error).message;
    }
    return this.status;
  }

  /**
   * Longest-prefix-first lookup: a 36-bit MA-S assignment is more specific
   * than the 24-bit block it sits inside, so it must win.
   */
  lookup(mac?: string): VendorMatch | undefined {
    const bundled = lookupVendor(mac);
    if (!mac) return bundled;

    const raw = normalizeMac(mac);
    if (raw.length !== 12) return bundled;

    // A randomised MAC belongs to no vendor; the bundled table already says so.
    if (bundled?.randomized) return bundled;

    const hit =
      this.m36.get(raw.slice(0, 9)) ?? this.m28.get(raw.slice(0, 7)) ?? this.m24.get(raw.slice(0, 6));

    if (hit) return { vendor: tidyVendor(hit), randomized: false };
    return bundled;
  }
}

/**
 * Parses Wireshark's `manuf` format:
 *   `00:00:0C<tab>Cisco<tab>Cisco Systems, Inc`
 *   `00:1B:C5:00:00:00/36<tab>Openrb<tab>Openrb.com`
 * Comment lines start with `#`. The long name is preferred; the short name is
 * the fallback for the handful of entries that only have one column.
 */
function parseManuf(text: string): {
  m24: Map<string, string>;
  m28: Map<string, string>;
  m36: Map<string, string>;
} {
  const m24 = new Map<string, string>();
  const m28 = new Map<string, string>();
  const m36 = new Map<string, string>();

  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;

    const columns = line.split('\t').map((column) => column.trim()).filter(Boolean);
    if (columns.length < 2) continue;

    const [prefixField, shortName, longName] = columns;
    const vendor = longName || shortName;
    if (!vendor) continue;

    const [addressPart, bitsPart] = prefixField.split('/');
    const hex = addressPart.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    const bits = bitsPart ? Number(bitsPart) : 24;

    // Map bit length to the number of leading hex nibbles it covers.
    if (bits === 24 && hex.length >= 6) m24.set(hex.slice(0, 6), vendor);
    else if (bits === 28 && hex.length >= 7) m28.set(hex.slice(0, 7), vendor);
    else if (bits === 36 && hex.length >= 9) m36.set(hex.slice(0, 9), vendor);
    else if (hex.length >= 6) m24.set(hex.slice(0, 6), vendor);
  }

  return { m24, m28, m36 };
}
