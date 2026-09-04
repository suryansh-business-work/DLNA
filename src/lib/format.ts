import type { Device, DiscoverySource } from '@shared/types';

export const SOURCE_LABELS: Record<DiscoverySource, string> = {
  ssdp: 'UPnP / DLNA',
  mdns: 'Bonjour / mDNS',
  arp: 'ARP',
  portscan: 'Port probe',
  dns: 'Reverse DNS',
};

/** Sorts IPv4 addresses numerically rather than as strings. */
export function compareIp(a: string, b: string): number {
  const toParts = (ip: string) => ip.split('.').map(Number);
  const [a0, a1, a2, a3] = toParts(a);
  const [b0, b1, b2, b3] = toParts(b);
  return a0 - b0 || a1 - b1 || a2 - b2 || a3 - b3;
}

export function formatLatency(ms?: number): string {
  if (ms === undefined) return '—';
  if (ms < 1) return '<1 ms';
  return `${Math.round(ms)} ms`;
}

export function formatTimestamp(value?: number): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatDuration(from?: number, to?: number): string {
  if (!from || !to) return '—';
  const seconds = (to - from) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** Everything a search box should be able to match a device on. */
export function searchBlob(device: Device): string {
  return [
    device.name,
    device.ip,
    device.mac,
    device.hostname,
    device.vendor,
    device.manufacturer,
    device.model,
    device.category,
    ...device.services.map((service) => service.label),
    ...device.openPorts.map((port) => `${port.port} ${port.label}`),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export const relativeTime = (value?: number): string => {
  if (!value) return 'never';
  const seconds = Math.round((Date.now() - value) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};
