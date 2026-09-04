import { useCallback, useEffect, useMemo, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBoxesStacked,
  faCircleInfo,
  faCircleNodes,
  faCloudArrowDown,
  faDownload,
  faEthernet,
  faFileVideo,
  faGear,
  faMagnifyingGlass,
  faRoute,
  faSatelliteDish,
  faStop,
  faTowerBroadcast,
  faTriangleExclamation,
  faWifi,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import type {
  CastSession,
  Device,
  DeviceCategory,
  NetworkInterfaceInfo,
  RouterLinkStatus,
  ScanOptions,
  ScanStatus,
  VendorDbStatus,
} from '@shared/types';
import { DEFAULT_SCAN_OPTIONS, EMPTY_CAST_SESSION, EMPTY_ROUTER_LINK } from '@shared/types';
import { CastBar } from './components/CastBar';
import { DeviceCard } from './components/DeviceCard';
import { DeviceDetail } from './components/DeviceDetail';
import { SettingsModal } from './components/SettingsModal';
import { TopologyGraph, ViewSwitch } from './components/TopologyGraph';
import { CATEGORY_COLORS, CATEGORY_ICONS, CATEGORY_LABELS, CATEGORY_ORDER } from './lib/icons';
import { compareIp, searchBlob } from './lib/format';

type SortKey = 'ip' | 'name' | 'category' | 'confidence';

const INITIAL_STATUS: ScanStatus = {
  running: false,
  phase: 'idle',
  progress: 0,
  message: 'Ready to scan',
  deviceCount: 0,
  errors: [],
};

export default function App(): React.JSX.Element {
  const [devices, setDevices] = useState<Device[]>([]);
  const [status, setStatus] = useState<ScanStatus>(INITIAL_STATUS);
  const [interfaces, setInterfaces] = useState<NetworkInterfaceInfo[]>([]);
  const [options, setOptions] = useState<ScanOptions>(DEFAULT_SCAN_OPTIONS);
  const [vendorDb, setVendorDb] = useState<VendorDbStatus>({
    loaded: false,
    entryCount: 0,
    source: 'bundled',
  });
  const [vendorDbBusy, setVendorDbBusy] = useState(false);
  const [castSession, setCastSession] = useState<CastSession>(EMPTY_CAST_SESSION);
  const [castOpen, setCastOpen] = useState(false);
  const [routerLink, setRouterLink] = useState<RouterLinkStatus>(EMPTY_ROUTER_LINK);

  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<DeviceCategory | 'all'>('all');
  const [sortKey, setSortKey] = useState<SortKey>('ip');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const [vendorHintDismissed, setVendorHintDismissed] = useState(false);
  const [view, setView] = useState<'grid' | 'graph'>('grid');

  /* ---------------------------------------------------------------- wiring */

  useEffect(() => {
    const unsubscribeDevices = window.lanScout.onDevices(setDevices);
    const unsubscribeStatus = window.lanScout.onStatus(setStatus);
    const unsubscribeCast = window.lanScout.onCastSession(setCastSession);
    const unsubscribeRouter = window.lanScout.onRouterLink(setRouterLink);

    void window.lanScout.getInterfaces().then(setInterfaces);
    void window.lanScout.getDevices().then((initial) => {
      if (initial.length > 0) {
        setDevices(initial);
        setHasScanned(true);
      }
    });
    void window.lanScout.getStatus().then(setStatus);
    void window.lanScout.getVendorDbStatus().then(setVendorDb);
    void window.lanScout.getRouterLink().then(setRouterLink);
    void window.lanScout.getCastSession().then((session) => {
      setCastSession(session);
      if (session.media) setCastOpen(true);
    });

    return () => {
      unsubscribeDevices();
      unsubscribeStatus();
      unsubscribeCast();
      unsubscribeRouter();
    };
  }, []);

  const primary = interfaces[0];

  /** The primary adapter's network in CIDR form, e.g. `192.168.1.0/24`. */
  const subnet = useMemo(() => {
    if (!primary) return undefined;
    const maskOctets = primary.netmask.split('.').map(Number);
    const prefix = maskOctets.reduce(
      (bits, octet) => bits + ((octet >>> 0).toString(2).match(/1/g)?.length ?? 0),
      0,
    );
    const network = primary.address
      .split('.')
      .map((octet, index) => Number(octet) & maskOctets[index])
      .join('.');
    return `${network}/${prefix}`;
  }, [primary]);

  const startScan = useCallback(async () => {
    setHasScanned(true);
    setSelectedId(null);
    await window.lanScout.startScan(options);
    void window.lanScout.getInterfaces().then(setInterfaces);
  }, [options]);

  const stopScan = useCallback(() => {
    void window.lanScout.stopScan();
  }, []);

  const exportJson = useCallback(async () => {
    await window.lanScout.exportJson(devices);
  }, [devices]);

  /** Opens the file picker; the cast bar appears once a file is chosen. */
  const pickVideo = useCallback(async () => {
    const media = await window.lanScout.pickMedia();
    if (media) setCastOpen(true);
  }, []);

  const castTo = useCallback(async (deviceId: string) => {
    setCastOpen(true);
    // The main process reports failures through the session's `error` field,
    // which the cast bar renders, so a rejection here needs no second channel.
    await window.lanScout.castPlay(deviceId).catch(() => undefined);
  }, []);

  const closeCast = useCallback(async () => {
    await window.lanScout.castStop().catch(() => undefined);
    setCastOpen(false);
  }, []);

  const connectRouter = useCallback(async (host: string, password: string, remember: boolean) => {
    setRouterLink(await window.lanScout.connectRouter(host, password, remember));
  }, []);

  const disconnectRouter = useCallback(async () => {
    setRouterLink(await window.lanScout.disconnectRouter());
  }, []);

  const refreshVendorDb = useCallback(async () => {
    setVendorDbBusy(true);
    try {
      setVendorDb(await window.lanScout.refreshVendorDb());
    } finally {
      setVendorDbBusy(false);
    }
  }, []);

  // Enter starts a scan, Escape closes the detail pane.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const inField = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
      if (event.key === 'Escape') {
        setSelectedId(null);
        setShowSettings(false);
      }
      if (event.key === 'Enter' && !inField && !status.running && !showSettings) {
        void startScan();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [startScan, status.running, showSettings]);

  /* ---------------------------------------------------------------- derived */

  const counts = useMemo(() => {
    const map = new Map<DeviceCategory, number>();
    for (const device of devices) map.set(device.category, (map.get(device.category) ?? 0) + 1);
    return map;
  }, [devices]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = devices.filter((device) => {
      if (categoryFilter !== 'all' && device.category !== categoryFilter) return false;
      if (!needle) return true;
      return searchBlob(device).includes(needle);
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      switch (sortKey) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'category':
          return CATEGORY_LABELS[a.category].localeCompare(CATEGORY_LABELS[b.category]) ||
            compareIp(a.ip, b.ip);
        case 'confidence':
          return b.confidence - a.confidence || compareIp(a.ip, b.ip);
        default:
          return compareIp(a.ip, b.ip);
      }
    });
    return sorted;
  }, [devices, query, categoryFilter, sortKey]);

  const selected = useMemo(
    () => devices.find((device) => device.id === selectedId) ?? null,
    [devices, selectedId],
  );

  const activeCategories = CATEGORY_ORDER.filter((category) => (counts.get(category) ?? 0) > 0);

  // Most devices have no vendor name until the full IEEE registry is fetched.
  // Offer it once the gap is obvious rather than downloading behind the user's back.
  const unnamedVendors = devices.filter((device) => device.mac && !device.vendor).length;
  const showVendorHint =
    !vendorDb.loaded && !vendorHintDismissed && !status.running && unnamedVendors >= 3;

  /* ---------------------------------------------------------------- render */

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="brand__mark">
            <FontAwesomeIcon icon={faSatelliteDish} />
          </div>
          <div className="brand__text">
            <h1>LAN Media Scout</h1>
            <p>TVs, phones and media servers on your Wi-Fi</p>
          </div>
        </div>

        <div className="header__net">
          {primary && (
            <span className="netpill" title={`Adapter: ${primary.name}`}>
              <FontAwesomeIcon icon={faEthernet} />
              <strong>{primary.name}</strong>
            </span>
          )}
          {subnet && (
            <span className="netpill">
              <FontAwesomeIcon icon={faCircleNodes} />
              <strong className="mono">{subnet}</strong>
            </span>
          )}
          {primary?.gateway && (
            <span className="netpill" title="Default gateway">
              <FontAwesomeIcon icon={faRoute} />
              <strong className="mono">{primary.gateway}</strong>
            </span>
          )}
        </div>

        <div className="header__actions">
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => setShowSettings(true)}
            title="Scan settings"
          >
            <FontAwesomeIcon icon={faGear} />
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void pickVideo()}
            title="Choose a video, then pick the device to play it on"
          >
            <FontAwesomeIcon icon={faFileVideo} />
            Play video
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void exportJson()}
            disabled={devices.length === 0}
            title="Export the device list as JSON"
          >
            <FontAwesomeIcon icon={faDownload} />
            Export
          </button>
          {status.running ? (
            <button type="button" className="btn btn--danger" onClick={stopScan}>
              <FontAwesomeIcon icon={faStop} />
              Stop
            </button>
          ) : (
            <button type="button" className="btn btn--primary" onClick={() => void startScan()}>
              <FontAwesomeIcon icon={faTowerBroadcast} />
              Scan network
            </button>
          )}
        </div>
      </header>

      {(status.running || status.phase === 'done') && (
        <div className="progress">
          <FontAwesomeIcon
            icon={faTowerBroadcast}
            className={status.running ? 'spin' : ''}
            style={{ color: status.running ? 'var(--accent)' : 'var(--text-dim)', fontSize: 12 }}
          />
          <span className="progress__label">{status.message}</span>
          <div className="progress__bar">
            <div className="progress__fill" style={{ width: `${status.progress}%` }} />
          </div>
          <span className="progress__pct">{status.progress}%</span>
        </div>
      )}

      {status.errors.length > 0 && (
        <div className="errors">
          {status.errors.map((error) => (
            <div key={error} className="banner banner--error" style={{ marginBottom: 6 }}>
              <FontAwesomeIcon icon={faTriangleExclamation} />
              <span>{error}</span>
            </div>
          ))}
        </div>
      )}

      <div className="app__body">
        <main className="app__main">
          {devices.length > 0 && (
            <div className="stats">
              <button
                type="button"
                className={`stat${categoryFilter === 'all' ? ' stat--active' : ''}`}
                onClick={() => setCategoryFilter('all')}
              >
                <div
                  className="stat__icon"
                  style={{ background: 'rgba(56,189,248,0.14)', color: 'var(--accent)' }}
                >
                  <FontAwesomeIcon icon={faBoxesStacked} />
                </div>
                <div>
                  <div className="stat__value">{devices.length}</div>
                  <div className="stat__label">All devices</div>
                </div>
              </button>

              {activeCategories.map((category) => (
                <button
                  key={category}
                  type="button"
                  className={`stat${categoryFilter === category ? ' stat--active' : ''}`}
                  onClick={() => setCategoryFilter(categoryFilter === category ? 'all' : category)}
                >
                  <div
                    className="stat__icon"
                    style={{
                      background: `color-mix(in srgb, ${CATEGORY_COLORS[category]} 14%, transparent)`,
                      color: CATEGORY_COLORS[category],
                    }}
                  >
                    <FontAwesomeIcon icon={CATEGORY_ICONS[category]} />
                  </div>
                  <div>
                    <div className="stat__value">{counts.get(category)}</div>
                    <div className="stat__label">{CATEGORY_LABELS[category]}</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {showVendorHint && (
            <div style={{ padding: '10px 20px 0' }}>
              <div className="banner banner--info" style={{ marginBottom: 0 }}>
                <FontAwesomeIcon icon={faCircleInfo} />
                <span style={{ flex: 1 }}>
                  {unnamedVendors} device{unnamedVendors === 1 ? '' : 's'} could not be matched to a
                  manufacturer. Downloading the full IEEE vendor registry (~3 MB, from wireshark.org)
                  names almost all of them.
                </span>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => void refreshVendorDb()}
                  disabled={vendorDbBusy}
                >
                  <FontAwesomeIcon icon={faCloudArrowDown} className={vendorDbBusy ? 'spin' : ''} />
                  Download
                </button>
                <button
                  type="button"
                  className="detail__close"
                  onClick={() => setVendorHintDismissed(true)}
                  aria-label="Dismiss"
                >
                  <FontAwesomeIcon icon={faXmark} />
                </button>
              </div>
            </div>
          )}

          {devices.length > 0 && (
            <div className="toolbar">
              <label className="search">
                <FontAwesomeIcon icon={faMagnifyingGlass} />
                <input
                  type="search"
                  placeholder="Search name, IP, MAC, vendor, service or port…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>

              <select
                className="select select--sort"
                value={sortKey}
                onChange={(event) => setSortKey(event.target.value as SortKey)}
                aria-label="Sort devices"
              >
                <option value="ip">Sort by IP</option>
                <option value="name">Sort by name</option>
                <option value="category">Sort by type</option>
                <option value="confidence">Sort by confidence</option>
              </select>

              <div className="toolbar__spacer" />
              <span className="toolbar__count">
                {visible.length} of {devices.length} shown
              </span>
              <ViewSwitch view={view} onChange={setView} />
            </div>
          )}

          {view === 'graph' && devices.length > 0 ? (
            <TopologyGraph
              devices={visible}
              selectedId={selectedId}
              hasInternet={Boolean(primary?.gateway)}
              onSelect={setSelectedId}
            />
          ) : (
            <div className="grid-wrap">
              {visible.length > 0 ? (
                <div className="grid">
                  {visible.map((device) => (
                    <DeviceCard
                      key={device.id}
                      device={device}
                      selected={device.id === selectedId}
                      onSelect={(next) => setSelectedId(next.id === selectedId ? null : next.id)}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState
                  scanning={status.running}
                  hasScanned={hasScanned}
                  filtered={devices.length > 0}
                  onScan={() => void startScan()}
                  onClearFilters={() => {
                    setQuery('');
                    setCategoryFilter('all');
                  }}
                />
              )}
            </div>
          )}
        </main>

        {selected && (
          <DeviceDetail
            device={selected}
            onClose={() => setSelectedId(null)}
            onCast={(deviceId) => void castTo(deviceId)}
          />
        )}
      </div>

      {castOpen && (
        <CastBar
          session={castSession}
          devices={devices}
          onPlay={(deviceId) => void castTo(deviceId)}
          onPause={() => void window.lanScout.castPause()}
          onResume={() => void window.lanScout.castResume()}
          onStop={() => void window.lanScout.castStop()}
          onSeek={(seconds) => void window.lanScout.castSeek(seconds)}
          onVolume={(percent) => void window.lanScout.castVolume(percent)}
          onClose={() => void closeCast()}
        />
      )}

      {showSettings && (
        <SettingsModal
          options={options}
          onChange={(patch) => setOptions((current) => ({ ...current, ...patch }))}
          interfaces={interfaces}
          subnet={subnet}
          vendorDb={vendorDb}
          vendorDbBusy={vendorDbBusy}
          onRefreshVendorDb={() => void refreshVendorDb()}
          routerLink={routerLink}
          gateway={primary?.gateway}
          onConnectRouter={connectRouter}
          onDisconnectRouter={disconnectRouter}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

function EmptyState({
  scanning,
  hasScanned,
  filtered,
  onScan,
  onClearFilters,
}: {
  scanning: boolean;
  hasScanned: boolean;
  filtered: boolean;
  onScan: () => void;
  onClearFilters: () => void;
}): React.JSX.Element {
  if (scanning) {
    return (
      <div className="empty">
        <div className="empty__icon">
          <FontAwesomeIcon icon={faTowerBroadcast} className="spin" />
        </div>
        <h3>Listening to your network…</h3>
        <p>
          Sending UPnP and Bonjour probes, sweeping the subnet and fingerprinting whatever answers.
        </p>
      </div>
    );
  }

  if (filtered) {
    return (
      <div className="empty">
        <div className="empty__icon">
          <FontAwesomeIcon icon={faMagnifyingGlass} />
        </div>
        <h3>Nothing matches those filters</h3>
        <p>Try a different search term, or clear the filters to see every device again.</p>
        <button type="button" className="btn" onClick={onClearFilters}>
          Clear filters
        </button>
      </div>
    );
  }

  return (
    <div className="empty">
      <div className="empty__icon">
        <FontAwesomeIcon icon={faWifi} />
      </div>
      <h3>{hasScanned ? 'No devices found' : 'Ready when you are'}</h3>
      <p>
        {hasScanned
          ? 'Nothing answered on this subnet. Check that you are on Wi-Fi rather than a guest or isolated network, then try again.'
          : 'Scan your Wi-Fi to list every TV, phone, speaker, media server and smart-home device that is reachable from this computer.'}
      </p>
      <button type="button" className="btn btn--primary" onClick={onScan}>
        <FontAwesomeIcon icon={faTowerBroadcast} />
        {hasScanned ? 'Scan again' : 'Scan network'}
      </button>
    </div>
  );
}
