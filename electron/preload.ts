import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CastSession, Device, LanScoutApi, ScanOptions, ScanStatus } from '../shared/types';
import { IPC } from './ipc';

/**
 * Subscribes to a main-process broadcast and returns an unsubscribe function,
 * so React effects can clean up without leaking listeners across re-renders.
 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: LanScoutApi = {
  getInterfaces: () => ipcRenderer.invoke(IPC.getInterfaces),
  startScan: (options?: Partial<ScanOptions>) => ipcRenderer.invoke(IPC.startScan, options),
  stopScan: () => ipcRenderer.invoke(IPC.stopScan),
  getDevices: () => ipcRenderer.invoke(IPC.getDevices),
  getStatus: () => ipcRenderer.invoke(IPC.getStatus),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  exportJson: (devices: Device[]) => ipcRenderer.invoke(IPC.exportJson, devices),
  getVendorDbStatus: () => ipcRenderer.invoke(IPC.getVendorDbStatus),
  refreshVendorDb: () => ipcRenderer.invoke(IPC.refreshVendorDb),

  pickMedia: () => ipcRenderer.invoke(IPC.pickMedia),
  castPlay: (deviceId: string) => ipcRenderer.invoke(IPC.castPlay, deviceId),
  castPause: () => ipcRenderer.invoke(IPC.castPause),
  castResume: () => ipcRenderer.invoke(IPC.castResume),
  castStop: () => ipcRenderer.invoke(IPC.castStop),
  castSeek: (seconds: number) => ipcRenderer.invoke(IPC.castSeek, seconds),
  castVolume: (percent: number) => ipcRenderer.invoke(IPC.castVolume, percent),
  getCastSession: () => ipcRenderer.invoke(IPC.getCastSession),
  onDevices: (callback) => subscribe<Device[]>(IPC.devicesChanged, callback),
  onStatus: (callback) => subscribe<ScanStatus>(IPC.statusChanged, callback),
  onCastSession: (callback) => subscribe<CastSession>(IPC.castSessionChanged, callback),
  platform: process.platform,
  appVersion: process.env.npm_package_version ?? '1.0.0',
};

contextBridge.exposeInMainWorld('lanScout', api);
