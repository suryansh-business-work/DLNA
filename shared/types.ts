/**
 * Types shared between the Electron main process (discovery engine)
 * and the React renderer. Keep this file dependency-free.
 */

export type DeviceCategory =
  | 'tv'
  | 'phone'
  | 'tablet'
  | 'media-server'
  | 'speaker'
  | 'streaming-stick'
  | 'game-console'
  | 'computer'
  | 'nas'
  | 'router'
  | 'access-point'
  | 'printer'
  | 'camera'
  | 'iot'
  | 'unknown';

export type DiscoverySource = 'ssdp' | 'mdns' | 'arp' | 'portscan' | 'dns';

export interface DeviceService {
  /** Stable key, e.g. "mdns:_googlecast._tcp" or "upnp:MediaRenderer" */
  id: string;
  /** Human label, e.g. "Google Cast" */
  label: string;
  protocol: 'upnp' | 'mdns' | 'tcp' | 'http';
  port?: number;
  /** Extra key/value detail (TXT records, UPnP service list, …) */
  detail?: Record<string, string>;
}

export interface OpenPort {
  port: number;
  label: string;
}

export type CastProtocol = 'dlna' | 'chromecast';

/** How, if at all, this device can be asked to play a video. */
export interface PlaybackCapability {
  protocol: CastProtocol;
  /** DLNA only: absolute SOAP endpoint for AVTransport. */
  controlUrl?: string;
  /** DLNA only: absolute SOAP endpoint for RenderingControl (volume). */
  renderingControlUrl?: string;
  /** DLNA only: ConnectionManager, used to ask which formats it accepts. */
  connectionManagerUrl?: string;
}

/** Optional link to the user's router, which knows the mesh associations. */
export interface RouterLinkStatus {
  configured: boolean;
  connected: boolean;
  connecting: boolean;
  host?: string;
  nodeCount: number;
  clientCount: number;
  /** True when the router reports which mesh node each client is joined to. */
  hasAssociations: boolean;
  fetchedAt?: number;
  /** False on systems with no OS secret store, where the password cannot be saved. */
  canStoreSecurely: boolean;
  error?: string;
}

export const EMPTY_ROUTER_LINK: RouterLinkStatus = {
  configured: false,
  connected: false,
  connecting: false,
  nodeCount: 0,
  clientCount: 0,
  hasAssociations: false,
  canStoreSecurely: false,
};

export interface Device {
  /** Stable id — MAC when known, otherwise the IP. */
  id: string;
  ip: string;
  mac?: string;
  hostname?: string;
  /** Best available friendly name. */
  name: string;
  category: DeviceCategory;
  /** 0–1, how sure we are about `category`. */
  confidence: number;
  vendor?: string;
  manufacturer?: string;
  model?: string;
  os?: string;
  iconUrl?: string;
  presentationUrl?: string;
  sources: DiscoverySource[];
  services: DeviceService[];
  openPorts: OpenPort[];
  /** Identifying strings from the device own web server, when it has one. */
  httpServer?: string;
  httpTitle?: string;
  /** Round-trip time of the last successful TCP probe, in ms. */
  latencyMs?: number;
  /**
   * MAC of the mesh node this device is joined to. Only ever set from the
   * router's own client list - it cannot be observed by scanning.
   */
  uplinkMac?: string;
  /** How the device reaches the network, e.g. 'wired' or 'band5'. */
  uplinkKind?: string;
  /** Set when this device can be sent a video to play. */
  playback?: PlaybackCapability;
  isGateway: boolean;
  isSelf: boolean;
  online: boolean;
  firstSeen: number;
  lastSeen: number;
  /** Raw payloads kept for the detail drawer / JSON export. */
  raw: Record<string, unknown>;
}

export interface NetworkInterfaceInfo {
  name: string;
  address: string;
  netmask: string;
  mac: string;
  cidr: string;
  /** Number of usable hosts implied by the netmask. */
  hostCount: number;
  gateway?: string;
}

export type ScanPhase =
  | 'idle'
  | 'starting'
  | 'arp-sweep'
  | 'ssdp'
  | 'mdns'
  | 'probing'
  | 'resolving'
  | 'done';

export interface ScanStatus {
  running: boolean;
  phase: ScanPhase;
  /** 0–100 */
  progress: number;
  message: string;
  startedAt?: number;
  finishedAt?: number;
  deviceCount: number;
  errors: string[];
}

export interface ScanOptions {
  /** CIDR to sweep, e.g. "192.168.1.0/24". Defaults to the primary interface. */
  subnet?: string;
  enableArpSweep: boolean;
  enableSsdp: boolean;
  enableMdns: boolean;
  enablePortScan: boolean;
  enableReverseDns: boolean;
  /** How long to listen for SSDP/mDNS replies, in ms. */
  discoveryTimeoutMs: number;
  /** Per-socket TCP connect timeout, in ms. */
  probeTimeoutMs: number;
  maxConcurrency: number;
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  enableArpSweep: true,
  enableSsdp: true,
  enableMdns: true,
  enablePortScan: true,
  enableReverseDns: true,
  discoveryTimeoutMs: 6000,
  probeTimeoutMs: 900,
  maxConcurrency: 64,
};

/** A video/audio file the user picked, published on the local media server. */
export interface SelectedMedia {
  id: string;
  filePath: string;
  fileName: string;
  size: number;
  mimeType: string;
  /** URL the receiving device fetches. Only reachable on the LAN. */
  url: string;
}

export type PlaybackState = 'idle' | 'connecting' | 'playing' | 'paused' | 'stopped' | 'error';

export interface CastSession {
  state: PlaybackState;
  media?: SelectedMedia;
  /** Device id currently being cast to. */
  targetId?: string;
  targetName?: string;
  protocol?: CastProtocol;
  /** Seconds. */
  position: number;
  duration: number;
  error?: string;
}

export const EMPTY_CAST_SESSION: CastSession = { state: 'idle', position: 0, duration: 0 };

export interface VendorDbStatus {
  /** True when the full downloaded registry is in use, not the bundled subset. */
  loaded: boolean;
  entryCount: number;
  fetchedAt?: number;
  source: 'bundled' | 'cache' | 'network';
  error?: string;
}

/** Renderer-visible API exposed on `window.lanScout` by the preload script. */
export interface LanScoutApi {
  getInterfaces(): Promise<NetworkInterfaceInfo[]>;
  startScan(options?: Partial<ScanOptions>): Promise<void>;
  stopScan(): Promise<void>;
  getDevices(): Promise<Device[]>;
  getStatus(): Promise<ScanStatus>;
  openExternal(url: string): Promise<void>;
  exportJson(devices: Device[]): Promise<{ saved: boolean; path?: string }>;
  getRouterLink(): Promise<RouterLinkStatus>;
  connectRouter(host: string, password: string, remember: boolean): Promise<RouterLinkStatus>;
  refreshRouter(): Promise<RouterLinkStatus>;
  disconnectRouter(): Promise<RouterLinkStatus>;
  getVendorDbStatus(): Promise<VendorDbStatus>;
  refreshVendorDb(): Promise<VendorDbStatus>;

  /** Opens a file picker and publishes the chosen file. `null` if cancelled. */
  pickMedia(): Promise<SelectedMedia | null>;
  /** Starts playback of the picked file on the given device. */
  castPlay(deviceId: string): Promise<void>;
  castPause(): Promise<void>;
  castResume(): Promise<void>;
  castStop(): Promise<void>;
  castSeek(seconds: number): Promise<void>;
  castVolume(percent: number): Promise<void>;
  getCastSession(): Promise<CastSession>;

  onDevices(cb: (devices: Device[]) => void): () => void;
  onStatus(cb: (status: ScanStatus) => void): () => void;
  onCastSession(cb: (session: CastSession) => void): () => void;
  onRouterLink(cb: (status: RouterLinkStatus) => void): () => void;
  platform: NodeJS.Platform;
  appVersion: string;
}

declare global {
  interface Window {
    lanScout: LanScoutApi;
  }
}
