import type { DeviceCategory } from '../../shared/types';
import { mapPool, probeTcp } from './net';

export interface PortProfile {
  port: number;
  label: string;
  category?: DeviceCategory;
  /** How strongly an open port implies `category`, 0-1. */
  weight?: number;
  /**
   * Ports that carry the same piece of evidence. Google Cast listens on both
   * 8008 and 8009, and SMB on both 139 and 445; counting each separately would
   * let one fact outvote two independent ones. The classifier keeps only the
   * strongest signal per group.
   */
  group?: string;
}

/**
 * The ports worth spending a connect attempt on. Chosen for identification
 * value rather than coverage - this is a device inventory tool, not a port
 * scanner, so there is no point walking 65k ports per host.
 */
export const PORT_PROFILES: PortProfile[] = [
  { port: 80, label: 'HTTP', weight: 0.05, group: 'web' },
  { port: 443, label: 'HTTPS', weight: 0.05, group: 'web' },
  { port: 22, label: 'SSH', category: 'computer', weight: 0.3 },
  { port: 23, label: 'Telnet', category: 'iot', weight: 0.2 },
  { port: 53, label: 'DNS', category: 'router', weight: 0.5 },
  { port: 139, label: 'NetBIOS Session', category: 'computer', weight: 0.35, group: 'smb' },
  { port: 445, label: 'SMB File Sharing', category: 'computer', weight: 0.4, group: 'smb' },
  { port: 548, label: 'AFP (Apple File Sharing)', category: 'nas', weight: 0.5 },
  { port: 554, label: 'RTSP Stream', category: 'camera', weight: 0.4 },
  { port: 631, label: 'IPP Printing', category: 'printer', weight: 0.85, group: 'print' },
  { port: 1400, label: 'Sonos Control', category: 'speaker', weight: 0.9 },
  { port: 1883, label: 'MQTT', category: 'iot', weight: 0.6 },
  { port: 2049, label: 'NFS', category: 'nas', weight: 0.6 },
  { port: 2869, label: 'UPnP Events (Windows)', weight: 0.2 },
  { port: 3000, label: 'HTTP (dev / app)', weight: 0.05, group: 'web' },
  { port: 3389, label: 'Remote Desktop', category: 'computer', weight: 0.7 },
  { port: 3689, label: 'DAAP (iTunes / Music)', category: 'media-server', weight: 0.6 },
  { port: 5000, label: 'UPnP / Synology DSM', weight: 0.2, group: 'synology' },
  { port: 5001, label: 'Synology DSM (TLS)', category: 'nas', weight: 0.6, group: 'synology' },
  { port: 5009, label: 'AirPort Admin', category: 'router', weight: 0.6 },
  { port: 5357, label: 'WSD (Windows Discovery)', category: 'computer', weight: 0.6 },
  { port: 5555, label: 'ADB (Android Debug)', category: 'tv', weight: 0.5 },
  { port: 6466, label: 'Android TV Remote', category: 'tv', weight: 0.9 },
  { port: 7000, label: 'AirPlay', category: 'tv', weight: 0.5, group: 'airplay' },
  { port: 7100, label: 'AirPlay (legacy)', category: 'speaker', weight: 0.4, group: 'airplay' },
  { port: 8008, label: 'Google Cast (HTTP)', category: 'streaming-stick', weight: 0.7, group: 'cast' },
  { port: 8009, label: 'Google Cast (TLS)', category: 'streaming-stick', weight: 0.8, group: 'cast' },
  { port: 8060, label: 'Roku ECP', category: 'streaming-stick', weight: 0.95 },
  { port: 8080, label: 'HTTP Alt', weight: 0.05, group: 'web' },
  { port: 8096, label: 'Jellyfin / Emby', category: 'media-server', weight: 0.9 },
  { port: 8123, label: 'Home Assistant', category: 'iot', weight: 0.85 },
  { port: 8200, label: 'MiniDLNA', category: 'media-server', weight: 0.9 },
  { port: 8443, label: 'HTTPS Alt', weight: 0.05, group: 'web' },
  { port: 8888, label: 'HTTP Alt', weight: 0.05, group: 'web' },
  { port: 9000, label: 'HTTP / Media (Twonky)', weight: 0.2, group: 'web' },
  { port: 9080, label: 'UPnP / WebOS', category: 'tv', weight: 0.4 },
  { port: 9090, label: 'HTTP Admin', weight: 0.1, group: 'web' },
  { port: 9100, label: 'JetDirect Printing', category: 'printer', weight: 0.85, group: 'print' },
  { port: 9197, label: 'Samsung TV (DIAL)', category: 'tv', weight: 0.9 },
  { port: 10000, label: 'Webmin / NDMP', weight: 0.1, group: 'web' },
  { port: 32400, label: 'Plex Media Server', category: 'media-server', weight: 0.98 },
  { port: 49152, label: 'UPnP (dynamic)', weight: 0.1 },
  { port: 62078, label: 'iOS lockdownd (iPhone / iPad)', category: 'phone', weight: 0.95 },
];

/** Ports probed first when we only want a quick "is anything there?" answer. */
const LIVENESS_PORTS = [80, 443, 8080, 22, 445, 8009, 62078];

export const portLabel = (port: number): string =>
  PORT_PROFILES.find((p) => p.port === port)?.label ?? `Port ${port}`;

export interface PortScanResult {
  ip: string;
  openPorts: number[];
  latencyMs?: number;
  /** True when the host answered anything at all, including a refusal. */
  alive: boolean;
}

/**
 * Connect-scans one host across `PORT_PROFILES`.
 *
 * A refused connection still proves the host is up, so it counts towards
 * `alive` without being reported as an open port.
 */
export async function scanHost(
  ip: string,
  options: { timeoutMs: number; concurrency: number; ports?: number[]; signal?: { aborted: boolean } },
): Promise<PortScanResult> {
  const ports = options.ports ?? PORT_PROFILES.map((p) => p.port);
  const openPorts: number[] = [];
  let alive = false;
  let latencyMs: number | undefined;

  await mapPool(
    ports,
    options.concurrency,
    async (port) => {
      if (options.signal?.aborted) return;
      const result = await probeTcp(ip, port, options.timeoutMs);
      if (result.open) {
        openPorts.push(port);
        alive = true;
        if (latencyMs === undefined || result.latencyMs < latencyMs) latencyMs = result.latencyMs;
      } else if (result.refused) {
        alive = true;
      }
    },
    undefined,
    options.signal,
  );

  return { ip, openPorts: openPorts.sort((a, b) => a - b), latencyMs, alive };
}

/** Cheap up/down check used to confirm hosts that only appeared in the ARP cache. */
export async function checkAlive(
  ip: string,
  timeoutMs: number,
): Promise<{ alive: boolean; latencyMs?: number }> {
  const results = await Promise.all(
    LIVENESS_PORTS.map((port) => probeTcp(ip, port, timeoutMs)),
  );
  const open = results.filter((r) => r.open);
  const alive = results.some((r) => r.open || r.refused);
  return {
    alive,
    latencyMs: open.length > 0 ? Math.min(...open.map((r) => r.latencyMs)) : undefined,
  };
}
