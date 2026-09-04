# LAN Media Scout

An Electron desktop app that finds every device reachable on your local Wi-Fi —
TVs, phones, tablets, speakers, streaming sticks, DLNA/UPnP media servers, NAS
boxes, consoles, printers, cameras and smart-home gadgets — and tells you what
each one actually is.

Built with **Electron + TypeScript + React + Font Awesome**, no native modules.

![Stack](https://img.shields.io/badge/Electron-44-47848F) ![Stack](https://img.shields.io/badge/TypeScript-7-3178C6) ![Stack](https://img.shields.io/badge/React-19-61DAFB)

---

## Quick start

```bash
pnpm install     # or: npm install
pnpm start       # builds, then opens the app
```

Then click **Scan network**.

For development with hot reload:

```bash
pnpm dev
```

To build installers (NSIS + portable on Windows, DMG on macOS, AppImage/deb on Linux):

```bash
pnpm package
```

---

## How discovery works

Five independent techniques run against the subnet, and every result is merged
per IP address. No single method finds everything — a Chromecast answers mDNS
but not SSDP, a smart TV answers SSDP but may ignore mDNS, and a phone often
answers neither.

| Technique | What it finds | Implementation |
|---|---|---|
| **SSDP / UPnP** | DLNA media servers and renderers, smart TVs, routers (IGD), DIAL-capable devices | `M-SEARCH` multicast to `239.255.255.250:1900` plus passive `NOTIFY` listening, then the device description XML is fetched for the friendly name, manufacturer, model and icons ([ssdp.ts](electron/discovery/ssdp.ts)) |
| **mDNS / Bonjour** | Chromecast, AirPlay, Sonos, Spotify Connect, Plex, Jellyfin, printers, Macs, iPhones | The DNS-SD meta-query enumerates whatever service types the network advertises, plus ~35 direct queries for high-value types ([mdns.ts](electron/discovery/mdns.ts)) |
| **Subnet sweep (ARP)** | Everything with an IP, including silent devices that announce nothing | One UDP datagram per address makes the OS ARP for it, then the ARP cache is read. Far cheaper than 254 `ping` processes, and not blocked by the ICMP-dropping firewalls phones and TVs ship with ([arp.ts](electron/discovery/arp.ts)) |
| **Port fingerprinting** | What a device *does* — Plex on 32400, Roku on 8060, iOS lockdownd on 62078, Cast on 8009 | TCP connect probes across ~45 identifying ports ([ports.ts](electron/discovery/ports.ts)) |
| **Reverse DNS** | Hostnames your router knows about | `dns.reverse()` per host, best effort |
| **HTTP banners** | What a box says it is: mesh nodes, NAS, cameras, printers | The `Server:` header and page title from any open web port ([http.ts](electron/discovery/http.ts)) |

### Classification

[classify.ts](electron/discovery/classify.ts) fuses those signals into a weighted
score per category. Evidence comes from UPnP device types, mDNS service types
and TXT records, open ports, MAC vendor and any name-like string, and the
strongest category wins.

Two details worth knowing:

- **Related ports are grouped.** Google Cast listens on both 8008 and 8009; SMB
  on both 139 and 445. Only the strongest port per group votes, so one fact
  cannot outvote two independent ones.
- **The app says "Unknown" when it does not know.** Vendor alone is not treated
  as proof of device type — TP-Link makes routers, cameras, smart plugs and mesh
  nodes, so "made by TP-Link" earns no category guess. The real router is
  identified for certain from the default-gateway route instead.

Every device's detail pane has a **"Why we think this"** section listing the
actual signals and their weights, so a wrong guess is always inspectable.

### Mesh networks

A mesh system is one flat layer-2 network, so a phone connected to a satellite
in the back bedroom has an address in the same range as everything else and is
found by the ordinary subnet sweep — including across a wide range like a `/22`,
which mesh routers often hand out.

The satellites themselves are identified from their web-server banner rather
than guessed from their MAC: TP-Link Deco and Omada nodes answer
`Server: SHIP`, UniFi APs identify themselves, and so on. They get their own
**Mesh Node / AP** category, separate from **Router** — a mesh has one router
and several satellites, and calling every node a router hides that.

---

## Playing a video on another device

Click **Play video**, choose a file, then pick a device from the player bar and
hit Play. Devices that can receive video are marked with a green `DLNA` or
`Cast` chip on their card, and their detail pane has a **Play a video here**
button.

Nothing is uploaded anywhere. The file stays on your disk; the app starts a
small HTTP server on your LAN address and hands the receiving device a URL to
stream from ([mediaServer.ts](electron/cast/mediaServer.ts)). The server answers
`Range` requests, which is not optional — most DLNA renderers open with a
`Range: bytes=0-` probe and refuse to start if they get a `200` instead of a
`206`, and seeking does not work without it.

Two protocols are supported, both implemented directly with no extra
dependencies:

- **DLNA / UPnP AVTransport** ([dlna.ts](electron/cast/dlna.ts)) — smart TVs,
  AV receivers, media renderers. `SetAVTransportURI` with DIDL-Lite metadata,
  then `Play`. Also pause, stop, seek and volume, with `GetPositionInfo` polled
  so the progress bar tracks what is actually on screen.
- **Google Cast** ([castv2.ts](electron/cast/castv2.ts)) — Chromecast, Nest
  displays, Android TV. The CASTV2 protocol is a 4-byte length prefix plus a
  protobuf `CastMessage` with seven fields, so it is hand-encoded rather than
  pulling in a protobuf runtime for one message type. The client connects over
  TLS to port 8009, launches the Default Media Receiver, and drives it with
  `LOAD` / `PAUSE` / `PLAY` / `SEEK` / `STOP` plus the heartbeat the receiver
  requires.

When a device supports both, DLNA is preferred: Cast receivers accept a narrow
set of codecs, while a DLNA renderer generally plays whatever its own decoder
handles. If a Cast device rejects a file, the error says so — MP4/H.264 is the
safest container for Chromecast.

**MIME negotiation.** Renderers reject content whose `Content-Type` is not one
they advertised, even when they can decode it perfectly well. A Skyworth TV on
the test network advertises `audio/x-wav` and never `audio/wav`: hand it the
identical file as `audio/wav` and it downloads the whole thing, sees a type it
did not claim to support, and silently drops back to `NO_MEDIA_PRESENT`. So
before playing, the client asks the renderer's ConnectionManager for
`GetProtocolInfo` and re-serves the file under a spelling that appears in the
device's own sink list.

**If a DLNA device stays on `NO_MEDIA_PRESENT`,** the usual cause is that the TV
is in standby — many keep their renderer service running while switched off, so
the SOAP calls all succeed and the file is even fetched, but nothing is drawn
until the panel is on.

The media server binds to the LAN address on the same subnet as the target, so a
machine with both Wi-Fi and a virtual adapter (Hyper-V, WSL, VirtualBox)
advertises the address the TV can actually route to. It shuts down with the app,
so no stream outlives the window.

## Vendor names

A device's MAC prefix identifies its manufacturer. The app ships a curated table
of ~2,100 consumer OUI prefixes ([oui.ts](electron/discovery/oui.ts)), which
covers common hardware but leaves plenty of devices unnamed.

For full coverage there is a one-click download of the complete IEEE registry
(~58,000 entries, from `wireshark.org`) in **Settings → Vendor database**, cached
locally for 30 days. On a typical home network this is the difference between
half the devices showing a vendor and nearly all of them.

**It is opt-in and off by default.** It is the only request this app makes
outside your LAN, it sends nothing about your network, and everything still
works without it.

Modern phones, tablets and laptops rotate their MAC per network. The app detects
these locally-administered addresses and labels them `Private Wi-Fi address`
rather than inventing a vendor — and treats the randomisation itself as a weak
hint that the device is a personal one.

---

## Project layout

```
electron/              Main process (Node side)
  cast/
    index.ts           CastController: publish a file, drive one playback session
    mediaServer.ts     Local HTTP server with Range support
    dlna.ts            UPnP AVTransport SOAP client
    castv2.ts          Google Cast client (hand-rolled protobuf framing)
  discovery/
    index.ts           Orchestrator: runs each phase, merges signals into devices
    http.ts            HTTP banner grabbing (Server header, page title)
    ssdp.ts            SSDP/UPnP discovery + device description parsing
    mdns.ts            Bonjour/mDNS browsing
    arp.ts             Subnet sweep, ARP cache, default gateway
    ports.ts           TCP port fingerprinting
    classify.ts        Weighted device-type classification
    oui.ts             Bundled MAC vendor table + randomised-MAC detection
    vendorDb.ts        Optional full IEEE registry (download + cache)
    net.ts             IPv4/CIDR maths, TCP probes, concurrency pool
  main.ts              Window, IPC handlers, export dialog
  preload.ts           contextBridge API (bundled by esbuild)
  ipc.ts               Channel names, shared by main and preload

shared/types.ts        Types shared by both processes

src/                   React renderer
  App.tsx              Layout, filtering, sorting, keyboard shortcuts
  components/          DeviceCard, DeviceDetail, SettingsModal
  lib/                 Font Awesome icon mapping, formatting helpers
  styles.css           Dark theme

scripts/
  ensure-binaries.mjs  postinstall: restores Electron/esbuild binaries
  launch-electron.mjs  Launches Electron with a clean environment
```

---

## Notes and gotchas

**Running from a VS Code terminal.** VS Code's extension host exports
`ELECTRON_RUN_AS_NODE=1`, and every terminal it spawns inherits it. With that set,
`electron.exe` boots as plain Node and the app dies with
`Cannot read properties of undefined (reading 'isPackaged')`.
`scripts/launch-electron.mjs` strips the variable, so `pnpm start` and `pnpm dev`
behave the same inside and outside an editor. If you invoke `electron .`
directly from such a terminal, unset it first.

**Install scripts are blocked by default** in npm 12 and pnpm 10+, and both
`electron` and `esbuild` rely on theirs to place a binary. The root `postinstall`
([ensure-binaries.mjs](scripts/ensure-binaries.mjs)) restores them, and
[pnpm-workspace.yaml](pnpm-workspace.yaml) answers pnpm's `allowBuilds` prompt so
installs do not stop. Re-installing any package can wipe those binaries again;
the postinstall is idempotent and fixes it.

**Electron is pinned to `~44.1.1`** so it clears pnpm's `minimumReleaseAge`
supply-chain policy. Bump it once a newer release ages past your cutoff.

**Preload is bundled, not compiled.** With `sandbox: true` a preload script
cannot `require` relative files, so esbuild bundles it into one self-contained
file. `tsc` alone produces a preload that silently fails to expose the bridge.

**Wide subnets take longer.** A `/22` is 1,022 addresses. The scan handles it,
but you can narrow the range in Settings if it drags.

**Guest / AP-isolated networks show almost nothing.** That is the network doing
its job — client isolation blocks device-to-device traffic, so there is nothing
for any scanner to find.

---

## Security posture

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- The renderer reaches the main process only through the narrow typed API in
  [preload.ts](electron/preload.ts).
- A device's advertised URL is opened in the system browser and only if it is
  `http(s)` — a device can advertise any string it likes.
- A CSP in [index.html](src/index.html) restricts what the renderer may load.
- Only the local subnet is contacted, plus the opt-in vendor database download.

This is a passive inventory tool. It sends discovery requests and connects to
well-known ports to see what answers; it does not attempt authentication,
exploitation or any change to the devices it finds. Scan networks you are
responsible for.
