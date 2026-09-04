import { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChevronDown,
  faChevronRight,
  faCircleNodes,
  faCode,
  faDiagramProject,
  faFingerprint,
  faLayerGroup,
  faPlay,
  faSignal,
  faUpRightFromSquare,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import type { Device } from '@shared/types';
import { CATEGORY_COLORS, CATEGORY_ICONS, CATEGORY_LABELS, brandIcon } from '../lib/icons';
import { SOURCE_LABELS, formatLatency, formatTimestamp } from '../lib/format';

interface Props {
  device: Device;
  onClose: () => void;
  onCast: (deviceId: string) => void;
}

interface Signal {
  category: string;
  weight: number;
  reason: string;
}

export function DeviceDetail({ device, onClose, onCast }: Props): React.JSX.Element {
  const [openService, setOpenService] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  const color = CATEGORY_COLORS[device.category];
  const brand = brandIcon(device.vendor, device.manufacturer, device.model, device.name);
  const signals = (device.raw.classificationSignals ?? []) as Signal[];

  const openUrl = (url: string): void => {
    void window.lanScout.openExternal(url);
  };

  return (
    <aside className="detail" style={{ ['--cat-color' as string]: color }}>
      <header className="detail__head">
        <div className="card__icon">
          <FontAwesomeIcon icon={brand ?? CATEGORY_ICONS[device.category]} />
        </div>
        <div className="detail__title">
          <h2>{device.name}</h2>
          <p className="mono">
            {device.ip}
            {device.mac ? ` · ${device.mac}` : ''}
          </p>
        </div>
        <button type="button" className="detail__close" onClick={onClose} aria-label="Close details">
          <FontAwesomeIcon icon={faXmark} />
        </button>
      </header>

      <div className="detail__scroll">
        <section className="section">
          <h3 className="section__title">
            <FontAwesomeIcon icon={faFingerprint} />
            Identity
          </h3>
          <dl className="kv">
            <dt>Type</dt>
            <dd>{CATEGORY_LABELS[device.category]}</dd>

            <dt>Confidence</dt>
            <dd>
              <div className="confidence">
                <div className="confidence__track">
                  <div
                    className="confidence__fill"
                    style={{ width: `${Math.round(device.confidence * 100)}%` }}
                  />
                </div>
                <span>{Math.round(device.confidence * 100)}%</span>
              </div>
            </dd>

            {device.vendor && (
              <>
                <dt>Vendor</dt>
                <dd>{device.vendor}</dd>
              </>
            )}
            {device.manufacturer && device.manufacturer !== device.vendor && (
              <>
                <dt>Manufacturer</dt>
                <dd>{device.manufacturer}</dd>
              </>
            )}
            {device.model && (
              <>
                <dt>Model</dt>
                <dd>{device.model}</dd>
              </>
            )}
            {device.hostname && (
              <>
                <dt>Hostname</dt>
                <dd className="mono">{device.hostname}</dd>
              </>
            )}
            {device.os && (
              <>
                <dt>OS</dt>
                <dd>{device.os}</dd>
              </>
            )}
            {device.httpServer && (
              <>
                <dt>Web server</dt>
                <dd className="mono">{device.httpServer}</dd>
              </>
            )}
            {device.httpTitle && (
              <>
                <dt>Page title</dt>
                <dd>{device.httpTitle}</dd>
              </>
            )}
          </dl>
        </section>

        <section className="section">
          <h3 className="section__title">
            <FontAwesomeIcon icon={faCircleNodes} />
            Network
          </h3>
          <dl className="kv">
            <dt>IP address</dt>
            <dd className="mono">{device.ip}</dd>

            <dt>MAC address</dt>
            <dd className="mono">{device.mac ?? 'Not visible'}</dd>

            <dt>Status</dt>
            <dd style={{ color: device.online ? 'var(--ok)' : 'var(--text-dim)' }}>
              {device.online ? 'Responding' : 'No response'}
            </dd>

            <dt>Latency</dt>
            <dd>{formatLatency(device.latencyMs)}</dd>

            <dt>Role</dt>
            <dd>
              {device.isGateway ? 'Default gateway' : device.isSelf ? 'This computer' : 'Client'}
            </dd>

            <dt>Last seen</dt>
            <dd>{formatTimestamp(device.lastSeen)}</dd>
          </dl>

          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {device.playback && (
              <button type="button" className="btn btn--primary btn--sm" onClick={() => onCast(device.id)}>
                <FontAwesomeIcon icon={faPlay} />
                Play a video here
              </button>
            )}
            {device.presentationUrl && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => openUrl(device.presentationUrl!)}
              >
                <FontAwesomeIcon icon={faUpRightFromSquare} />
                Open web interface
              </button>
            )}
          </div>
        </section>

        <section className="section">
          <h3 className="section__title">
            <FontAwesomeIcon icon={faSignal} />
            Found via
          </h3>
          <div className="card__chips">
            {device.sources.map((source) => (
              <span key={source} className="chip chip--accent">
                {SOURCE_LABELS[source]}
              </span>
            ))}
          </div>
        </section>

        {device.services.length > 0 && (
          <section className="section">
            <h3 className="section__title">
              <FontAwesomeIcon icon={faLayerGroup} />
              Services ({device.services.length})
            </h3>
            <div className="list">
              {device.services.map((service) => {
                const expanded = openService === service.id;
                const hasDetail = service.detail && Object.keys(service.detail).length > 0;
                return (
                  <div key={service.id} className="svc">
                    <button
                      type="button"
                      className="svc__head"
                      onClick={() => setOpenService(expanded ? null : service.id)}
                      disabled={!hasDetail}
                      style={{ cursor: hasDetail ? 'pointer' : 'default' }}
                    >
                      {hasDetail && (
                        <FontAwesomeIcon
                          icon={expanded ? faChevronDown : faChevronRight}
                          style={{ fontSize: 10, color: 'var(--text-dim)' }}
                        />
                      )}
                      <span className="svc__proto">{service.protocol.toUpperCase()}</span>
                      <span className="svc__label">{service.label}</span>
                      {service.port !== undefined && <span className="svc__port mono">:{service.port}</span>}
                    </button>
                    {expanded && hasDetail && (
                      <dl className="svc__detail mono">
                        {Object.entries(service.detail!).map(([key, value]) => (
                          <div key={key} style={{ display: 'contents' }}>
                            <dt>{key}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {device.openPorts.length > 0 && (
          <section className="section">
            <h3 className="section__title">
              <FontAwesomeIcon icon={faDiagramProject} />
              Open ports ({device.openPorts.length})
            </h3>
            <div className="ports">
              {device.openPorts.map((port) => (
                <span key={port.port} className="port mono">
                  <b>{port.port}</b>
                  <span>{port.label}</span>
                </span>
              ))}
            </div>
          </section>
        )}

        {signals.length > 0 && (
          <section className="section">
            <h3 className="section__title">
              <FontAwesomeIcon icon={faFingerprint} />
              Why we think this
            </h3>
            <div className="list">
              {signals.slice(0, 8).map((signal) => (
                <div key={`${signal.category}-${signal.reason}`} className="signal">
                  <span className="signal__weight">{signal.weight.toFixed(2)}</span>
                  <span className="signal__reason">{signal.reason}</span>
                  <span className="signal__cat">
                    → {CATEGORY_LABELS[signal.category as keyof typeof CATEGORY_LABELS] ?? signal.category}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="section">
          <h3 className="section__title">
            <FontAwesomeIcon icon={faCode} />
            Raw discovery data
          </h3>
          <button type="button" className="btn btn--sm" onClick={() => setShowRaw((value) => !value)}>
            <FontAwesomeIcon icon={showRaw ? faChevronDown : faChevronRight} />
            {showRaw ? 'Hide' : 'Show'} JSON
          </button>
          {showRaw && (
            <pre className="raw mono" style={{ marginTop: 10 }}>
              {JSON.stringify(device.raw, null, 2)}
            </pre>
          )}
        </section>
      </div>
    </aside>
  );
}
