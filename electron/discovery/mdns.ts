import { Bonjour, type Browser, type Service } from 'bonjour-service';
import type { DeviceCategory } from '../../shared/types';
import { delay, isIpv4 } from './net';

export interface MdnsHit {
  /** IPv4 address the service resolved to. */
  ip: string;
  /** Instance name, e.g. "Living Room TV". */
  name: string;
  /** Service type without underscores, e.g. "googlecast". */
  type: string;
  protocol: 'tcp' | 'udp';
  fqdn: string;
  /** Hostname from the SRV record, e.g. "living-room.local". */
  host?: string;
  port: number;
  txt: Record<string, string>;
}

interface ServiceProfile {
  label: string;
  category?: DeviceCategory;
  /** How strongly this service implies `category`, 0-1. */
  weight?: number;
}

/**
 * What each advertised service type tells us. Types absent from this map are
 * still reported - they just carry no classification signal.
 */
export const MDNS_PROFILES: Record<string, ServiceProfile> = {
  googlecast: { label: 'Google Cast', category: 'streaming-stick', weight: 0.7 },
  androidtvremote2: { label: 'Android TV Remote', category: 'tv', weight: 0.9 },
  airplay: { label: 'AirPlay', category: 'tv', weight: 0.6 },
  'airplay-p2p': { label: 'AirPlay P2P', weight: 0.3 },
  raop: { label: 'AirPlay Audio (RAOP)', category: 'speaker', weight: 0.6 },
  'spotify-connect': { label: 'Spotify Connect', category: 'speaker', weight: 0.5 },
  sonos: { label: 'Sonos', category: 'speaker', weight: 0.95 },
  'sonosapi-radio': { label: 'Sonos Radio', category: 'speaker', weight: 0.9 },
  hap: { label: 'HomeKit Accessory', category: 'iot', weight: 0.6 },
  homekit: { label: 'HomeKit', category: 'iot', weight: 0.6 },
  'companion-link': { label: 'Apple Continuity', weight: 0.2 },
  rdlink: { label: 'Apple Remote Desktop Link', weight: 0.2 },
  'touch-able': { label: 'Apple TV Remote', category: 'tv', weight: 0.8 },
  'appletv-v2': { label: 'Apple TV', category: 'tv', weight: 0.95 },
  mediaremotetv: { label: 'Apple TV Media Remote', category: 'tv', weight: 0.9 },
  'device-info': { label: 'Device Info', weight: 0.1 },
  'apple-mobdev2': { label: 'Apple Mobile Device (Wi-Fi sync)', category: 'phone', weight: 0.9 },
  daap: { label: 'DAAP Music Library', category: 'media-server', weight: 0.6 },
  dacp: { label: 'iTunes Remote Control', weight: 0.3 },
  plexmediasvr: { label: 'Plex Media Server', category: 'media-server', weight: 0.98 },
  jellyfin: { label: 'Jellyfin', category: 'media-server', weight: 0.98 },
  emby: { label: 'Emby', category: 'media-server', weight: 0.98 },
  kodi: { label: 'Kodi', category: 'media-server', weight: 0.8 },
  xbmc: { label: 'Kodi / XBMC', category: 'media-server', weight: 0.8 },
  nvstream: { label: 'NVIDIA GameStream', category: 'game-console', weight: 0.6 },
  'amzn-wplay': { label: 'Amazon Fire TV', category: 'streaming-stick', weight: 0.9 },
  roku: { label: 'Roku', category: 'streaming-stick', weight: 0.95 },
  'roku-rcp': { label: 'Roku Control Protocol', category: 'streaming-stick', weight: 0.95 },
  smb: { label: 'SMB File Sharing', category: 'computer', weight: 0.4 },
  afpovertcp: { label: 'Apple File Sharing', category: 'computer', weight: 0.5 },
  nfs: { label: 'NFS Share', category: 'nas', weight: 0.6 },
  webdav: { label: 'WebDAV', category: 'nas', weight: 0.4 },
  adisk: { label: 'Time Machine / Time Capsule', category: 'nas', weight: 0.8 },
  workstation: { label: 'Workstation', category: 'computer', weight: 0.7 },
  ssh: { label: 'SSH', category: 'computer', weight: 0.4 },
  'sftp-ssh': { label: 'SFTP', category: 'computer', weight: 0.4 },
  rfb: { label: 'VNC / Screen Sharing', category: 'computer', weight: 0.6 },
  'rdp': { label: 'Remote Desktop', category: 'computer', weight: 0.6 },
  ipp: { label: 'Printer (IPP)', category: 'printer', weight: 0.95 },
  ipps: { label: 'Printer (IPPS)', category: 'printer', weight: 0.95 },
  printer: { label: 'Printer (LPD)', category: 'printer', weight: 0.95 },
  pdl_datastream: { label: 'Printer (JetDirect)', category: 'printer', weight: 0.9 },
  scanner: { label: 'Scanner', category: 'printer', weight: 0.8 },
  uscan: { label: 'AirScan', category: 'printer', weight: 0.85 },
  uscans: { label: 'AirScan (secure)', category: 'printer', weight: 0.85 },
  http: { label: 'Web Interface', weight: 0.1 },
  https: { label: 'Web Interface (TLS)', weight: 0.1 },
  rtsp: { label: 'RTSP Stream', category: 'camera', weight: 0.5 },
  axis_video: { label: 'Axis Camera', category: 'camera', weight: 0.95 },
  dahua: { label: 'Dahua Camera', category: 'camera', weight: 0.9 },
  hue: { label: 'Philips Hue Bridge', category: 'iot', weight: 0.95 },
  miio: { label: 'Xiaomi Mi Home', category: 'iot', weight: 0.85 },
  esphomelib: { label: 'ESPHome', category: 'iot', weight: 0.95 },
  'home-assistant': { label: 'Home Assistant', category: 'iot', weight: 0.9 },
  matter: { label: 'Matter', category: 'iot', weight: 0.7 },
  matterc: { label: 'Matter Commissioning', category: 'iot', weight: 0.7 },
  wled: { label: 'WLED', category: 'iot', weight: 0.95 },
  tivo_videostream: { label: 'TiVo', category: 'media-server', weight: 0.8 },
  dosvc: { label: 'Windows Delivery Optimization', category: 'computer', weight: 0.7 },
  'ewelink': { label: 'eWeLink', category: 'iot', weight: 0.8 },
  androidtvremote: { label: 'Android TV Remote', category: 'tv', weight: 0.9 },
  viziocast: { label: 'Vizio SmartCast', category: 'tv', weight: 0.95 },
  bravia: { label: 'Sony Bravia', category: 'tv', weight: 0.95 },
  lg: { label: 'LG Device', category: 'tv', weight: 0.6 },
  samsungmsf: { label: 'Samsung Multiscreen', category: 'tv', weight: 0.95 },
};

/** High-value types we query directly, on top of the DNS-SD meta-query. */
const EXPLICIT_TYPES: Array<{ type: string; protocol: 'tcp' | 'udp' }> = [
  { type: 'googlecast', protocol: 'tcp' },
  { type: 'airplay', protocol: 'tcp' },
  { type: 'raop', protocol: 'tcp' },
  { type: 'spotify-connect', protocol: 'tcp' },
  { type: 'sonos', protocol: 'tcp' },
  { type: 'device-info', protocol: 'tcp' },
  { type: 'companion-link', protocol: 'tcp' },
  { type: 'apple-mobdev2', protocol: 'tcp' },
  { type: 'touch-able', protocol: 'tcp' },
  { type: 'mediaremotetv', protocol: 'tcp' },
  { type: 'androidtvremote2', protocol: 'tcp' },
  { type: 'plexmediasvr', protocol: 'tcp' },
  { type: 'jellyfin', protocol: 'tcp' },
  { type: 'emby', protocol: 'tcp' },
  { type: 'kodi', protocol: 'tcp' },
  { type: 'amzn-wplay', protocol: 'tcp' },
  { type: 'workstation', protocol: 'tcp' },
  { type: 'smb', protocol: 'tcp' },
  { type: 'afpovertcp', protocol: 'tcp' },
  { type: 'adisk', protocol: 'tcp' },
  { type: 'ssh', protocol: 'tcp' },
  { type: 'rfb', protocol: 'tcp' },
  { type: 'ipp', protocol: 'tcp' },
  { type: 'printer', protocol: 'tcp' },
  { type: 'uscan', protocol: 'tcp' },
  { type: 'http', protocol: 'tcp' },
  { type: 'https', protocol: 'tcp' },
  { type: 'hap', protocol: 'tcp' },
  { type: 'esphomelib', protocol: 'tcp' },
  { type: 'home-assistant', protocol: 'tcp' },
  { type: 'hue', protocol: 'tcp' },
  { type: 'miio', protocol: 'udp' },
  { type: 'nvstream', protocol: 'tcp' },
  { type: 'rtsp', protocol: 'tcp' },
];

function normalizeTxt(txt: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!txt || typeof txt !== 'object') return result;
  for (const [key, value] of Object.entries(txt as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
    // Cast keys/values are occasionally huge blobs; keep the table readable.
    result[key] = text.length > 256 ? `${text.slice(0, 253)}...` : text;
  }
  return result;
}

function toHit(service: Service): MdnsHit | undefined {
  const ipv4 = (service.addresses ?? []).find((addr) => isIpv4(addr)) ?? service.referer?.address;
  if (!ipv4 || !isIpv4(ipv4)) return undefined;

  return {
    ip: ipv4,
    name: service.name || service.host || ipv4,
    type: service.type,
    protocol: service.protocol ?? 'tcp',
    fqdn: service.fqdn,
    host: service.host,
    port: service.port,
    txt: normalizeTxt(service.txt),
  };
}

/**
 * Browses mDNS for `timeoutMs`, combining the DNS-SD meta-query (which
 * enumerates whatever service types the network happens to advertise) with
 * direct queries for the types we care most about, since some devices only
 * answer when asked by name.
 */
export async function discoverMdns(options: {
  timeoutMs: number;
  onHit?: (hit: MdnsHit) => void;
  signal?: { aborted: boolean };
}): Promise<MdnsHit[]> {
  const hits = new Map<string, MdnsHit>();
  let bonjour: Bonjour;

  try {
    bonjour = new Bonjour(undefined, () => undefined);
  } catch {
    return []; // No usable multicast interface.
  }

  const browsers: Browser[] = [];

  const collect = (service: Service): void => {
    const hit = toHit(service);
    if (!hit) return;
    const key = `${hit.ip}|${hit.fqdn}`;
    if (hits.has(key)) return;
    hits.set(key, hit);
    options.onHit?.(hit);
  };

  try {
    // Meta-query: enumerate every service type advertised on this network.
    browsers.push(bonjour.find(null, collect));

    for (const { type, protocol } of EXPLICIT_TYPES) {
      browsers.push(bonjour.find({ type, protocol }, collect));
    }

    const started = Date.now();
    while (Date.now() - started < options.timeoutMs) {
      if (options.signal?.aborted) break;
      await delay(150);
      // Re-issue queries midway; the first round often lands while devices are
      // still rate-limiting their multicast replies.
      if (Date.now() - started > options.timeoutMs / 2 && Date.now() - started < options.timeoutMs / 2 + 200) {
        for (const browser of browsers) {
          try {
            browser.update();
          } catch {
            // A browser can be torn down underneath us; nothing to do.
          }
        }
      }
    }
  } finally {
    for (const browser of browsers) {
      try {
        browser.stop();
      } catch {
        // Already stopped.
      }
    }
    try {
      bonjour.destroy();
    } catch {
      // Socket already closed.
    }
  }

  return [...hits.values()];
}

export function mdnsProfile(type: string): ServiceProfile {
  return MDNS_PROFILES[type] ?? { label: `_${type}`, weight: 0 };
}
