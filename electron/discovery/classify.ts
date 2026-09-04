import type { DeviceCategory } from '../../shared/types';
import { PORT_PROFILES } from './ports';
import { mdnsProfile } from './mdns';

/** A single piece of evidence pushing a device towards one category. */
export interface Signal {
  category: DeviceCategory;
  weight: number;
  reason: string;
}

export interface ClassificationInput {
  vendor?: string;
  randomizedMac: boolean;
  /** `Server:` header from the device's own web interface. */
  httpServer?: string;
  httpTitle?: string;
  httpRealm?: string;
  manufacturer?: string;
  modelName?: string;
  friendlyName?: string;
  hostname?: string;
  upnpDeviceTypes: string[];
  upnpServiceTypes: string[];
  mdnsTypes: string[];
  mdnsTxt: Record<string, string>;
  openPorts: number[];
  isGateway: boolean;
  isSelf: boolean;
}

export interface Classification {
  category: DeviceCategory;
  confidence: number;
  signals: Signal[];
}

/**
 * Keyword rules applied to the concatenation of every name-ish string we have
 * (friendly name, model, manufacturer, hostname, mDNS TXT values).
 *
 * Ordered most specific first; every match contributes, so a "Samsung Q60
 * Series TV" picks up both the Samsung and the TV signal.
 */
const NAME_RULES: Array<{ pattern: RegExp; category: DeviceCategory; weight: number; reason: string }> = [
  // --- Media servers ---
  { pattern: /\bplex\b/i, category: 'media-server', weight: 0.95, reason: 'Plex' },
  { pattern: /\bjellyfin\b/i, category: 'media-server', weight: 0.95, reason: 'Jellyfin' },
  { pattern: /\bemby\b/i, category: 'media-server', weight: 0.95, reason: 'Emby' },
  { pattern: /\b(kodi|xbmc|osmc|libreelec)\b/i, category: 'media-server', weight: 0.9, reason: 'Kodi' },
  { pattern: /\b(minidlna|readymedia|serviio|universal media server|ums|twonky|mediatomb|gerbera)\b/i, category: 'media-server', weight: 0.95, reason: 'DLNA server software' },
  { pattern: /\bmedia\s?server\b/i, category: 'media-server', weight: 0.8, reason: 'Media server' },
  { pattern: /\b(subsonic|navidrome|airsonic|audiobookshelf)\b/i, category: 'media-server', weight: 0.9, reason: 'Music server' },

  // --- NAS ---
  { pattern: /\b(synology|diskstation|rackstation|nas\b|qnap|truenas|freenas|unraid|openmediavault|terramaster|asustor)\b/i, category: 'nas', weight: 0.92, reason: 'NAS platform' },
  { pattern: /\b(my ?cloud|wd ?my|time ?capsule)\b/i, category: 'nas', weight: 0.85, reason: 'Network storage' },

  // --- TVs ---
  { pattern: /\b(bravia|viera|aquos|regza)\b/i, category: 'tv', weight: 0.95, reason: 'TV product line' },
  { pattern: /\b(webos|netcast)\b/i, category: 'tv', weight: 0.9, reason: 'webOS TV' },
  { pattern: /\btizen\b/i, category: 'tv', weight: 0.85, reason: 'Tizen TV' },
  { pattern: /\b(smart\s?tv|smarttv|television)\b/i, category: 'tv', weight: 0.9, reason: 'Smart TV' },
  { pattern: /\b(android ?tv|google ?tv)\b/i, category: 'tv', weight: 0.85, reason: 'Android TV' },
  { pattern: /\b(oled|qled|nanocell|crystal uhd|neo qled)\b/i, category: 'tv', weight: 0.85, reason: 'TV panel type' },
  { pattern: /\bapple ?tv\b/i, category: 'tv', weight: 0.95, reason: 'Apple TV' },
  { pattern: /\btv\b/i, category: 'tv', weight: 0.45, reason: 'Named "TV"' },
  { pattern: /\b(mibox|mi ?tv|mi ?box)\b/i, category: 'tv', weight: 0.85, reason: 'Xiaomi TV' },

  // --- Streaming sticks / dongles ---
  { pattern: /\bchromecast\b/i, category: 'streaming-stick', weight: 0.95, reason: 'Chromecast' },
  { pattern: /\broku\b/i, category: 'streaming-stick', weight: 0.95, reason: 'Roku' },
  { pattern: /\bfire ?(tv|stick)\b/i, category: 'streaming-stick', weight: 0.95, reason: 'Fire TV' },
  { pattern: /\b(shield|nvidia shield)\b/i, category: 'streaming-stick', weight: 0.85, reason: 'NVIDIA Shield' },
  { pattern: /\b(nest ?hub|google ?home|google ?nest)\b/i, category: 'speaker', weight: 0.85, reason: 'Google smart display' },

  // --- Speakers ---
  { pattern: /\b(sonos|homepod|echo dot|echo show|echo studio|alexa|bose|jbl|marshall|harman)\b/i, category: 'speaker', weight: 0.88, reason: 'Smart speaker' },
  { pattern: /\b(speaker|soundbar|sound ?bar|subwoofer|av ?receiver|avr\b|denon|marantz|yamaha rx)\b/i, category: 'speaker', weight: 0.85, reason: 'Audio device' },
  { pattern: /\becho\b/i, category: 'speaker', weight: 0.7, reason: 'Amazon Echo' },

  // --- Phones & tablets ---
  { pattern: /\biphone\b/i, category: 'phone', weight: 0.97, reason: 'iPhone' },
  { pattern: /\bipad\b/i, category: 'tablet', weight: 0.97, reason: 'iPad' },
  { pattern: /\b(galaxy|sm-[agnfmsj]\d|pixel ?\d|oneplus|redmi|poco|realme|oppo|vivo|nothing phone|moto ?g|moto ?e|nokia ?\d)\b/i, category: 'phone', weight: 0.9, reason: 'Phone model' },
  { pattern: /\b(android|phone|mobile)\b/i, category: 'phone', weight: 0.55, reason: 'Mobile device' },
  { pattern: /\b(galaxy ?tab|mi ?pad|tablet)\b/i, category: 'tablet', weight: 0.9, reason: 'Tablet' },

  // --- Computers ---
  { pattern: /\b(macbook|imac|mac ?mini|mac ?pro|mac ?studio)\b/i, category: 'computer', weight: 0.95, reason: 'Mac' },
  { pattern: /\b(desktop|laptop|workstation|thinkpad|latitude|inspiron|xps|pavilion|elitebook|probook|ideapad|vivobook|zenbook|surface)\b/i, category: 'computer', weight: 0.88, reason: 'PC model' },
  { pattern: /\b(windows|win-?\d|ubuntu|debian|fedora|arch|linux|raspberrypi|raspberry pi)\b/i, category: 'computer', weight: 0.7, reason: 'Desktop OS' },
  { pattern: /\bpc\b/i, category: 'computer', weight: 0.5, reason: 'Named "PC"' },

  // --- Consoles ---
  { pattern: /\b(playstation|ps[45]\b|ps ?vita|xbox|nintendo|switch\b|wii\b)\b/i, category: 'game-console', weight: 0.95, reason: 'Game console' },

  // --- Routers / network gear ---
  { pattern: /\b(router|gateway|modem|openwrt|dd-wrt|fritz.?box|archer|nighthawk|jiofiber|airtel)\b/i, category: 'router', weight: 0.9, reason: 'Network equipment' },
  { pattern: /\binternet gateway\b/i, category: 'router', weight: 0.95, reason: 'UPnP IGD' },

  // --- Mesh nodes / access points ---
  // Kept apart from routers on purpose: a mesh network has one router and
  // several satellites, and calling every node "Router" hides the topology.
  { pattern: /\b(deco|eero|orbi|velop|unifi|omada|nest ?wifi|amplifi)\b/i, category: 'access-point', weight: 0.9, reason: 'Mesh system hardware' },
  { pattern: /\b(mesh|satellite|access ?point|repeater|extender|node ?\d)\b/i, category: 'access-point', weight: 0.8, reason: 'Mesh node / access point' },
  { pattern: /\bairport (express|extreme)\b/i, category: 'access-point', weight: 0.85, reason: 'AirPort base station' },

  // --- Printers ---
  { pattern: /\b(printer|laserjet|officejet|deskjet|envy|pixma|imageclass|ecotank|workforce|brother [dhm]l|scanner)\b/i, category: 'printer', weight: 0.93, reason: 'Printer' },

  // --- Cameras ---
  { pattern: /\b(camera|ipcam|ip ?cam|webcam|doorbell|cctv|nvr\b|dvr\b|hikvision|dahua|reolink|wyze cam|ring\b|nest cam|tapo ?c\d)\b/i, category: 'camera', weight: 0.9, reason: 'Camera' },

  // --- IoT ---
  { pattern: /\b(esp(32|8266|home)|shelly|tasmota|sonoff|tuya|smartlife|wled|zigbee|z-?wave|thermostat|hue|lifx|smart ?(plug|bulb|switch|light))\b/i, category: 'iot', weight: 0.9, reason: 'Smart-home device' },
  { pattern: /\bhome ?assistant\b/i, category: 'iot', weight: 0.9, reason: 'Home Assistant' },
];

/** UPnP `deviceType` URNs map almost one-to-one onto our categories. */
const UPNP_DEVICE_RULES: Array<{ pattern: RegExp; category: DeviceCategory; weight: number; reason: string }> = [
  { pattern: /:MediaServer:/i, category: 'media-server', weight: 0.9, reason: 'UPnP MediaServer' },
  { pattern: /:MediaRenderer:/i, category: 'tv', weight: 0.6, reason: 'UPnP MediaRenderer' },
  { pattern: /:InternetGatewayDevice:/i, category: 'router', weight: 0.95, reason: 'UPnP InternetGatewayDevice' },
  { pattern: /:WANDevice:|:WANConnectionDevice:/i, category: 'router', weight: 0.8, reason: 'UPnP WAN device' },
  { pattern: /:Printer:/i, category: 'printer', weight: 0.9, reason: 'UPnP Printer' },
  { pattern: /:Basic:/i, category: 'iot', weight: 0.15, reason: 'UPnP Basic device' },
  { pattern: /dial-multiscreen/i, category: 'tv', weight: 0.6, reason: 'DIAL (second-screen) support' },
];

/**
 * What a device's own web server says about it.
 *
 * This is direct evidence rather than inference: a box answering
 * `Server: SHIP 2.0` is a TP-Link Deco/Omada mesh node, full stop. Banners are
 * weighted highly for that reason, and they are what lets mesh satellites be
 * told apart from the router and from the clients hanging off them.
 */
const HTTP_BANNER_RULES: Array<{
  pattern: RegExp;
  category: DeviceCategory;
  weight: number;
  reason: string;
}> = [
  { pattern: /\bSHIP\b/, category: 'access-point', weight: 0.9, reason: 'TP-Link mesh/AP web server (SHIP)' },
  { pattern: /omada|eap\d|deco/i, category: 'access-point', weight: 0.9, reason: 'TP-Link Omada / Deco' },
  { pattern: /unifi|ubnt/i, category: 'access-point', weight: 0.85, reason: 'UniFi access point' },
  { pattern: /\b(ap|access ?point|repeater|range ?extender|wifi ?extender)\b/i, category: 'access-point', weight: 0.75, reason: 'Access point / extender web UI' },

  { pattern: /synology|diskstation|qnap|truenas|openmediavault/i, category: 'nas', weight: 0.9, reason: 'NAS web UI' },
  { pattern: /plex|jellyfin|emby/i, category: 'media-server', weight: 0.9, reason: 'Media server web UI' },
  { pattern: /home ?assistant|hass/i, category: 'iot', weight: 0.85, reason: 'Home Assistant' },
  { pattern: /\b(boa|goahead|thttpd|hikvision|dahua|dvrdvs|webcam|ipcam|netsurveillance)\b/i, category: 'camera', weight: 0.7, reason: 'Camera/DVR web server' },
  { pattern: /cups|ipp|laserjet|officejet|pixma|brother/i, category: 'printer', weight: 0.85, reason: 'Printer web UI' },
  { pattern: /router|gateway|modem|openwrt|dd-wrt|fritz|luci|archer|nighthawk/i, category: 'router', weight: 0.7, reason: 'Router web UI' },
  { pattern: /roku/i, category: 'streaming-stick', weight: 0.9, reason: 'Roku web endpoint' },
  { pattern: /tvos|webos|tizen|aquos|bravia/i, category: 'tv', weight: 0.85, reason: 'TV web endpoint' },
  { pattern: /esp(home|ressif)|tasmota|shelly|wled/i, category: 'iot', weight: 0.9, reason: 'Smart-home firmware' },
];

/**
 * Vendors that essentially only ship one kind of box.
 *
 * Deliberately excludes the networking brands (TP-Link, Netgear, ASUS, D-Link,
 * Ubiquiti). They also make cameras, smart plugs, mesh satellites and switches,
 * so "made by TP-Link" is not evidence of "is a router" - and the real router
 * is already identified for certain by the default-gateway check. Guessing here
 * produced a network apparently full of routers; leaving these unclassified,
 * with the vendor shown on the card, is more useful and more honest.
 */
const VENDOR_RULES: Array<{ pattern: RegExp; category: DeviceCategory; weight: number }> = [
  { pattern: /^Sonos$/i, category: 'speaker', weight: 0.85 },
  { pattern: /^Roku$/i, category: 'streaming-stick', weight: 0.9 },
  { pattern: /^Nintendo$/i, category: 'game-console', weight: 0.95 },
  { pattern: /PlayStation/i, category: 'game-console', weight: 0.95 },
  { pattern: /Xbox/i, category: 'game-console', weight: 0.8 },
  { pattern: /^(Synology|QNAP|Western Digital)$/i, category: 'nas', weight: 0.85 },
  { pattern: /printer/i, category: 'printer', weight: 0.85 },
  { pattern: /^(Espressif|Tuya|Philips Hue|Signify|Wyze|Ecobee|Shelly|Sonoff)/i, category: 'iot', weight: 0.8 },
  { pattern: /^Ring$/i, category: 'camera', weight: 0.8 },
  { pattern: /^(Hisense|TCL|Vizio|Skyworth)$/i, category: 'tv', weight: 0.6 },
  { pattern: /^(Sharp|Panasonic|LG Electronics)$/i, category: 'tv', weight: 0.35 },
  { pattern: /^(Intel|Dell|Lenovo|HP|VMware|VirtualBox|Parallels|QEMU|Hyper-V|Docker)/i, category: 'computer', weight: 0.55 },
  { pattern: /^Raspberry Pi$/i, category: 'computer', weight: 0.7 },
  { pattern: /^(OnePlus|OPPO|Vivo|Realme|Motorola|Nokia|HMD)/i, category: 'phone', weight: 0.55 },
  // Xiaomi ships as many smart-home gadgets as phones, so this is a tiebreak only.
  { pattern: /^Xiaomi/i, category: 'phone', weight: 0.2 },
];

/**
 * Apple's `_device-info` TXT `model=` value is an internal product identifier
 * (`J274AP`, `MacBookPro18,3`, `AppleTV6,2`). The prefix is enough to tell a
 * phone from a TV.
 */
const APPLE_MODEL_RULES: Array<{ pattern: RegExp; category: DeviceCategory; label: string }> = [
  { pattern: /^iPhone/i, category: 'phone', label: 'iPhone' },
  { pattern: /^iPad/i, category: 'tablet', label: 'iPad' },
  { pattern: /^(MacBook|iMac|Macmini|MacPro|Mac\d)/i, category: 'computer', label: 'Mac' },
  { pattern: /^AppleTV/i, category: 'tv', label: 'Apple TV' },
  { pattern: /^AudioAccessory/i, category: 'speaker', label: 'HomePod' },
  { pattern: /^Watch/i, category: 'iot', label: 'Apple Watch' },
  { pattern: /^AirPort|^J\d+AP$/i, category: 'router', label: 'AirPort' },
];

export function classify(input: ClassificationInput): Classification {
  const signals: Signal[] = [];
  const add = (category: DeviceCategory, weight: number, reason: string): void => {
    if (weight > 0) signals.push({ category, weight, reason });
  };

  // Router and self override everything else - we know these for a fact.
  if (input.isGateway) add('router', 1, 'Default gateway for this network');
  if (input.isSelf) add('computer', 1, 'This computer');

  const nameBlob = [
    input.friendlyName,
    input.modelName,
    input.manufacturer,
    input.hostname,
    input.vendor,
    ...Object.values(input.mdnsTxt),
  ]
    .filter(Boolean)
    .join(' | ');

  for (const rule of NAME_RULES) {
    if (rule.pattern.test(nameBlob)) add(rule.category, rule.weight, rule.reason);
  }

  for (const deviceType of [...input.upnpDeviceTypes, ...input.upnpServiceTypes]) {
    for (const rule of UPNP_DEVICE_RULES) {
      if (rule.pattern.test(deviceType)) add(rule.category, rule.weight, rule.reason);
    }
  }

  for (const type of input.mdnsTypes) {
    const profile = mdnsProfile(type);
    if (profile.category && profile.weight) {
      add(profile.category, profile.weight, `Advertises ${profile.label}`);
    }
  }

  // Collapse grouped ports down to their single strongest member first, so a
  // service that happens to listen on two ports does not vote twice.
  const strongestPerGroup = new Map<string, { profile: (typeof PORT_PROFILES)[number]; port: number }>();
  const ungrouped: Array<{ profile: (typeof PORT_PROFILES)[number]; port: number }> = [];

  for (const port of input.openPorts) {
    const profile = PORT_PROFILES.find((p) => p.port === port);
    if (!profile?.category || !profile.weight) continue;

    if (!profile.group) {
      ungrouped.push({ profile, port });
      continue;
    }
    const current = strongestPerGroup.get(profile.group);
    if (!current || (current.profile.weight ?? 0) < profile.weight) {
      strongestPerGroup.set(profile.group, { profile, port });
    }
  }

  for (const { profile, port } of [...ungrouped, ...strongestPerGroup.values()]) {
    add(profile.category!, profile.weight!, `Port ${port} open (${profile.label})`);
  }

  const banner = [input.httpServer, input.httpTitle, input.httpRealm].filter(Boolean).join(' | ');
  if (banner) {
    for (const rule of HTTP_BANNER_RULES) {
      if (rule.pattern.test(banner)) add(rule.category, rule.weight, rule.reason);
    }
  }

  if (input.vendor) {
    for (const rule of VENDOR_RULES) {
      if (rule.pattern.test(input.vendor)) add(rule.category, rule.weight, `Vendor: ${input.vendor}`);
    }
  }

  const appleModel = input.mdnsTxt.model ?? input.mdnsTxt.am ?? input.mdnsTxt.md;
  if (appleModel) {
    for (const rule of APPLE_MODEL_RULES) {
      if (rule.pattern.test(appleModel)) {
        add(rule.category, 0.9, `Apple model identifier "${appleModel}" (${rule.label})`);
      }
    }
  }

  // A randomised MAC means a modern client OS with private-address support:
  // phones, tablets and laptops. Weak on its own, useful as a tie-breaker.
  if (input.randomizedMac && !input.isGateway) {
    add('phone', 0.3, 'Randomised (private) MAC address');
  }

  if (signals.length === 0) {
    return { category: 'unknown', confidence: 0, signals };
  }

  // Score each category by its strongest signal, with diminishing credit for
  // corroborating ones. Two independent 0.6 hints should beat one 0.7 hint.
  const byCategory = new Map<DeviceCategory, number[]>();
  for (const signal of signals) {
    const list = byCategory.get(signal.category) ?? [];
    list.push(signal.weight);
    byCategory.set(signal.category, list);
  }

  let best: { category: DeviceCategory; score: number } = { category: 'unknown', score: 0 };
  const scores = new Map<DeviceCategory, number>();

  for (const [category, weights] of byCategory) {
    weights.sort((a, b) => b - a);
    let score = 0;
    weights.forEach((weight, index) => {
      score += weight * 0.5 ** index;
    });
    scores.set(category, score);
    if (score > best.score) best = { category, score };
  }

  const total = [...scores.values()].reduce((sum, value) => sum + value, 0);
  const confidence = total > 0 ? Math.min(1, (best.score / total) * Math.min(1, best.score)) : 0;

  return {
    category: best.category,
    confidence: Number(confidence.toFixed(2)),
    signals: signals.sort((a, b) => b.weight - a.weight),
  };
}

/** Emoji-free display label for a category. */
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
