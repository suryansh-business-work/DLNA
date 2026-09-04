import { EventEmitter } from 'node:events';
import type {
  Device,
  DeviceCategory,
  DeviceService,
  DiscoverySource,
  NetworkInterfaceInfo,
  PlaybackCapability,
  ScanOptions,
  ScanPhase,
  ScanStatus,
} from '../../shared/types';
import { DEFAULT_SCAN_OPTIONS } from '../../shared/types';
import { arpSweep, findGateway, readArpTable } from './arp';
import { CATEGORY_LABELS, classify, type Signal } from './classify';
import { grabHttpBanner, type HttpBanner } from './http';
import { discoverMdns, mdnsProfile, type MdnsHit } from './mdns';
import {
  interfaceSubnet,
  isInCidr,
  isIpv4,
  listInterfaces,
  mapPool,
  reverseDns,
} from './net';
import { formatMac, isUsableMac, lookupVendor, type VendorMatch } from './oui';
import { portLabel, scanHost } from './ports';
import {
  discoverSsdp,
  fetchDeviceDescription,
  shortenUrn,
  type SsdpResponse,
  type UpnpDeviceDescription,
} from './ssdp';

/** Everything we have learned about one IP before it becomes a `Device`. */
interface Candidate {
  ip: string;
  mac?: string;
  hostname?: string;
  sources: Set<DiscoverySource>;
  ssdp: SsdpResponse[];
  upnp: UpnpDeviceDescription[];
  mdns: MdnsHit[];
  openPorts: number[];
  banner?: HttpBanner;
  latencyMs?: number;
  alive: boolean;
  firstSeen: number;
}

export interface DiscoveryEvents {
  devices: [Device[]];
  status: [ScanStatus];
}

/** Obvious machine identifiers: UUIDs, bare MACs, hex digests. */
const OPAQUE_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}|^[0-9A-F]{12}$|^[0-9a-f]{32}$/;

/**
 * True for names that are clearly generated rather than chosen by a person,
 * e.g. the `Mr2OVFM_Sjgng6yxEzSOGCY` tokens some AirPlay and Cast stacks
 * advertise.
 *
 * The entropy rule is deliberately conservative - it needs a long, space-free,
 * mixed-case string containing digits and several case transitions - so ordinary
 * names like "SuryanshsMacBookPro2" or "SWTV-22AE-FHD-DLNA" survive. A useless
 * name is worse than none, but discarding a real one is worse still.
 */
function looksOpaque(name: string): boolean {
  if (OPAQUE_ID.test(name)) return true;
  if (name.length < 20 || /\s/.test(name)) return false;
  if (!/[a-z]/.test(name) || !/[A-Z]/.test(name) || !/\d/.test(name)) return false;

  let transitions = 0;
  for (let i = 1; i < name.length; i++) {
    const previous = name[i - 1];
    const current = name[i];
    const previousLower = previous >= 'a' && previous <= 'z';
    const currentUpper = current >= 'A' && current <= 'Z';
    if (previousLower && currentUpper) transitions++;
  }
  return transitions / name.length > 0.15;
}

/** Service types whose instance name is rarely the device's real name. */
const WEAK_NAME_TYPES = new Set([
  'http',
  'https',
  'device-info',
  'apple-mobdev2',
  'companion-link',
  'rdlink',
  'dosvc',
  'sleep-proxy',
  'touch-able',
  'dacp',
  'matterc',
  'matter',
]);

function cleanInstanceName(raw: string, type: string): string | undefined {
  let name = raw.trim();
  // `_raop` instances look like "AABBCCDDEEFF@Living Room Speaker".
  const at = name.indexOf('@');
  if (at > 0 && /^[0-9A-Fa-f]{12}$/.test(name.slice(0, at))) name = name.slice(at + 1);
  // Some stacks escape spaces in the instance label.
  name = name.replace(/\\032/g, ' ').replace(/\\(\d{3})/g, (_, code) => String.fromCharCode(Number(code)));
  name = name.trim();

  if (!name) return undefined;
  if (looksOpaque(name)) return undefined;
  if (WEAK_NAME_TYPES.has(type) && !/[a-z]{3}/i.test(name)) return undefined;
  return name;
}

/** Picks the most human-friendly name available from the mDNS hits. */
function bestMdnsName(hits: MdnsHit[]): string | undefined {
  // Google Cast and Spotify publish the user-set name directly in TXT.
  for (const hit of hits) {
    const friendly = hit.txt.fn ?? hit.txt.n ?? hit.txt.CtlN ?? hit.txt.name;
    if (friendly && !looksOpaque(friendly)) return friendly.trim();
  }

  const scored = hits
    .map((hit) => {
      const name = cleanInstanceName(hit.name, hit.type);
      if (!name) return undefined;
      const weak = WEAK_NAME_TYPES.has(hit.type);
      return { name, score: (weak ? 0 : 2) + (mdnsProfile(hit.type).weight ?? 0) };
    })
    .filter((entry): entry is { name: string; score: number } => Boolean(entry))
    .sort((a, b) => b.score - a.score);

  return scored[0]?.name;
}

/**
 * Chooses the label shown in the device list, preferring names a human chose
 * over machine-generated ones, and falling back to a description of what the
 * device appears to be rather than leaving a bare IP address on screen.
 */
function pickName(input: {
  upnpName?: string;
  mdnsName?: string;
  hostname?: string;
  isGateway: boolean;
  isSelf: boolean;
  vendor?: string;
  category: DeviceCategory;
  confidence: number;
}): string {
  if (input.upnpName) return input.upnpName;
  if (input.mdnsName) return input.mdnsName;
  if (input.hostname) return titleCaseHostname(input.hostname);
  if (input.isSelf) return 'This Computer';
  if (input.isGateway) return 'Router / Gateway';

  const kind = input.category !== 'unknown' && input.confidence >= 0.3
    ? CATEGORY_LABELS[input.category]
    : undefined;

  if (input.vendor && kind) return `${input.vendor} ${kind}`;
  if (input.vendor) return `${input.vendor} device`;
  if (kind) return `Unnamed ${kind}`;
  return 'Unknown device';
}

/**
 * Works out whether a device can be handed a video to play.
 *
 * DLNA is preferred when both are available: it is a plain SOAP call with no
 * codec transcoding surprises, whereas a Cast receiver only accepts a narrow
 * set of containers. A device advertising AVTransport is telling us directly
 * that it accepts a URL to play.
 */
function detectPlayback(candidate: Candidate): PlaybackCapability | undefined {
  for (const description of candidate.upnp) {
    const avTransport = description.services.find((service) =>
      /:service:AVTransport:/i.test(service.serviceType),
    );
    if (avTransport?.controlUrl) {
      const renderingControl = description.services.find((service) =>
        /:service:RenderingControl:/i.test(service.serviceType),
      );
      const connectionManager = description.services.find((service) =>
        /:service:ConnectionManager:/i.test(service.serviceType),
      );
      return {
        protocol: 'dlna',
        controlUrl: avTransport.controlUrl,
        renderingControlUrl: renderingControl?.controlUrl,
        connectionManagerUrl: connectionManager?.controlUrl,
      };
    }
  }

  const castsOverGoogle =
    candidate.mdns.some((hit) => hit.type === 'googlecast') || candidate.openPorts.includes(8009);
  if (castsOverGoogle) return { protocol: 'chromecast' };

  return undefined;
}

function titleCaseHostname(hostname: string): string {
  const base = hostname.replace(/\.local$/i, '').replace(/[-_]+/g, ' ').trim();
  if (!base) return hostname;
  if (/[A-Z]/.test(base) && /[a-z]/.test(base)) return base; // Already mixed case.
  return base.replace(/\b\w/g, (c) => c.toUpperCase());
}

export class DiscoveryManager extends EventEmitter<DiscoveryEvents> {
  /**
   * Resolves a MAC to a vendor. Defaults to the bundled OUI subset; the main
   * process swaps in the full downloaded database when the user enables it.
   */
  private vendorLookup: (mac?: string) => VendorMatch | undefined = lookupVendor;

  private candidates = new Map<string, Candidate>();
  private devices: Device[] = [];
  private abortFlag = { aborted: false };
  private running = false;
  private gateway?: string;
  private localAddresses = new Set<string>();

  private status: ScanStatus = {
    running: false,
    phase: 'idle',
    progress: 0,
    message: 'Ready to scan',
    deviceCount: 0,
    errors: [],
  };

  setVendorLookup(lookup: (mac?: string) => VendorMatch | undefined): void {
    this.vendorLookup = lookup;
  }

  getStatus(): ScanStatus {
    return { ...this.status, errors: [...this.status.errors] };
  }

  getDevices(): Device[] {
    return this.devices;
  }

  getInterfaces(): NetworkInterfaceInfo[] {
    const interfaces = listInterfaces();
    return this.gateway
      ? interfaces.map((iface) =>
          isInCidr(this.gateway!, interfaceSubnet(iface)) ? { ...iface, gateway: this.gateway } : iface,
        )
      : interfaces;
  }

  stop(): void {
    if (!this.running) return;
    this.abortFlag.aborted = true;
    this.setStatus({ phase: 'done', message: 'Scan cancelled' });
  }

  private setStatus(patch: Partial<ScanStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }

  private progressFor(phase: ScanPhase, fraction: number): number {
    // Rough weighting of how long each phase takes relative to the whole scan.
    const bands: Partial<Record<ScanPhase, [number, number]>> = {
      starting: [0, 3],
      'arp-sweep': [3, 20],
      ssdp: [20, 45],
      mdns: [20, 45],
      probing: [45, 85],
      resolving: [85, 99],
    };
    const [start, end] = bands[phase] ?? [0, 100];
    return Math.round(start + (end - start) * Math.max(0, Math.min(1, fraction)));
  }

  private candidate(ip: string): Candidate {
    let existing = this.candidates.get(ip);
    if (!existing) {
      existing = {
        ip,
        sources: new Set(),
        ssdp: [],
        upnp: [],
        mdns: [],
        openPorts: [],
        alive: false,
        firstSeen: Date.now(),
      };
      this.candidates.set(ip, existing);
    }
    return existing;
  }

  private addError(message: string): void {
    if (this.status.errors.includes(message)) return;
    this.setStatus({ errors: [...this.status.errors, message] });
  }

  async scan(partialOptions: Partial<ScanOptions> = {}): Promise<Device[]> {
    if (this.running) return this.devices;

    const options: ScanOptions = { ...DEFAULT_SCAN_OPTIONS, ...partialOptions };
    this.running = true;
    this.abortFlag = { aborted: false };
    this.candidates.clear();

    this.status = {
      running: true,
      phase: 'starting',
      progress: 0,
      message: 'Looking at your network interfaces...',
      startedAt: Date.now(),
      deviceCount: 0,
      errors: [],
    };
    this.emit('status', this.getStatus());

    try {
      const interfaces = listInterfaces();
      if (interfaces.length === 0) {
        this.addError('No active network interface found. Are you connected to Wi-Fi?');
        return this.finish();
      }

      const primary = interfaces[0];
      this.localAddresses = new Set(interfaces.map((iface) => iface.address));
      const subnet = options.subnet ?? interfaceSubnet(primary);

      this.gateway = await findGateway();
      this.setStatus({
        message: `Scanning ${subnet} on ${primary.name}`,
        progress: this.progressFor('starting', 1),
      });

      /* ---- Phase 1: sweep + SSDP + mDNS, all at once --------------------- */

      const tasks: Promise<void>[] = [];

      if (options.enableArpSweep) {
        this.setStatus({ phase: 'arp-sweep', message: 'Waking up every address on the subnet...' });
        tasks.push(
          arpSweep(subnet, {
            concurrency: options.maxConcurrency,
            signal: this.abortFlag,
            onProgress: (done, total) => {
              if (this.status.phase === 'arp-sweep') {
                this.setStatus({ progress: this.progressFor('arp-sweep', done / total) });
              }
            },
          }).catch((error: unknown) => {
            this.addError(`Subnet sweep failed: ${(error as Error).message}`);
          }),
        );
      }

      if (options.enableSsdp) {
        tasks.push(
          discoverSsdp({
            timeoutMs: options.discoveryTimeoutMs,
            interfaceAddress: primary.address,
            signal: this.abortFlag,
            onResponse: (response) => {
              const candidate = this.candidate(response.ip);
              candidate.sources.add('ssdp');
              candidate.ssdp.push(response);
              candidate.alive = true;
            },
          })
            .then(() => undefined)
            .catch((error: unknown) => {
              this.addError(`SSDP discovery failed: ${(error as Error).message}`);
            }),
        );
      }

      if (options.enableMdns) {
        tasks.push(
          discoverMdns({
            timeoutMs: options.discoveryTimeoutMs,
            signal: this.abortFlag,
            onHit: (hit) => {
              const candidate = this.candidate(hit.ip);
              candidate.sources.add('mdns');
              candidate.mdns.push(hit);
              candidate.alive = true;
              if (hit.host && !candidate.hostname) candidate.hostname = hit.host.replace(/\.$/, '');
            },
          })
            .then(() => undefined)
            .catch((error: unknown) => {
              this.addError(`mDNS discovery failed: ${(error as Error).message}`);
            }),
        );
      }

      this.setStatus({ phase: options.enableSsdp ? 'ssdp' : 'arp-sweep', message: 'Listening for UPnP/DLNA and Bonjour announcements...' });
      await Promise.all(tasks);
      if (this.abortFlag.aborted) return this.finish();

      /* ---- Phase 2: ARP table --------------------------------------------- */

      if (options.enableArpSweep) {
        const arpEntries = await readArpTable();
        for (const entry of arpEntries) {
          if (!isInCidr(entry.ip, subnet)) continue;
          const candidate = this.candidate(entry.ip);
          candidate.sources.add('arp');
          candidate.mac = entry.mac;
        }
      }

      // Always include ourselves and the gateway, even if nothing answered.
      for (const iface of interfaces) {
        if (isInCidr(iface.address, subnet)) {
          const candidate = this.candidate(iface.address);
          candidate.alive = true;
          if (isUsableMac(iface.mac)) candidate.mac = formatMac(iface.mac);
        }
      }
      if (this.gateway && isInCidr(this.gateway, subnet)) this.candidate(this.gateway).alive = true;

      this.emitDevices();

      /* ---- Phase 3: port fingerprinting ----------------------------------- */

      const ips = [...this.candidates.keys()].filter((ip) => isIpv4(ip));

      if (options.enablePortScan && ips.length > 0) {
        this.setStatus({
          phase: 'probing',
          progress: this.progressFor('probing', 0),
          message: `Fingerprinting ${ips.length} host${ips.length === 1 ? '' : 's'}...`,
        });

        // Hosts run in parallel, and each host's ports run in parallel inside
        // that, so the two limits are split to keep total sockets bounded.
        const hostConcurrency = Math.max(4, Math.floor(options.maxConcurrency / 4));
        await mapPool(
          ips,
          hostConcurrency,
          async (ip) => {
            const result = await scanHost(ip, {
              timeoutMs: options.probeTimeoutMs,
              concurrency: 8,
              signal: this.abortFlag,
            });
            const candidate = this.candidate(ip);
            candidate.openPorts = result.openPorts;
            candidate.latencyMs = result.latencyMs;
            if (result.alive) {
              candidate.alive = true;
              candidate.sources.add('portscan');
            }
          },
          (done, total) => {
            this.setStatus({
              progress: this.progressFor('probing', done / total),
              message: `Fingerprinting hosts (${done}/${total})...`,
            });
            if (done % 8 === 0) this.emitDevices();
          },
          this.abortFlag,
        );
      }

      if (this.abortFlag.aborted) return this.finish();
      this.emitDevices();

      /* ---- Phase 4: UPnP descriptions + reverse DNS ------------------------ */

      this.setStatus({
        phase: 'resolving',
        progress: this.progressFor('resolving', 0),
        message: 'Reading device descriptions...',
      });

      const locations = new Map<string, string>(); // location -> ip
      for (const candidate of this.candidates.values()) {
        for (const response of candidate.ssdp) {
          if (response.location) locations.set(response.location, candidate.ip);
        }
      }

      const resolveJobs: Array<() => Promise<void>> = [];

      for (const [location, ip] of locations) {
        resolveJobs.push(async () => {
          const description = await fetchDeviceDescription(location, options.probeTimeoutMs + 3000);
          if (description) this.candidate(ip).upnp.push(description);
        });
      }

      if (options.enableReverseDns) {
        for (const ip of this.candidates.keys()) {
          resolveJobs.push(async () => {
            const hostname = await reverseDns(ip);
            if (hostname) {
              const candidate = this.candidate(ip);
              if (!candidate.hostname) candidate.hostname = hostname;
              candidate.sources.add('dns');
            }
          });
        }
      }

      // Ask anything with a web port what it says it is. This is how mesh
      // satellites, NAS boxes and cameras get identified - their `Server:`
      // header is direct evidence where the MAC vendor is only a hint.
      for (const [ip, candidate] of this.candidates) {
        if (candidate.openPorts.length === 0) continue;
        resolveJobs.push(async () => {
          const banner = await grabHttpBanner(ip, candidate.openPorts, options.probeTimeoutMs + 2500);
          if (banner) this.candidate(ip).banner = banner;
        });
      }

      await mapPool(
        resolveJobs,
        Math.max(8, Math.floor(options.maxConcurrency / 2)),
        (job) => job(),
        (done, total) => {
          this.setStatus({ progress: this.progressFor('resolving', done / total) });
        },
        this.abortFlag,
      );

      return this.finish();
    } catch (error) {
      this.addError((error as Error).message);
      return this.finish();
    }
  }

  private finish(): Device[] {
    this.running = false;
    const devices = this.buildDevices();
    this.devices = devices;
    this.setStatus({
      running: false,
      phase: 'done',
      progress: 100,
      finishedAt: Date.now(),
      deviceCount: devices.length,
      message: this.abortFlag.aborted
        ? `Cancelled - ${devices.length} device${devices.length === 1 ? '' : 's'} found so far`
        : `Found ${devices.length} device${devices.length === 1 ? '' : 's'}`,
    });
    this.emit('devices', devices);
    return devices;
  }

  private emitDevices(): void {
    this.devices = this.buildDevices();
    this.emit('devices', this.devices);
    this.setStatus({ deviceCount: this.devices.length });
  }

  /** Folds every candidate's raw signals into the renderer-facing `Device`. */
  private buildDevices(): Device[] {
    const now = Date.now();
    const devices: Device[] = [];

    for (const candidate of this.candidates.values()) {
      // A bare ARP entry with nothing else is usually a stale cache line.
      if (!candidate.alive && candidate.sources.size <= 1 && candidate.sources.has('arp')) continue;

      const upnpPrimary =
        candidate.upnp.find((description) => !/InternetGatewayDevice/i.test(description.deviceType ?? '')) ??
        candidate.upnp[0];

      const vendorMatch = this.vendorLookup(candidate.mac);
      const isGateway = this.gateway === candidate.ip;
      const isSelf = this.localAddresses.has(candidate.ip);

      const mdnsTxt: Record<string, string> = {};
      for (const hit of candidate.mdns) Object.assign(mdnsTxt, hit.txt);

      const services = this.buildServices(candidate);

      const classification = classify({
        vendor: vendorMatch?.vendor,
        randomizedMac: vendorMatch?.randomized ?? false,
        httpServer: candidate.banner?.server,
        httpTitle: candidate.banner?.title,
        httpRealm: candidate.banner?.realm,
        manufacturer: upnpPrimary?.manufacturer,
        modelName: upnpPrimary?.modelName ?? upnpPrimary?.modelDescription,
        friendlyName: upnpPrimary?.friendlyName ?? bestMdnsName(candidate.mdns),
        hostname: candidate.hostname,
        upnpDeviceTypes: [
          ...candidate.upnp.map((description) => description.deviceType ?? ''),
          ...candidate.ssdp.map((response) => response.st ?? ''),
        ].filter(Boolean),
        upnpServiceTypes: candidate.upnp.flatMap((description) => description.serviceTypes),
        mdnsTypes: candidate.mdns.map((hit) => hit.type),
        mdnsTxt,
        openPorts: candidate.openPorts,
        isGateway,
        isSelf,
      });

      // Naming, best evidence first: a name the owner chose, then a name the
      // device chose, then the best description we can synthesise.
      const name = pickName({
        upnpName: upnpPrimary?.friendlyName,
        mdnsName: bestMdnsName(candidate.mdns),
        hostname: candidate.hostname,
        isGateway,
        isSelf,
        vendor: vendorMatch?.randomized ? undefined : vendorMatch?.vendor,
        category: classification.category,
        confidence: classification.confidence,
      });

      const icon = candidate.upnp.flatMap((description) => description.icons)[0];

      devices.push({
        id: isUsableMac(candidate.mac) ? candidate.mac! : candidate.ip,
        ip: candidate.ip,
        mac: candidate.mac,
        hostname: candidate.hostname,
        name,
        category: classification.category,
        confidence: classification.confidence,
        vendor: vendorMatch?.vendor,
        manufacturer: upnpPrimary?.manufacturer,
        model: [upnpPrimary?.modelName, upnpPrimary?.modelNumber].filter(Boolean).join(' ') || undefined,
        os: mdnsTxt.osxvers ? `macOS (Darwin ${mdnsTxt.osxvers})` : undefined,
        iconUrl: icon?.url,
        presentationUrl:
          upnpPrimary?.presentationUrl ??
          (candidate.openPorts.includes(80)
            ? `http://${candidate.ip}/`
            : candidate.openPorts.includes(443)
              ? `https://${candidate.ip}/`
              : candidate.openPorts.includes(8080)
                ? `http://${candidate.ip}:8080/`
                : undefined),
        playback: detectPlayback(candidate),
        sources: [...candidate.sources],
        services,
        openPorts: candidate.openPorts.map((port) => ({ port, label: portLabel(port) })),
        httpServer: candidate.banner?.server,
        httpTitle: candidate.banner?.title,
        latencyMs: candidate.latencyMs,
        isGateway,
        isSelf,
        online: candidate.alive,
        firstSeen: candidate.firstSeen,
        lastSeen: now,
        raw: {
          classificationSignals: classification.signals satisfies Signal[],
          httpBanner: candidate.banner,
          ssdp: candidate.ssdp,
          upnp: candidate.upnp,
          mdns: candidate.mdns,
        },
      });
    }

    return devices.sort((a, b) => {
      // Gateway first, then by category, then numerically by address.
      if (a.isGateway !== b.isGateway) return a.isGateway ? -1 : 1;
      if (a.category !== b.category) return a.category.localeCompare(b.category);
      return (
        Number(a.ip.split('.')[3] ?? 0) - Number(b.ip.split('.')[3] ?? 0) ||
        a.ip.localeCompare(b.ip)
      );
    });
  }

  private buildServices(candidate: Candidate): DeviceService[] {
    const services = new Map<string, DeviceService>();

    for (const description of candidate.upnp) {
      if (description.deviceType) {
        const label = shortenUrn(description.deviceType) ?? description.deviceType;
        services.set(`upnp:${description.deviceType}`, {
          id: `upnp:${description.deviceType}`,
          label,
          protocol: 'upnp',
          detail: {
            ...(description.manufacturer ? { Manufacturer: description.manufacturer } : {}),
            ...(description.modelName ? { Model: description.modelName } : {}),
            ...(description.serialNumber ? { Serial: description.serialNumber } : {}),
            Description: description.location,
          },
        });
      }
      for (const serviceType of description.serviceTypes) {
        const label = shortenUrn(serviceType) ?? serviceType;
        services.set(`upnp:${serviceType}`, {
          id: `upnp:${serviceType}`,
          label,
          protocol: 'upnp',
        });
      }
    }

    // SSDP hits with no fetchable description still tell us what it claims to be.
    for (const response of candidate.ssdp) {
      if (!response.st || candidate.upnp.length > 0) continue;
      const label = shortenUrn(response.st);
      if (!label) continue;
      services.set(`ssdp:${response.st}`, {
        id: `ssdp:${response.st}`,
        label,
        protocol: 'upnp',
        detail: {
          ...(response.server ? { Server: response.server } : {}),
          ...(response.location ? { Location: response.location } : {}),
        },
      });
    }

    for (const hit of candidate.mdns) {
      const profile = mdnsProfile(hit.type);
      services.set(`mdns:${hit.type}`, {
        id: `mdns:${hit.type}`,
        label: profile.label,
        protocol: 'mdns',
        port: hit.port,
        detail: Object.keys(hit.txt).length > 0 ? hit.txt : undefined,
      });
    }

    return [...services.values()].sort((a, b) => a.label.localeCompare(b.label));
  }
}
