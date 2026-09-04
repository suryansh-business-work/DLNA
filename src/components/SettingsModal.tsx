import { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCircleCheck,
  faCircleInfo,
  faCloudArrowDown,
  faRightToBracket,
  faSpinner,
  faGear,
  faTriangleExclamation,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import type {
  NetworkInterfaceInfo,
  RouterLinkStatus,
  ScanOptions,
  VendorDbStatus,
} from '@shared/types';
import { formatTimestamp } from '../lib/format';

interface Props {
  options: ScanOptions;
  onChange: (patch: Partial<ScanOptions>) => void;
  interfaces: NetworkInterfaceInfo[];
  subnet?: string;
  vendorDb: VendorDbStatus;
  vendorDbBusy: boolean;
  onRefreshVendorDb: () => void;
  routerLink: RouterLinkStatus;
  gateway?: string;
  onConnectRouter: (host: string, password: string, remember: boolean) => Promise<void>;
  onDisconnectRouter: () => Promise<void>;
  onClose: () => void;
}

/**
 * Optional router login.
 *
 * This is the only way to learn which mesh node each client is joined to, and
 * it is the only place the app asks for a credential - so it says plainly what
 * the password is used for and where it is kept.
 */
function RouterLinkSection({
  status,
  defaultHost,
  onConnect,
  onDisconnect,
}: {
  status: RouterLinkStatus;
  defaultHost?: string;
  onConnect: (host: string, password: string, remember: boolean) => Promise<void>;
  onDisconnect: () => Promise<void>;
}): React.JSX.Element {
  const [host, setHost] = useState(status.host ?? defaultHost ?? '');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      await onConnect(host.trim() || (defaultHost ?? ''), password, remember);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field" style={{ display: 'block' }}>
      <div className="field__label" style={{ marginBottom: 4 }}>
        Router link (mesh topology)
      </div>
      <div className="field__hint" style={{ maxWidth: '100%', marginBottom: 10 }}>
        Which mesh node a device is joined to lives inside your router — no amount
        of scanning reveals it. Sign in to your TP-Link Deco to pull the real
        per-node client list.
        {status.canStoreSecurely
          ? ' The password is encrypted by Windows for your user account and only ever sent to the router address below.'
          : ' This system has no secure credential store, so the password cannot be saved between runs.'}
      </div>

      {status.connected ? (
        <div className="banner banner--info" style={{ marginBottom: 10 }}>
          <FontAwesomeIcon icon={faCircleCheck} />
          <span style={{ flex: 1 }}>
            Connected to {status.host} — {status.nodeCount} mesh node
            {status.nodeCount === 1 ? '' : 's'}, {status.clientCount} client
            {status.clientCount === 1 ? '' : 's'}.
            {status.hasAssociations
              ? ' Per-node associations are being used in the topology view.'
              : ' The router did not report which node each client is on, so the graph keeps its grouped layout.'}
          </span>
          <button
            type="button"
            className="btn btn--sm btn--danger"
            onClick={() => void onDisconnect()}
          >
            Disconnect
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <input
              type="text"
              className="select mono"
              style={{ flex: '1 1 150px' }}
              placeholder={defaultHost ?? 'Router IP'}
              value={host}
              onChange={(event) => setHost(event.target.value)}
              aria-label="Router address"
            />
            <input
              type="password"
              className="select"
              style={{ flex: '2 1 190px' }}
              placeholder="Router admin password"
              value={password}
              autoComplete="off"
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && password) void submit();
              }}
              aria-label="Router password"
            />
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => void submit()}
              disabled={busy || !password}
            >
              <FontAwesomeIcon icon={busy ? faSpinner : faRightToBracket} className={busy ? 'spin' : ''} />
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <Toggle
              checked={remember && status.canStoreSecurely}
              onChange={setRemember}
              label="Remember password"
            />
            <span style={{ color: 'var(--text-muted)' }}>
              {status.canStoreSecurely
                ? 'Remember it (encrypted in the OS credential store)'
                : 'Secure storage unavailable on this system'}
            </span>
          </label>
        </>
      )}

      {status.error && (
        <div className="banner banner--error" style={{ marginTop: 10, marginBottom: 0 }}>
          <FontAwesomeIcon icon={faTriangleExclamation} />
          <span>{status.error}</span>
        </div>
      )}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`switch${checked ? ' switch--on' : ''}`}
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
    />
  );
}

export function SettingsModal({
  options,
  onChange,
  interfaces,
  subnet,
  vendorDb,
  vendorDbBusy,
  onRefreshVendorDb,
  routerLink,
  gateway,
  onConnectRouter,
  onDisconnectRouter,
  onClose,
}: Props): React.JSX.Element {
  const wideSubnet = interfaces.some((iface) => iface.hostCount > 1024);

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      role="presentation"
    >
      <div
        className="modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Scan settings"
      >
        <header className="modal__head">
          <FontAwesomeIcon icon={faGear} />
          <span style={{ flex: 1 }}>Scan settings</span>
          <button type="button" className="detail__close" onClick={onClose} aria-label="Close">
            <FontAwesomeIcon icon={faXmark} />
          </button>
        </header>

        <div className="modal__body">
          {wideSubnet && (
            <div className="banner banner--warn">
              <FontAwesomeIcon icon={faTriangleExclamation} />
              <span>
                Your network is larger than a /24 ({subnet}). Sweeping it takes longer — narrow the
                subnet below if the scan feels slow.
              </span>
            </div>
          )}

          <div className="field">
            <div>
              <div className="field__label">Subnet to scan</div>
              <div className="field__hint">
                Defaults to the subnet of your primary adapter. Use CIDR notation.
              </div>
            </div>
            <div className="field__control">
              <input
                type="text"
                className="select mono"
                style={{ width: 150 }}
                placeholder={subnet ?? '192.168.1.0/24'}
                value={options.subnet ?? ''}
                onChange={(event) => onChange({ subnet: event.target.value || undefined })}
              />
            </div>
          </div>

          <div className="field">
            <div>
              <div className="field__label">Subnet sweep (ARP)</div>
              <div className="field__hint">
                Pings every address so the OS learns each device&apos;s MAC. Finds devices that
                announce nothing.
              </div>
            </div>
            <div className="field__control">
              <Toggle
                label="Subnet sweep"
                checked={options.enableArpSweep}
                onChange={(value) => onChange({ enableArpSweep: value })}
              />
            </div>
          </div>

          <div className="field">
            <div>
              <div className="field__label">UPnP / DLNA (SSDP)</div>
              <div className="field__hint">Finds TVs, media servers and renderers.</div>
            </div>
            <div className="field__control">
              <Toggle
                label="SSDP discovery"
                checked={options.enableSsdp}
                onChange={(value) => onChange({ enableSsdp: value })}
              />
            </div>
          </div>

          <div className="field">
            <div>
              <div className="field__label">Bonjour / mDNS</div>
              <div className="field__hint">
                Finds Chromecast, AirPlay, Sonos, printers, Macs and iPhones.
              </div>
            </div>
            <div className="field__control">
              <Toggle
                label="mDNS discovery"
                checked={options.enableMdns}
                onChange={(value) => onChange({ enableMdns: value })}
              />
            </div>
          </div>

          <div className="field">
            <div>
              <div className="field__label">Port fingerprinting</div>
              <div className="field__hint">
                Connects to ~45 well-known media and management ports to work out what each device
                is.
              </div>
            </div>
            <div className="field__control">
              <Toggle
                label="Port fingerprinting"
                checked={options.enablePortScan}
                onChange={(value) => onChange({ enablePortScan: value })}
              />
            </div>
          </div>

          <div className="field">
            <div>
              <div className="field__label">Reverse DNS</div>
              <div className="field__hint">Asks your router for hostnames.</div>
            </div>
            <div className="field__control">
              <Toggle
                label="Reverse DNS"
                checked={options.enableReverseDns}
                onChange={(value) => onChange({ enableReverseDns: value })}
              />
            </div>
          </div>

          <div className="field">
            <div>
              <div className="field__label">Discovery listen time</div>
              <div className="field__hint">
                How long to wait for UPnP and Bonjour replies. Longer finds sleepier devices.
              </div>
            </div>
            <div className="field__control">
              <select
                className="select"
                value={options.discoveryTimeoutMs}
                onChange={(event) => onChange({ discoveryTimeoutMs: Number(event.target.value) })}
              >
                <option value={3000}>3 seconds</option>
                <option value={6000}>6 seconds</option>
                <option value={10000}>10 seconds</option>
                <option value={15000}>15 seconds</option>
              </select>
            </div>
          </div>

          <div className="field">
            <div>
              <div className="field__label">Probe timeout</div>
              <div className="field__hint">Per-port connect timeout, in milliseconds.</div>
            </div>
            <div className="field__control">
              <input
                type="number"
                min={200}
                max={5000}
                step={100}
                value={options.probeTimeoutMs}
                onChange={(event) =>
                  onChange({ probeTimeoutMs: Math.max(200, Number(event.target.value) || 200) })
                }
              />
            </div>
          </div>

          <div className="field">
            <div>
              <div className="field__label">Concurrency</div>
              <div className="field__hint">
                Simultaneous sockets. Lower this if your router drops connections.
              </div>
            </div>
            <div className="field__control">
              <input
                type="number"
                min={8}
                max={256}
                step={8}
                value={options.maxConcurrency}
                onChange={(event) =>
                  onChange({ maxConcurrency: Math.max(8, Number(event.target.value) || 8) })
                }
              />
            </div>
          </div>

          <div className="field" style={{ alignItems: 'flex-start' }}>
            <div>
              <div className="field__label">Vendor database</div>
              <div className="field__hint">
                {vendorDb.loaded
                  ? `Full IEEE registry loaded — ${vendorDb.entryCount.toLocaleString()} entries, updated ${formatTimestamp(vendorDb.fetchedAt)}.`
                  : 'Using the built-in vendor list. Download the full IEEE registry from wireshark.org to name every device on your network.'}
                {vendorDb.error && ` Last attempt failed: ${vendorDb.error}`}
              </div>
            </div>
            <div className="field__control">
              <button
                type="button"
                className="btn btn--sm"
                onClick={onRefreshVendorDb}
                disabled={vendorDbBusy}
              >
                <FontAwesomeIcon icon={faCloudArrowDown} className={vendorDbBusy ? 'spin' : ''} />
                {vendorDb.loaded ? 'Update' : 'Download'}
              </button>
            </div>
          </div>

          <RouterLinkSection
            status={routerLink}
            defaultHost={gateway}
            onConnect={onConnectRouter}
            onDisconnect={onDisconnectRouter}
          />

          <div className="banner banner--info" style={{ marginTop: 16, marginBottom: 0 }}>
            <FontAwesomeIcon icon={faCircleInfo} />
            <span>
              This app only touches your own local network. Downloading the vendor database is the
              one request that leaves your LAN, and it only sends a plain file request — never any
              information about your devices.
            </span>
          </div>
        </div>

        <footer className="modal__foot">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
