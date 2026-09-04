import { networkInterfaces } from 'node:os';
import net from 'node:net';
import dns from 'node:dns/promises';
import type { NetworkInterfaceInfo } from '../../shared/types';
import { formatMac, isUsableMac } from './oui';

/* -------------------------------------------------------------------------- */
/* IPv4 helpers                                                               */
/* -------------------------------------------------------------------------- */

export function ipToInt(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) return 0;
  return (
    ((Number(parts[0]) << 24) >>> 0) +
    (Number(parts[1]) << 16) +
    (Number(parts[2]) << 8) +
    Number(parts[3])
  ) >>> 0;
}

export function intToIp(value: number): string {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join('.');
}

export function isIpv4(ip: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every((o) => Number(o) <= 255);
}

export function netmaskToPrefix(netmask: string): number {
  const int = ipToInt(netmask);
  let bits = 0;
  for (let i = 31; i >= 0; i--) {
    if ((int >>> i) & 1) bits++;
    else break;
  }
  return bits;
}

export function prefixToNetmask(prefix: number): string {
  return intToIp(prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
}

/**
 * Expands a CIDR into its usable host addresses (network and broadcast
 * excluded). Refuses anything wider than /16 so a mistyped mask cannot queue
 * millions of probes.
 */
export function expandCidr(cidr: string, maxHosts = 65534): string[] {
  const [base, prefixRaw] = cidr.split('/');
  const prefix = Number(prefixRaw);
  if (!isIpv4(base) || !Number.isInteger(prefix) || prefix < 8 || prefix > 32) return [];

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipToInt(base) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;

  if (prefix >= 31) return [intToIp(network)];

  const hosts: string[] = [];
  for (let i = network + 1; i < broadcast && hosts.length < maxHosts; i++) {
    hosts.push(intToIp(i >>> 0));
  }
  return hosts;
}

export function cidrHostCount(prefix: number): number {
  if (prefix >= 31) return 1;
  return Math.max(0, 2 ** (32 - prefix) - 2);
}

export function isInCidr(ip: string, cidr: string): boolean {
  const [base, prefixRaw] = cidr.split('/');
  const prefix = Number(prefixRaw);
  if (!isIpv4(ip) || !isIpv4(base) || Number.isNaN(prefix)) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(base) & mask) >>> 0);
}

/* -------------------------------------------------------------------------- */
/* Local interfaces                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Every up, non-loopback IPv4 interface, widest subnet first. Link-local
 * (169.254/16) addresses are dropped - they mean DHCP failed and there is
 * nothing to find there.
 */
export function listInterfaces(): NetworkInterfaceInfo[] {
  const result: NetworkInterfaceInfo[] = [];

  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      const family = String(addr.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;

      const prefix = netmaskToPrefix(addr.netmask);
      const [b0, b1, b2, b3] = addr.address.split('.');
      result.push({
        name,
        address: addr.address,
        netmask: addr.netmask,
        mac: isUsableMac(addr.mac) ? formatMac(addr.mac) : '',
        cidr:
          addr.cidr ??
          `${(Number(b0) & Number(addr.netmask.split('.')[0]))}.${
            Number(b1) & Number(addr.netmask.split('.')[1])
          }.${Number(b2) & Number(addr.netmask.split('.')[2])}.${
            Number(b3) & Number(addr.netmask.split('.')[3])
          }/${prefix}`,
        hostCount: cidrHostCount(prefix),
      });
    }
  }

  // Prefer real LAN subnets over virtual adapters (Hyper-V, WSL, VirtualBox),
  // which are usually /24s on 172.x with no other hosts on them.
  return result.sort((a, b) => {
    const score = (i: NetworkInterfaceInfo) =>
      (i.address.startsWith('192.168.') ? 2 : 0) +
      (i.address.startsWith('10.') ? 1 : 0) +
      (/virtual|vethernet|wsl|vmware|vbox|loopback|docker/i.test(i.name) ? -3 : 0);
    return score(b) - score(a);
  });
}

/** Network address of the CIDR an interface sits on, e.g. `192.168.1.0/24`. */
export function interfaceSubnet(iface: NetworkInterfaceInfo): string {
  const prefix = netmaskToPrefix(iface.netmask);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return `${intToIp((ipToInt(iface.address) & mask) >>> 0)}/${prefix}`;
}

/* -------------------------------------------------------------------------- */
/* Probing                                                                    */
/* -------------------------------------------------------------------------- */

export interface TcpProbeResult {
  open: boolean;
  latencyMs: number;
}

/**
 * A plain TCP connect probe. `ECONNREFUSED` means the host is alive but the
 * port is closed, which is still useful liveness information, so it is
 * reported separately from a timeout.
 */
export function probeTcp(
  ip: string,
  port: number,
  timeoutMs: number,
): Promise<TcpProbeResult & { refused: boolean }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (open: boolean, refused: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ open, refused, latencyMs: Date.now() - started });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, false));
    socket.once('timeout', () => finish(false, false));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      finish(false, err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET');
    });

    try {
      socket.connect(port, ip);
    } catch {
      finish(false, false);
    }
  });
}

/** Reverse DNS, best effort. Many LANs have no PTR records at all. */
export async function reverseDns(ip: string, timeoutMs = 1500): Promise<string | undefined> {
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise<string[]>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs),
      ),
    ]);
    const name = names?.[0];
    if (!name) return undefined;
    // Strip the trailing search domain routers love to append.
    return name.replace(/\.(local|lan|home|localdomain|fritz\.box)\.?$/i, '');
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Concurrency                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Runs `worker` over `items` with a bounded number in flight, reporting
 * progress after each completion. Rejections are swallowed - a failed probe is
 * a normal outcome here, not an error worth aborting the sweep for.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
  signal?: { aborted: boolean },
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let done = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      if (signal?.aborted) return;
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch {
        // Ignored on purpose: see doc comment.
      }
      done++;
      onProgress?.(done, items.length);
    }
  });

  await Promise.all(runners);
  return results;
}

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
