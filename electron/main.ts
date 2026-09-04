import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Device, RouterLinkStatus, ScanOptions } from '../shared/types';
import { EMPTY_ROUTER_LINK } from '../shared/types';
import { AUDIO_EXTENSIONS, CastController, VIDEO_EXTENSIONS } from './cast';
import { DiscoveryManager } from './discovery';
import { listInterfaces } from './discovery/net';
import { VendorDatabase } from './discovery/vendorDb';
import { RouterLink } from './router';
import { IPC } from './ipc';

// Only `npm run dev` points at the Vite server. A plain unpackaged run
// (`npm start`) loads the built bundle, so it does not hang on a dev server
// that was never started.
const isDev = process.env.NODE_ENV === 'development';
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';

const discovery = new DiscoveryManager();
const cast = new CastController(() => discovery.getDevices());
let vendorDb: VendorDatabase | null = null;
let routerLink: RouterLink | null = null;
let mainWindow: BrowserWindow | null = null;

/**
 * The LAN address a receiving device can reach us on.
 *
 * Prefers the adapter whose subnet contains the target, so a machine with both
 * Wi-Fi and a virtual adapter advertises the address the TV can actually route
 * to rather than, say, a Hyper-V one.
 */
function localAddressFor(targetIp?: string): string {
  const interfaces = listInterfaces();
  if (interfaces.length === 0) throw new Error('No active network interface');

  if (targetIp) {
    const targetPrefix = targetIp.split('.').slice(0, 3).join('.');
    const sameSubnet = interfaces.find(
      (iface) => iface.address.split('.').slice(0, 3).join('.') === targetPrefix,
    );
    if (sameSubnet) return sameSubnet.address;
  }
  return interfaces[0].address;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b0f17',
    title: 'LAN Media Scout',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    const bundle = path.join(__dirname, '../renderer/index.html');
    if (!existsSync(bundle)) {
      dialog.showErrorBox(
        'Renderer not built',
        `Could not find ${bundle}.\n\nRun "npm run build" before "electron .", or use "npm start".`,
      );
      app.quit();
      return;
    }
    void mainWindow.loadFile(bundle);
  }

  // Device web UIs open in the real browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function forwardToRenderer(): void {
  discovery.on('devices', (devices: Device[]) => {
    if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send(IPC.devicesChanged, devices);
  });
  discovery.on('status', (status) => {
    if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send(IPC.statusChanged, status);
  });
  cast.on('session', (session) => {
    if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send(IPC.castSessionChanged, session);
  });
}

function registerIpc(): void {
  ipcMain.handle(IPC.getInterfaces, () => discovery.getInterfaces());
  ipcMain.handle(IPC.getDevices, () => discovery.getDevices());
  ipcMain.handle(IPC.getStatus, () => discovery.getStatus());

  ipcMain.handle(IPC.startScan, async (_event, options: Partial<ScanOptions> | undefined) => {
    await discovery.scan(options ?? {});
  });

  ipcMain.handle(IPC.stopScan, () => {
    discovery.stop();
  });

  ipcMain.handle(IPC.openExternal, async (_event, url: unknown) => {
    // Only ever hand http(s) to the OS - a device could advertise anything.
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle(IPC.getVendorDbStatus, () => vendorDb?.status ?? { loaded: false, entryCount: 0, source: 'bundled' as const });

  ipcMain.handle(IPC.refreshVendorDb, async () => {
    if (!vendorDb) return { loaded: false, entryCount: 0, source: 'bundled' as const };
    const status = await vendorDb.refresh();
    if (status.loaded) discovery.setVendorLookup((mac) => vendorDb!.lookup(mac));
    return status;
  });

  /* -------------------------------------------------------------- casting */

  ipcMain.handle(IPC.pickMedia, async () => {
    if (!mainWindow) return null;

    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a video to play on another device',
      properties: ['openFile'],
      filters: [
        { name: 'Video', extensions: VIDEO_EXTENSIONS },
        { name: 'Audio', extensions: AUDIO_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    });

    if (canceled || filePaths.length === 0) return null;
    return cast.prepare(filePaths[0], localAddressFor());
  });

  ipcMain.handle(IPC.castPlay, async (_event, deviceId: unknown) => {
    if (typeof deviceId !== 'string') throw new Error('No device selected');

    // Re-publish on the address that reaches this particular device.
    const target = discovery.getDevices().find((device) => device.id === deviceId);
    const session = cast.getSession();
    if (session.media) {
      await cast.prepare(session.media.filePath, localAddressFor(target?.ip));
    }

    await cast.play(deviceId);
  });

  ipcMain.handle(IPC.castPause, () => cast.pause());
  ipcMain.handle(IPC.castResume, () => cast.resume());
  ipcMain.handle(IPC.castStop, () => cast.stop());
  ipcMain.handle(IPC.castSeek, (_event, seconds: unknown) =>
    cast.seek(typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 0),
  );
  ipcMain.handle(IPC.castVolume, (_event, percent: unknown) =>
    cast.setVolume(typeof percent === 'number' && Number.isFinite(percent) ? percent : 50),
  );
  ipcMain.handle(IPC.getCastSession, () => cast.getSession());

  /* --------------------------------------------------------- router link */

  /** Pushes the router's client -> mesh-node map into the discovery engine. */
  const applyUplinks = (): void => {
    const snapshot = routerLink?.getSnapshot();
    if (!snapshot) return;

    discovery.setUplinks(
      snapshot.clients
        .filter((client) => client.nodeMac)
        .map((client) => ({
          clientMac: client.mac,
          nodeMac: client.nodeMac!,
          kind: client.wireType ?? client.connection,
        })),
    );
  };

  const publishRouterStatus = (status: RouterLinkStatus): RouterLinkStatus => {
    if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send(IPC.routerLinkChanged, status);
    return status;
  };

  ipcMain.handle(IPC.getRouterLink, () => routerLink?.status ?? EMPTY_ROUTER_LINK);

  ipcMain.handle(IPC.connectRouter, async (_event, payload: unknown) => {
    if (!routerLink) return EMPTY_ROUTER_LINK;

    const { host, password, remember } = (payload ?? {}) as Record<string, unknown>;
    if (typeof host !== 'string' || typeof password !== 'string') {
      throw new TypeError('A router address and password are required');
    }

    const status = await routerLink.connect(host.trim(), password, remember === true);
    applyUplinks();
    return publishRouterStatus(status);
  });

  ipcMain.handle(IPC.refreshRouter, async () => {
    if (!routerLink) return EMPTY_ROUTER_LINK;
    const status = await routerLink.refresh();
    applyUplinks();
    return publishRouterStatus(status);
  });

  ipcMain.handle(IPC.disconnectRouter, async () => {
    if (!routerLink) return EMPTY_ROUTER_LINK;
    const status = await routerLink.disconnect();
    discovery.setUplinks([]);
    return publishRouterStatus(status);
  });

  // A scan is the natural moment to re-read the router, so associations stay
  // in step with the device list rather than drifting behind it.
  discovery.on('status', (status) => {
    if (status.phase === 'done' && !status.running && routerLink?.status.configured) {
      void routerLink.refresh().then((next) => {
        applyUplinks();
        publishRouterStatus(next);
      });
    }
  });

  ipcMain.handle(IPC.exportJson, async (_event, devices: Device[]) => {
    if (!mainWindow) return { saved: false };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export discovered devices',
      defaultPath: `lan-devices-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });

    if (canceled || !filePath) return { saved: false };

    await writeFile(
      filePath,
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          app: `LAN Media Scout ${app.getVersion()}`,
          interfaces: discovery.getInterfaces(),
          deviceCount: Array.isArray(devices) ? devices.length : 0,
          devices,
        },
        null,
        2,
      ),
      'utf8',
    );

    return { saved: true, path: filePath };
  });
}

// Raw sockets and multicast need a single instance to avoid port contention.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    vendorDb = new VendorDatabase(app.getPath('userData'));
    routerLink = new RouterLink(app.getPath('userData'));
    // Reuse a previously downloaded registry if one is cached. Nothing is
    // fetched here - a download only happens when the user asks for it.
    const cached = await vendorDb.loadFromCache();
    if (cached.loaded) discovery.setVendorLookup((mac) => vendorDb!.lookup(mac));

    // Pick up a router the user linked previously. The first scan then already
    // has the mesh associations rather than gaining them a beat later.
    const saved = await routerLink.loadSaved();
    if (saved.configured) void routerLink.refresh();

    registerIpc();
    forwardToRenderer();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    discovery.stop();
    // Stops playback and closes the media server so no stream outlives the app.
    void cast.dispose().finally(() => {
      if (process.platform !== 'darwin') app.quit();
    });
  });
}
