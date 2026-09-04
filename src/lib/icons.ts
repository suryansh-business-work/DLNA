import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faAmazon,
  faAndroid,
  faApple,
  faChromecast,
  faGoogle,
  faLinux,
  faMicrosoft,
  faPlaystation,
  faRaspberryPi,
  faSpotify,
  faUbuntu,
  faWindows,
  faXbox,
} from '@fortawesome/free-brands-svg-icons';
import {
  faCamera,
  faCircleQuestion,
  faDesktop,
  faFilm,
  faGamepad,
  faHardDrive,
  faLightbulb,
  faMobileScreenButton,
  faPrint,
  faSatelliteDish,
  faTowerBroadcast,
  faTabletScreenButton,
  faTv,
  faVolumeHigh,
  faWifi,
} from '@fortawesome/free-solid-svg-icons';
import type { DeviceCategory } from '@shared/types';

export const CATEGORY_ICONS: Record<DeviceCategory, IconDefinition> = {
  tv: faTv,
  phone: faMobileScreenButton,
  tablet: faTabletScreenButton,
  'media-server': faFilm,
  speaker: faVolumeHigh,
  'streaming-stick': faSatelliteDish,
  'game-console': faGamepad,
  computer: faDesktop,
  nas: faHardDrive,
  router: faWifi,
  'access-point': faTowerBroadcast,
  printer: faPrint,
  camera: faCamera,
  iot: faLightbulb,
  unknown: faCircleQuestion,
};

export const CATEGORY_LABELS: Record<DeviceCategory, string> = {
  tv: 'TV',
  phone: 'Phone',
  tablet: 'Tablet',
  'media-server': 'Media Server',
  speaker: 'Speaker',
  'streaming-stick': 'Streaming Device',
  'game-console': 'Game Console',
  computer: 'Computer',
  nas: 'NAS / Storage',
  router: 'Router',
  'access-point': 'Mesh / AP',
  printer: 'Printer',
  camera: 'Camera',
  iot: 'Smart Home',
  unknown: 'Unknown',
};

/** Category accent colours, mirroring the `--cat-*` custom properties. */
export const CATEGORY_COLORS: Record<DeviceCategory, string> = {
  tv: '#a78bfa',
  phone: '#34d399',
  tablet: '#2dd4bf',
  'media-server': '#f472b6',
  speaker: '#fb923c',
  'streaming-stick': '#c084fc',
  'game-console': '#60a5fa',
  computer: '#38bdf8',
  nas: '#f59e0b',
  router: '#facc15',
  'access-point': '#fbbf24',
  printer: '#94a3b8',
  camera: '#fb7185',
  iot: '#4ade80',
  unknown: '#64748b',
};

/** Order used for the stat row and the category filter. */
export const CATEGORY_ORDER: DeviceCategory[] = [
  'tv',
  'phone',
  'tablet',
  'media-server',
  'speaker',
  'streaming-stick',
  'game-console',
  'computer',
  'nas',
  'router',
  'access-point',
  'printer',
  'camera',
  'iot',
  'unknown',
];

const BRAND_MATCHERS: Array<{ pattern: RegExp; icon: IconDefinition }> = [
  { pattern: /apple|iphone|ipad|macbook|imac|homepod/i, icon: faApple },
  { pattern: /google|nest|chromecast/i, icon: faChromecast },
  { pattern: /android|samsung|xiaomi|oneplus|oppo|vivo|realme|motorola/i, icon: faAndroid },
  { pattern: /amazon|echo|fire ?tv|kindle/i, icon: faAmazon },
  { pattern: /playstation|sony interactive/i, icon: faPlaystation },
  { pattern: /xbox/i, icon: faXbox },
  { pattern: /microsoft|windows/i, icon: faWindows },
  { pattern: /raspberry/i, icon: faRaspberryPi },
  { pattern: /ubuntu/i, icon: faUbuntu },
  { pattern: /linux|debian|fedora|arch/i, icon: faLinux },
  { pattern: /spotify/i, icon: faSpotify },
];

/**
 * A brand glyph for the vendor, when one exists. Returned alongside - not
 * instead of - the category icon, so the card always shows what a device *is*
 * even when we also know who made it.
 */
export function brandIcon(...hints: Array<string | undefined>): IconDefinition | undefined {
  const blob = hints.filter(Boolean).join(' ');
  if (!blob) return undefined;
  return BRAND_MATCHERS.find((matcher) => matcher.pattern.test(blob))?.icon;
}

export { faGoogle, faMicrosoft };
export type { IconDefinition };
