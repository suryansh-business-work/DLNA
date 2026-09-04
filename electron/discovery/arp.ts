import { exec } from 'node:child_process';
import dgram from 'node:dgram';
import { promisify } from 'node:util';
import { delay, expandCidr, isIpv4, mapPool } from './net';
import { formatMac, isUsableMac, normalizeMac } from './oui';

const execAsync = promisify(exec);

export interface ArpEntry {
  ip: string;
  mac: string;
}

/**
 * Matches an IPv4 address and a MAC on the same line. Deliberately format
 * agnostic so it handles Windows (`192.168.1.1  ac-91-9b-1d-2e-3f  dynamic`),
 * BSD/macOS (`? (192.168.1.1) at ac:91:9b:... on en0`) and Linux
 * (`192.168.1.1  ether  ac:91:9b:...  C  wlan0`) without three parsers.
 */
const ARP_LINE = /(\d{1,3}(?:\.\d{1,3}){3})\D+([0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5})/;

/** IPv4 multicast (224–239.x) and broadcast are not hosts we can talk to. */
function isRoutableHost(ip: string, mac: string): boolean {
  if (!isIpv4(ip)) return false;
  const first = Number(ip.split('.')[0]);
  if (first >= 224) return false;
  if (ip.endsWith('.255') || ip === '0.0.0.0') return false;

  const raw = normalizeMac(mac);
  if (!isUsableMac(raw)) return false;
  // 01:00:5e:… is the IPv4 multicast MAC range, 33:33:… is IPv6 multicast.
  if (raw.startsWith('01005E') || raw.startsWith('3333')) return false;
  return true;
}

/** Reads the OS ARP/neighbour cache. */
export async function readArpTable(): Promise<ArpEntry[]> {
  const commands =
    process.platform === 'win32'
      ? ['arp -a']
      : process.platform === 'darwin'
        ? ['arp -an']
        : ['ip neigh show', 'arp -an'];

  const seen = new Map<string, string>();

  for (const command of commands) {
    let stdout: string;
    try {
      ({ stdout } = await execAsync(command, {
        timeout: 8000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      }));
    } catch {
      continue; // Try the next command form.
    }

    for (const line of stdout.split(/\r?\n/)) {
      const match = ARP_LINE.exec(line);
      if (!match) continue;
      const [, ip, mac] = match;
      if (!isRoutableHost(ip, mac)) continue;
      if (!seen.has(ip)) seen.set(ip, formatMac(mac));
    }

    if (seen.size > 0) break; // First command that produced entries wins.
  }

  return [...seen].map(([ip, mac]) => ({ ip, mac }));
}

/**
 * Nudges every host in the subnet so the OS populates its ARP cache.
 *
 * Sending a single UDP datagram to the discard port makes the kernel ARP for
 * the destination, which is far cheaper than spawning 254 `ping` processes and
 * is not blocked by the ICMP-dropping firewalls that phones and TVs ship with.
 * We never expect a reply - the ARP entry left behind is the whole point.
 */
export async function arpSweep(
  cidr: string,
  options: { concurrency: number; onProgress?: (done: number, total: number) => void; signal?: { aborted: boolean } },
): Promise<void> {
  const hosts = expandCidr(cidr, 4096);
  if (hosts.length === 0) return;

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  // Unreachable hosts trigger ICMP port-unreachable, which surfaces as a
  // socket error on Windows. That is the expected case, not a failure.
  socket.on('error', () => undefined);

  await new Promise<void>((resolve) => {
    socket.bind(0, () => resolve());
  });

  const payload = Buffer.alloc(1);
  let sent = 0;

  try {
    await mapPool(
      hosts,
      Math.max(16, options.concurrency),
      (ip) =>
        new Promise<void>((resolve) => {
          // Port 9 = discard. Port 137 = NetBIOS name service, which many
          // Windows and NAS boxes actually answer.
          socket.send(payload, 9, ip, () => {
            socket.send(payload, 137, ip, () => resolve());
          });
        }),
      (done, total) => {
        sent = done;
        options.onProgress?.(done, total);
      },
      options.signal,
    );
  } finally {
    void sent;
    socket.close();
  }

  // Give the stack a moment to resolve the ARP replies before we read the table.
  await delay(700);
}

/** Default-gateway IP for the active route, or `undefined` if it can't be read. */
export async function findGateway(): Promise<string | undefined> {
  const command =
    process.platform === 'win32'
      ? 'route print -4'
      : process.platform === 'darwin'
        ? 'netstat -rn -f inet'
        : 'ip route show default';

  try {
    const { stdout } = await execAsync(command, {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });

    if (process.platform === 'linux') {
      const match = /default\s+via\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(stdout);
      return match?.[1];
    }

    if (process.platform === 'darwin') {
      const match = /^default\s+(\d{1,3}(?:\.\d{1,3}){3})/m.exec(stdout);
      return match?.[1];
    }

    // Windows: the persistent-routes table lists `0.0.0.0  0.0.0.0  <gw>  <if>`.
    for (const line of stdout.split(/\r?\n/)) {
      const match =
        /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(
          line,
        );
      if (match && match[1] !== '0.0.0.0') return match[1];
    }
    return undefined;
  } catch {
    return undefined;
  }
}
