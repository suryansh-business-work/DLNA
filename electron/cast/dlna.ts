import { XMLParser } from 'fast-xml-parser';
import type { SharedMedia } from './mediaServer';

/**
 * DLNA / UPnP AVTransport control.
 *
 * Playing a file on a TV is two SOAP calls: `SetAVTransportURI` hands it a URL
 * (plus DIDL-Lite metadata, which several renderers require before they will
 * accept the URI at all), then `Play` starts it.
 */

const AVTRANSPORT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RENDERING_CONTROL = 'urn:schemas-upnp-org:service:RenderingControl:1';
const CONNECTION_MANAGER = 'urn:schemas-upnp-org:service:ConnectionManager:1';

/**
 * Equivalent MIME spellings for the same container.
 *
 * Renderers are picky and inconsistent about which name they accept. A Skyworth
 * TV, for instance, advertises `audio/x-wav` and rejects the identical file
 * offered as `audio/wav` - it downloads it, sees a type it never claimed to
 * support, and silently drops back to NO_MEDIA_PRESENT. So we ask the device
 * what it accepts and speak its spelling.
 */
const MIME_ALIASES: Record<string, string[]> = {
  'audio/wav': ['audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/L16'],
  'audio/x-wav': ['audio/wav', 'audio/wave', 'audio/vnd.wave'],
  'audio/mpeg': ['audio/mp3', 'audio/x-mpeg', 'audio/mpeg3', 'audio/x-mp3'],
  'audio/mp4': ['audio/x-m4a', 'audio/aac', 'audio/mp4a-latm'],
  'audio/flac': ['audio/x-flac'],
  'audio/ogg': ['audio/x-ogg', 'application/ogg'],
  'video/mp4': ['video/x-m4v', 'video/mpeg4', 'video/x-mp4'],
  'video/x-matroska': ['video/x-mkv', 'video/mkv', 'video/matroska'],
  'video/quicktime': ['video/mp4', 'video/x-quicktime'],
  'video/x-msvideo': ['video/avi', 'video/msvideo', 'video/x-avi'],
  'video/mp2t': ['video/mpeg', 'video/vnd.dlna.mpeg-tts', 'video/x-mpegts'],
  'video/webm': ['video/x-webm'],
  'video/x-ms-wmv': ['video/x-ms-asf', 'video/x-ms-wm'],
};

export const AVTRANSPORT_TYPE = AVTRANSPORT;
export const RENDERING_CONTROL_TYPE = RENDERING_CONTROL;

export interface TransportInfo {
  /** PLAYING, PAUSED_PLAYBACK, STOPPED, TRANSITIONING, NO_MEDIA_PRESENT … */
  state: string;
  status?: string;
}

export interface PositionInfo {
  /** Seconds elapsed. */
  position: number;
  /** Total duration in seconds, 0 when the renderer does not report one. */
  duration: number;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  // Renderers are inconsistent about namespace prefixes on SOAP responses.
  removeNSPrefix: true,
});

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * DIDL-Lite metadata describing the item. Sent doubly-escaped because it is XML
 * nested inside an XML element value - that is what the spec requires, however
 * odd it looks.
 */
function buildDidl(media: SharedMedia): string {
  const isAudio = media.mimeType.startsWith('audio/');
  const upnpClass = isAudio ? 'object.item.audioItem.musicTrack' : 'object.item.videoItem';
  const protocolInfo = `http-get:*:${media.mimeType}:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000`;

  const didl =
    `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">` +
    `<item id="${escapeXml(media.id)}" parentID="0" restricted="1">` +
    `<dc:title>${escapeXml(media.fileName)}</dc:title>` +
    `<upnp:class>${upnpClass}</upnp:class>` +
    `<res protocolInfo="${escapeXml(protocolInfo)}" size="${media.size}">${escapeXml(media.url)}</res>` +
    `</item></DIDL-Lite>`;

  return escapeXml(didl);
}

/** POSTs a SOAP action and returns the parsed response body. */
async function soap(
  controlUrl: string,
  serviceType: string,
  action: string,
  args: Record<string, string>,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${serviceType}">` +
    Object.entries(args)
      .map(([key, value]) => `<${key}>${value}</${key}>`)
      .join('') +
    `</u:${action}></s:Body></s:Envelope>`;

  const response = await fetch(controlUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${serviceType}#${action}"`,
      Connection: 'close',
    },
    body,
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(soapFault(text) ?? `${action} failed (HTTP ${response.status})`);
  }

  try {
    const parsed = parser.parse(text) as Record<string, unknown>;
    const envelope = (parsed.Envelope ?? {}) as Record<string, unknown>;
    const soapBody = (envelope.Body ?? {}) as Record<string, unknown>;
    return (soapBody[`${action}Response`] ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Pulls the human-readable reason out of a SOAP fault, when there is one. */
function soapFault(xml: string): string | undefined {
  const description = /<errorDescription>([^<]+)<\/errorDescription>/i.exec(xml)?.[1];
  const code = /<errorCode>([^<]+)<\/errorCode>/i.exec(xml)?.[1];
  if (description) return code ? `${description} (UPnP error ${code})` : description;
  if (code) return `UPnP error ${code}`;
  return undefined;
}

/** Parses `H:MM:SS` / `HH:MM:SS.mmm` into seconds. */
function parseDuration(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parts = value.split(':').map((part) => Number.parseFloat(part));
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) return 0;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export class DlnaRenderer {
  /** Sink protocolInfo the renderer advertises, fetched once and cached. */
  private sinkFormats?: Set<string>;

  constructor(
    private readonly controlUrl: string,
    private readonly renderingControlUrl?: string,
    private readonly connectionManagerUrl?: string,
  ) {}

  /**
   * The MIME type this renderer will accept for `media`, which is not always
   * the one the file actually is. Falls back to the original type when the
   * device does not tell us, since a guess is better than refusing to try.
   */
  async negotiateMimeType(mimeType: string): Promise<string> {
    const formats = await this.loadSinkFormats();
    if (!formats || formats.size === 0) return mimeType;

    if (formats.has(mimeType.toLowerCase())) return mimeType;

    for (const alias of MIME_ALIASES[mimeType.toLowerCase()] ?? []) {
      if (formats.has(alias.toLowerCase())) return alias;
    }
    return mimeType;
  }

  private async loadSinkFormats(): Promise<Set<string> | undefined> {
    if (this.sinkFormats) return this.sinkFormats;
    if (!this.connectionManagerUrl) return undefined;

    try {
      const response = await soap(this.connectionManagerUrl, CONNECTION_MANAGER, 'GetProtocolInfo', {});
      const sink = typeof response.Sink === 'string' ? response.Sink : '';
      const formats = new Set<string>();
      // Entries look like `http-get:*:audio/x-wav:*`; the MIME is field 3.
      for (const entry of sink.split(',')) {
        const mime = entry.split(':')[2]?.trim().toLowerCase();
        if (mime && mime !== '*') formats.add(mime);
      }
      this.sinkFormats = formats;
      return formats;
    } catch {
      this.sinkFormats = new Set();
      return undefined;
    }
  }

  async play(media: SharedMedia): Promise<void> {
    // Stopping first clears any previous item; renderers that are mid-playback
    // often reject a new URI outright. A failure here is not fatal.
    await this.stop().catch(() => undefined);

    const mimeType = await this.negotiateMimeType(media.mimeType);
    const offered: SharedMedia = mimeType === media.mimeType ? media : { ...media, mimeType };

    await soap(this.controlUrl, AVTRANSPORT, 'SetAVTransportURI', {
      InstanceID: '0',
      CurrentURI: escapeXml(offered.url),
      CurrentURIMetaData: buildDidl(offered),
    });

    await soap(this.controlUrl, AVTRANSPORT, 'Play', { InstanceID: '0', Speed: '1' });
  }

  async pause(): Promise<void> {
    await soap(this.controlUrl, AVTRANSPORT, 'Pause', { InstanceID: '0' });
  }

  async resume(): Promise<void> {
    await soap(this.controlUrl, AVTRANSPORT, 'Play', { InstanceID: '0', Speed: '1' });
  }

  async stop(): Promise<void> {
    await soap(this.controlUrl, AVTRANSPORT, 'Stop', { InstanceID: '0' });
  }

  async seek(seconds: number): Promise<void> {
    await soap(this.controlUrl, AVTRANSPORT, 'Seek', {
      InstanceID: '0',
      Unit: 'REL_TIME',
      Target: formatDuration(seconds),
    });
  }

  async setVolume(percent: number): Promise<void> {
    if (!this.renderingControlUrl) throw new Error('This device does not expose volume control');
    await soap(this.renderingControlUrl, RENDERING_CONTROL, 'SetVolume', {
      InstanceID: '0',
      Channel: 'Master',
      DesiredVolume: String(Math.round(Math.max(0, Math.min(100, percent)))),
    });
  }

  async getTransportInfo(): Promise<TransportInfo> {
    const response = await soap(this.controlUrl, AVTRANSPORT, 'GetTransportInfo', {
      InstanceID: '0',
    });
    return {
      state: String(response.CurrentTransportState ?? 'UNKNOWN'),
      status: response.CurrentTransportStatus ? String(response.CurrentTransportStatus) : undefined,
    };
  }

  async getPositionInfo(): Promise<PositionInfo> {
    const response = await soap(this.controlUrl, AVTRANSPORT, 'GetPositionInfo', {
      InstanceID: '0',
    });
    return {
      position: parseDuration(response.RelTime),
      duration: parseDuration(response.TrackDuration),
    };
  }
}
