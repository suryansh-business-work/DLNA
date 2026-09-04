import dgram from 'node:dgram';
import { XMLParser } from 'fast-xml-parser';
import { delay } from './net';

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

/**
 * Search targets, broad to narrow. `ssdp:all` alone is enough on a compliant
 * network, but plenty of TVs only answer to the specific device type they
 * implement, so we ask for the interesting ones by name too.
 */
const SEARCH_TARGETS = [
  'ssdp:all',
  'upnp:rootdevice',
  'urn:schemas-upnp-org:device:MediaServer:1',
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:dial-multiscreen-org:service:dial:1',
  'roku:ecp',
];

export interface SsdpResponse {
  ip: string;
  location?: string;
  st?: string;
  usn?: string;
  server?: string;
  /** Present on Roku and some TVs; a stable per-device id. */
  extra: Record<string, string>;
}

export interface UpnpIcon {
  url: string;
  mimetype?: string;
  width?: number;
}

/** A UPnP service with the absolute URLs needed to actually control it. */
export interface UpnpService {
  serviceType: string;
  serviceId?: string;
  /** Absolute URL that SOAP actions are POSTed to. */
  controlUrl?: string;
  eventSubUrl?: string;
}

export interface UpnpDeviceDescription {
  ip: string;
  location: string;
  friendlyName?: string;
  manufacturer?: string;
  modelName?: string;
  modelNumber?: string;
  modelDescription?: string;
  serialNumber?: string;
  udn?: string;
  deviceType?: string;
  presentationUrl?: string;
  serviceTypes: string[];
  /** Every service on the root device and any embedded devices, flattened. */
  services: UpnpService[];
  icons: UpnpIcon[];
}

function parseHeaders(message: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of message.split(/\r?\n/).slice(1)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

/**
 * Sends M-SEARCH probes and collects both the unicast replies and any NOTIFY
 * announcements that arrive while we are listening.
 *
 * Two sockets are used: an ephemeral one for M-SEARCH (replies come back to the
 * source port) and, when possible, one bound to 1900 joined to the multicast
 * group for passive NOTIFY traffic. Port 1900 is frequently already held by
 * another process, so failing to bind it is downgraded to "no passive
 * listening" rather than treated as an error.
 */
export async function discoverSsdp(options: {
  timeoutMs: number;
  interfaceAddress?: string;
  onResponse?: (response: SsdpResponse) => void;
  signal?: { aborted: boolean };
}): Promise<SsdpResponse[]> {
  const { timeoutMs, interfaceAddress, onResponse } = options;
  const found = new Map<string, SsdpResponse>();

  const record = (message: Buffer, remoteIp: string): void => {
    const text = message.toString('utf8');
    if (!/^(HTTP\/1\.1 200|NOTIFY|M-SEARCH)/i.test(text)) return;
    if (/^M-SEARCH/i.test(text)) return; // Our own probe echoed back.

    const headers = parseHeaders(text);
    // `byebye` means the device is announcing it is leaving the network.
    if (headers.nts === 'ssdp:byebye') return;

    const key = headers.usn || headers.location || remoteIp;
    const existing = found.get(key);

    const response: SsdpResponse = {
      ip: remoteIp,
      location: headers.location ?? existing?.location,
      st: headers.st ?? headers.nt ?? existing?.st,
      usn: headers.usn ?? existing?.usn,
      server: headers.server ?? existing?.server,
      extra: { ...existing?.extra },
    };

    for (const [name, value] of Object.entries(headers)) {
      if (['host', 'cache-control', 'date', 'ext', 'location', 'server', 'st', 'nt', 'nts', 'usn'].includes(name)) {
        continue;
      }
      response.extra[name] = value;
    }

    found.set(key, response);
    onResponse?.(response);
  };

  const searchSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  searchSocket.on('error', () => undefined);
  searchSocket.on('message', (msg, rinfo) => record(msg, rinfo.address));

  await new Promise<void>((resolve) => {
    searchSocket.bind(0, interfaceAddress, () => {
      try {
        searchSocket.setBroadcast(true);
        searchSocket.setMulticastTTL(4);
      } catch {
        // Not fatal - unicast M-SEARCH still works.
      }
      resolve();
    });
  });

  // Passive listener on the well-known port. Optional by design.
  let notifySocket: dgram.Socket | undefined;
  try {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', () => undefined);
    socket.on('message', (msg, rinfo) => record(msg, rinfo.address));
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(SSDP_PORT, () => {
        try {
          socket.addMembership(SSDP_ADDRESS, interfaceAddress);
        } catch {
          // Some adapters refuse the join; passive discovery just yields less.
        }
        resolve();
      });
    });
    notifySocket = socket;
  } catch {
    notifySocket = undefined;
  }

  const sendSearch = (st: string, mx: number): void => {
    const message = Buffer.from(
      [
        'M-SEARCH * HTTP/1.1',
        `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
        'MAN: "ssdp:discover"',
        `MX: ${mx}`,
        `ST: ${st}`,
        'USER-AGENT: Node/24 UPnP/1.1 LANMediaScout/1.0',
        '',
        '',
      ].join('\r\n'),
    );
    searchSocket.send(message, 0, message.length, SSDP_PORT, SSDP_ADDRESS, () => undefined);
  };

  // Two rounds: UDP multicast is lossy and devices stagger replies over MX
  // seconds, so a single burst reliably misses hosts.
  const mx = Math.max(1, Math.min(5, Math.floor(timeoutMs / 2000)));
  for (const st of SEARCH_TARGETS) sendSearch(st, mx);
  await delay(Math.min(1200, timeoutMs / 3));
  if (!options.signal?.aborted) {
    for (const st of SEARCH_TARGETS) sendSearch(st, mx);
  }

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (options.signal?.aborted) break;
    await delay(150);
  }

  searchSocket.close();
  notifySocket?.close();

  return [...found.values()];
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
});

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return firstString(value[0]);
  return undefined;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function absoluteUrl(base: string, path?: string): string | undefined {
  if (!path) return undefined;
  try {
    return new URL(path, base).toString();
  } catch {
    return undefined;
  }
}

/**
 * Fetches and parses a UPnP device description document. Returns `undefined`
 * for anything that is unreachable, times out, or is not parseable XML - all
 * routine on a network with half-asleep devices.
 */
export async function fetchDeviceDescription(
  location: string,
  timeoutMs = 4000,
): Promise<UpnpDeviceDescription | undefined> {
  let ip: string;
  try {
    ip = new URL(location).hostname;
  } catch {
    return undefined;
  }

  let xml: string;
  try {
    const response = await fetch(location, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'LANMediaScout/1.0', Accept: 'text/xml, application/xml, */*' },
    });
    if (!response.ok) return undefined;
    xml = await response.text();
  } catch {
    return undefined;
  }

  let root: Record<string, unknown>;
  try {
    root = xmlParser.parse(xml) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const rootNode = (root.root ?? root.Root ?? {}) as Record<string, unknown>;
  const device = (rootNode.device ?? {}) as Record<string, unknown>;
  if (Object.keys(device).length === 0) return undefined;

  // A MediaRenderer's AVTransport often lives on an embedded device rather than
  // the root, so walk the whole deviceList tree.
  const services = collectServices(device, location);

  const iconList = (device.iconList ?? {}) as Record<string, unknown>;
  const icons: UpnpIcon[] = [];
  for (const icon of asArray(iconList.icon as Record<string, unknown> | Record<string, unknown>[])) {
    const url = absoluteUrl(location, firstString(icon.url));
    if (!url) continue;
    icons.push({
      url,
      mimetype: firstString(icon.mimetype),
      width: Number(firstString(icon.width)) || undefined,
    });
  }
  // Largest icon first - device descriptions usually list them smallest first.
  icons.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));

  return {
    ip,
    location,
    friendlyName: firstString(device.friendlyName),
    manufacturer: firstString(device.manufacturer),
    modelName: firstString(device.modelName),
    modelNumber: firstString(device.modelNumber),
    modelDescription: firstString(device.modelDescription),
    serialNumber: firstString(device.serialNumber),
    udn: firstString(device.UDN),
    deviceType: firstString(device.deviceType),
    presentationUrl:
      absoluteUrl(location, firstString(device.presentationURL)) ??
      (firstString(device.presentationURL) ? undefined : `http://${ip}/`),
    serviceTypes: services.map((service) => service.serviceType),
    services,
    icons,
  };
}

/**
 * Flattens `serviceList` across the root device and every embedded device,
 * resolving each `controlURL` against the description's own location.
 */
function collectServices(
  device: Record<string, unknown>,
  location: string,
  depth = 0,
): UpnpService[] {
  if (depth > 4) return []; // Guard against a self-referential description.

  const result: UpnpService[] = [];

  const serviceList = (device.serviceList ?? {}) as Record<string, unknown>;
  for (const service of asArray(
    serviceList.service as Record<string, unknown> | Record<string, unknown>[],
  )) {
    const serviceType = firstString(service.serviceType);
    if (!serviceType) continue;
    result.push({
      serviceType,
      serviceId: firstString(service.serviceId),
      controlUrl: absoluteUrl(location, firstString(service.controlURL)),
      eventSubUrl: absoluteUrl(location, firstString(service.eventSubURL)),
    });
  }

  const deviceList = (device.deviceList ?? {}) as Record<string, unknown>;
  for (const child of asArray(
    deviceList.device as Record<string, unknown> | Record<string, unknown>[],
  )) {
    result.push(...collectServices(child, location, depth + 1));
  }

  return result;
}

/**
 * Short label for a `urn:schemas-upnp-org:device:MediaRenderer:1` style URN.
 * Split rather than matched, so a pathological URN cannot cause backtracking.
 */
export function shortenUrn(urn?: string): string | undefined {
  if (!urn) return undefined;
  if (urn === 'upnp:rootdevice') return 'UPnP Root Device';
  if (urn === 'ssdp:all') return 'UPnP';

  const parts = urn.split(':');
  const deviceIndex = parts.lastIndexOf('device');
  const kindIndex = deviceIndex >= 0 ? deviceIndex : parts.lastIndexOf('service');
  const name = kindIndex >= 0 ? parts[kindIndex + 1] : undefined;

  if (name && !/^\d+$/.test(name)) {
    // "MediaRenderer" -> "Media Renderer"
    return name.replace(/([a-z])([A-Z])/g, '$1 $2');
  }
  return urn.length > 48 ? `${urn.slice(0, 45)}...` : urn;
}
