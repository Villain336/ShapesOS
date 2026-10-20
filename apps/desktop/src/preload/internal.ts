// ShapesOS Desktop: the preload for our own renderers (overlay, audio, ask,
// settings). Sandboxed; exposes `window.desktop` with allow-listed channels
// only (src/shared/ipc.ts).

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { INVOKE_CHANNELS, RECEIVE_CHANNELS, SEND_CHANNELS, type DesktopBridge } from "../shared/ipc";

const bridge: DesktopBridge = {
  platform: process.platform,
  send(channel, payload) {
    if (SEND_CHANNELS.includes(channel)) ipcRenderer.send(channel, payload);
  },
  on(channel, cb) {
    if (!RECEIVE_CHANNELS.includes(channel)) return () => undefined;
    const fn = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
  invoke(channel, payload) {
    if (!INVOKE_CHANNELS.includes(channel)) return Promise.reject(new Error(`Channel not allowed: ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
};

contextBridge.exposeInMainWorld("desktop", bridge);
