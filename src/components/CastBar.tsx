import { useEffect, useMemo, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCircleExclamation,
  faDisplay,
  faPause,
  faPlay,
  faSpinner,
  faStop,
  faVolumeHigh,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import type { CastSession, Device } from '@shared/types';
import { CATEGORY_COLORS, CATEGORY_ICONS } from '../lib/icons';

interface Props {
  session: CastSession;
  devices: Device[];
  onPlay: (deviceId: string) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onSeek: (seconds: number) => void;
  onVolume: (percent: number) => void;
  onClose: () => void;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function CastBar({
  session,
  devices,
  onPlay,
  onPause,
  onResume,
  onStop,
  onSeek,
  onVolume,
  onClose,
}: Props): React.JSX.Element | null {
  const targets = useMemo(() => devices.filter((device) => device.playback), [devices]);
  const [targetId, setTargetId] = useState('');
  const [volume, setVolume] = useState(50);
  // While dragging, the slider must not be yanked back by status polling.
  const [scrubbing, setScrubbing] = useState<number | null>(null);

  // Default to the first capable device, and follow whatever is actually playing.
  useEffect(() => {
    if (session.targetId) setTargetId(session.targetId);
    else if (!targetId && targets.length > 0) setTargetId(targets[0].id);
  }, [session.targetId, targets, targetId]);

  if (!session.media) return null;

  const { media } = session;
  const busy = session.state === 'connecting';
  const active = session.state === 'playing' || session.state === 'paused';
  const duration = session.duration || 0;
  const position = scrubbing ?? session.position;
  const selected = targets.find((device) => device.id === targetId);

  return (
    <div className="cast">
      <div className="cast__file">
        <div
          className="cast__thumb"
          style={{ ['--cat-color' as string]: selected ? CATEGORY_COLORS[selected.category] : '#38bdf8' }}
        >
          <FontAwesomeIcon icon={selected ? CATEGORY_ICONS[selected.category] : faDisplay} />
        </div>
        <div className="cast__meta">
          <div className="cast__name" title={media.filePath}>
            {media.fileName}
          </div>
          <div className="cast__sub">
            {formatSize(media.size)} · {media.mimeType}
            {session.targetName ? ` · on ${session.targetName}` : ''}
          </div>
        </div>
      </div>

      {targets.length === 0 ? (
        <div className="cast__empty">
          <FontAwesomeIcon icon={faCircleExclamation} />
          No device on this network accepts video. Scan again, or check that your TV or speaker is
          switched on.
        </div>
      ) : (
        <>
          <div className="cast__controls">
            <select
              className="select"
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
              disabled={busy || active}
              aria-label="Device to play on"
            >
              {targets.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name} ({device.playback?.protocol === 'dlna' ? 'DLNA' : 'Cast'})
                </option>
              ))}
            </select>

            {!active ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => onPlay(targetId)}
                disabled={busy || !targetId}
              >
                <FontAwesomeIcon icon={busy ? faSpinner : faPlay} className={busy ? 'spin' : ''} />
                {busy ? 'Connecting…' : 'Play'}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn--icon"
                  onClick={session.state === 'playing' ? onPause : onResume}
                  title={session.state === 'playing' ? 'Pause' : 'Resume'}
                >
                  <FontAwesomeIcon icon={session.state === 'playing' ? faPause : faPlay} />
                </button>
                <button type="button" className="btn btn--icon btn--danger" onClick={onStop} title="Stop">
                  <FontAwesomeIcon icon={faStop} />
                </button>
              </>
            )}
          </div>

          <div className="cast__progress">
            <span className="cast__time mono">{formatTime(position)}</span>
            <input
              type="range"
              className="range"
              min={0}
              max={Math.max(duration, 1)}
              step={1}
              value={Math.min(position, Math.max(duration, 1))}
              disabled={!active || duration === 0}
              onChange={(event) => setScrubbing(Number(event.target.value))}
              onMouseUp={() => {
                if (scrubbing !== null) onSeek(scrubbing);
                setScrubbing(null);
              }}
              onKeyUp={() => {
                if (scrubbing !== null) onSeek(scrubbing);
                setScrubbing(null);
              }}
              aria-label="Playback position"
            />
            <span className="cast__time mono">{duration ? formatTime(duration) : '--:--'}</span>
          </div>

          <div className="cast__volume">
            <FontAwesomeIcon icon={faVolumeHigh} />
            <input
              type="range"
              className="range range--short"
              min={0}
              max={100}
              value={volume}
              onChange={(event) => setVolume(Number(event.target.value))}
              onMouseUp={() => onVolume(volume)}
              onKeyUp={() => onVolume(volume)}
              aria-label="Volume"
            />
          </div>
        </>
      )}

      <button type="button" className="detail__close" onClick={onClose} aria-label="Close player">
        <FontAwesomeIcon icon={faXmark} />
      </button>

      {session.error && (
        <div className="cast__error">
          <FontAwesomeIcon icon={faCircleExclamation} />
          {session.error}
        </div>
      )}
    </div>
  );
}
