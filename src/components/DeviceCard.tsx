import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faDisplay, faLocationCrosshairs, faWifi } from '@fortawesome/free-solid-svg-icons';
import type { Device } from '@shared/types';
import { CATEGORY_COLORS, CATEGORY_ICONS, CATEGORY_LABELS, brandIcon } from '../lib/icons';

interface Props {
  device: Device;
  selected: boolean;
  onSelect: (device: Device) => void;
}

const MAX_CHIPS = 3;

export function DeviceCard({ device, selected, onSelect }: Props): React.JSX.Element {
  const color = CATEGORY_COLORS[device.category];
  const brand = brandIcon(device.vendor, device.manufacturer, device.model, device.name);
  const chips = device.services.slice(0, MAX_CHIPS);
  const extraChips = device.services.length - chips.length;

  return (
    <button
      type="button"
      className={`card${selected ? ' card--selected' : ''}`}
      style={{ ['--cat-color' as string]: color }}
      onClick={() => onSelect(device)}
      aria-pressed={selected}
    >
      <div className="card__icon">
        <FontAwesomeIcon icon={brand ?? CATEGORY_ICONS[device.category]} />
      </div>

      <div className="card__body">
        <div className="card__title">
          <span className={`card__dot${device.online ? '' : ' card__dot--off'}`} />
          <span className="card__name" title={device.name}>
            {device.name}
          </span>
        </div>

        <div className="card__meta">
          <span className="card__ip mono">{device.ip}</span>
          {device.vendor && (
            <>
              <span className="card__sep">•</span>
              <span>{device.vendor}</span>
            </>
          )}
          {device.isGateway && (
            <>
              <span className="card__sep">•</span>
              <FontAwesomeIcon icon={faWifi} title="Default gateway" />
            </>
          )}
          {device.isSelf && (
            <>
              <span className="card__sep">•</span>
              <FontAwesomeIcon icon={faLocationCrosshairs} title="This computer" />
            </>
          )}
        </div>

        <div className="card__chips">
          <span className="chip chip--cat">{CATEGORY_LABELS[device.category]}</span>
          {device.playback && (
            <span
              className="chip chip--cast"
              title={
                device.playback.protocol === 'dlna'
                  ? 'Can play a video sent over DLNA'
                  : 'Can play a video sent over Google Cast'
              }
            >
              <FontAwesomeIcon icon={faDisplay} />
              {device.playback.protocol === 'dlna' ? 'DLNA' : 'Cast'}
            </span>
          )}
          {chips.map((service) => (
            <span key={service.id} className="chip">
              {service.label}
            </span>
          ))}
          {extraChips > 0 && <span className="chip chip--more">+{extraChips}</span>}
          {device.services.length === 0 && device.openPorts.length > 0 && (
            <span className="chip">
              {device.openPorts.length} open port{device.openPorts.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
