import { EventEmitter } from 'node:events';
import type { CastSession, Device, SelectedMedia } from '../../shared/types';
import { EMPTY_CAST_SESSION } from '../../shared/types';
import { ChromecastClient } from './castv2';
import { DlnaRenderer } from './dlna';
import { MediaServer } from './mediaServer';

export interface CastEvents {
  session: [CastSession];
}

/** How often to ask the receiver where it is up to, while it is playing. */
const POLL_INTERVAL_MS = 1500;

/**
 * Owns the "play this file over there" flow: it publishes the chosen file on a
 * local HTTP server, hands the URL to whichever device the user picked, and
 * keeps one session's worth of transport state.
 *
 * Only one playback session exists at a time, which matches how people actually
 * use this - pick a video, pick a screen, watch it.
 */
export class CastController extends EventEmitter<CastEvents> {
  private readonly server = new MediaServer('127.0.0.1');
  private session: CastSession = { ...EMPTY_CAST_SESSION };
  private dlna?: DlnaRenderer;
  private chromecast?: ChromecastClient;
  private poll?: NodeJS.Timeout;

  /** Supplies the current device list; injected to avoid a circular import. */
  constructor(private readonly getDevices: () => Device[]) {
    super();
  }

  getSession(): CastSession {
    return { ...this.session };
  }

  private update(patch: Partial<CastSession>): void {
    this.session = { ...this.session, ...patch };
    this.emit('session', this.getSession());
  }

  /**
   * Publishes a file for playback. The media server binds to the LAN address of
   * the adapter that reaches the target, because a receiver cannot fetch from
   * 127.0.0.1.
   */
  async prepare(filePath: string, hostAddress: string): Promise<SelectedMedia> {
    await this.server.start(hostAddress);
    const media = await this.server.share(filePath);
    this.update({ media, state: 'idle', position: 0, duration: 0, error: undefined });
    return media;
  }

  async play(deviceId: string): Promise<void> {
    const media = this.session.media;
    if (!media) throw new Error('Choose a video first');

    const device = this.getDevices().find((candidate) => candidate.id === deviceId);
    if (!device) throw new Error('That device is no longer on the network');
    if (!device.playback) throw new Error(`${device.name} cannot be sent a video to play`);

    await this.teardownTransport();
    this.update({
      state: 'connecting',
      targetId: device.id,
      targetName: device.name,
      protocol: device.playback.protocol,
      position: 0,
      duration: 0,
      error: undefined,
    });

    try {
      if (device.playback.protocol === 'dlna') {
        if (!device.playback.controlUrl) throw new Error('This device did not advertise a control URL');
        this.dlna = new DlnaRenderer(
          device.playback.controlUrl,
          device.playback.renderingControlUrl,
          device.playback.connectionManagerUrl,
        );

        // Serve the file under a MIME type this renderer actually claims to
        // accept, otherwise it fetches the file and then discards it.
        const accepted = await this.dlna.negotiateMimeType(media.mimeType);
        if (accepted !== media.mimeType) {
          this.server.setMimeType(media.id, accepted);
          this.update({ media: { ...media, mimeType: accepted } });
        }

        await this.dlna.play({ ...media, mimeType: accepted });
      } else {
        this.chromecast = new ChromecastClient(device.ip);
        await this.chromecast.play(media);
      }
      this.update({ state: 'playing' });
      this.startPolling();
    } catch (error) {
      await this.teardownTransport();
      this.update({ state: 'error', error: (error as Error).message });
      throw error;
    }
  }

  async pause(): Promise<void> {
    if (this.dlna) await this.dlna.pause();
    else if (this.chromecast) await this.chromecast.pause();
    else return;
    this.update({ state: 'paused' });
  }

  async resume(): Promise<void> {
    if (this.dlna) await this.dlna.resume();
    else if (this.chromecast) await this.chromecast.resume();
    else return;
    this.update({ state: 'playing' });
  }

  async stop(): Promise<void> {
    if (this.dlna) await this.dlna.stop().catch(() => undefined);
    if (this.chromecast) await this.chromecast.stop().catch(() => undefined);
    await this.teardownTransport();
    this.update({ state: 'stopped', position: 0 });
  }

  async seek(seconds: number): Promise<void> {
    if (this.dlna) await this.dlna.seek(seconds);
    else if (this.chromecast) await this.chromecast.seek(seconds);
    else return;
    this.update({ position: seconds });
  }

  async setVolume(percent: number): Promise<void> {
    if (this.dlna) await this.dlna.setVolume(percent);
    else if (this.chromecast) await this.chromecast.setVolume(percent);
  }

  /** Polls the receiver so the progress bar reflects what is on screen. */
  private startPolling(): void {
    this.stopPolling();
    this.poll = setInterval(() => {
      void this.refresh();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  private async refresh(): Promise<void> {
    try {
      if (this.dlna) {
        const [transport, position] = await Promise.all([
          this.dlna.getTransportInfo(),
          this.dlna.getPositionInfo(),
        ]);

        const state =
          transport.state === 'PLAYING'
            ? 'playing'
            : transport.state === 'PAUSED_PLAYBACK'
              ? 'paused'
              : transport.state === 'STOPPED' || transport.state === 'NO_MEDIA_PRESENT'
                ? 'stopped'
                : this.session.state;

        this.update({ state, position: position.position, duration: position.duration });
        if (state === 'stopped') this.stopPolling();
        return;
      }

      if (this.chromecast) {
        const status = await this.chromecast.refreshStatus();
        const state =
          status.state === 'PLAYING'
            ? 'playing'
            : status.state === 'PAUSED'
              ? 'paused'
              : status.state === 'IDLE'
                ? 'stopped'
                : this.session.state;

        this.update({ state, position: status.position, duration: status.duration });
        if (state === 'stopped') this.stopPolling();
      }
    } catch {
      // A dropped poll is normal while a renderer buffers or switches inputs.
      // Playback state is only changed when the device actually tells us so.
    }
  }

  private async teardownTransport(): Promise<void> {
    this.stopPolling();
    this.dlna = undefined;
    this.chromecast?.close();
    this.chromecast = undefined;
  }

  /** Stops playback and shuts the media server down. */
  async dispose(): Promise<void> {
    await this.stop().catch(() => undefined);
    await this.server.stop();
  }
}

export { VIDEO_EXTENSIONS, AUDIO_EXTENSIONS } from './mediaServer';
