import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCircleInfo,
  faCloudArrowDown,
  faGear,
  faTriangleExclamation,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import type { NetworkInterfaceInfo, ScanOptions, VendorDbStatus } from '@shared/types';
import { formatTimestamp } from '../lib/format';

interface Props {
  options: ScanOptions;
  onChange: (patch: Partial<ScanOptions>) => void;
  interfaces: NetworkInterfaceInfo[];
  subnet?: string;
  vendorDb: VendorDbStatus;
  vendorDbBusy: boolean;
  onRefreshVendorDb: () => void;
  onClose: () => void;
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
