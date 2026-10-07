// ShapesOS Desktop: windows.
//
//   * main     — ShapesOS itself at the configured URL, partition
//                persist:shapesos, contextIsolation + sandbox, no
//                nodeIntegration, the small page bridge preload.
//   * overlay  — one per display: transparent, frameless, always on top,
//                click-through (setIgnoreMouseEvents with forwarding), never
//                focusable, excluded from screen capture.
//   * audio    — hidden: microphone → STT socket, and TTS playback.
//   * ask      — the typing fallback, a small input near the cursor.
//   * settings — preferences and permissions.

import { app, BrowserWindow, screen, session, shell, type Session } from "electron";
import { join } from "node:path";

export const MAIN_PARTITION = "persist:shapesos";

const dist = (...p: string[]) => join(__dirname, "..", ...p);

export function rendererFile(name: string): string {
  return dist("renderer", `${name}.html`);
}

function internalPreload(): string {
  return dist("preload", "internal.js");
}

function isSameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** Lock down the ShapesOS partition: only what the web app needs. */
export function hardenMainSession(serverUrl: () => string): Session {
  const ses = session.fromPartition(MAIN_PARTITION);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = details.requestingUrl || wc.getURL();
    const own = isSameOrigin(origin, serverUrl());
    const allowed = new Set(["notifications", "clipboard-sanitized-write", "fullscreen", "media"]);
    callback(own && allowed.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    return isSameOrigin(origin, serverUrl()) && ["notifications", "clipboard-sanitized-write", "media"].includes(permission);
  });
  return ses;
}

export function createMainWindow(serverUrl: () => string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "ShapesOS",
    backgroundColor: "#F3F3F1", // canvas token: first paint before the page loads
    webPreferences: {
      partition: MAIN_PARTITION,
      preload: dist("preload", "shapes.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      additionalArguments: [`--shapes-origin=${new URL(serverUrl()).origin}`],
    },
  });
  // Links to other sites open in the default browser; ShapesOS links stay here.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSameOrigin(url, serverUrl())) return { action: "allow" };
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // Sign-in may visit an identity provider (SSO); anything not http(s) is blocked.
  win.webContents.on("will-navigate", (e, url) => {
    if (!/^https?:/i.test(url)) e.preventDefault();
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted (a redirect)
    const q = new URLSearchParams({ url: serverUrl(), reason: `${desc} (${code})`, failed: url });
    void win.loadFile(rendererFile("offline"), { search: q.toString() });
  });
  win.once("ready-to-show", () => win.show());
  void win.loadURL(serverUrl());
  return win;
}

function baseInternal(extra: Electron.BrowserWindowConstructorOptions): Electron.BrowserWindowConstructorOptions {
  return {
    ...extra,
    webPreferences: {
      preload: internalPreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      ...(extra.webPreferences ?? {}),
    },
  };
}

export function createOverlayWindow(display: Electron.Display): BrowserWindow {
  const { x, y, width, height } = display.bounds;
  const win = new BrowserWindow(
    baseInternal({
      x,
      y,
      width,
      height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      title: "ShapesOS overlay",
      webPreferences: {},
    }),
  );
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  // Keep the companion pointer and the capture indicator out of screenshots.
  win.setContentProtection(true);
  void win.loadFile(rendererFile("overlay"), { search: `display=${display.id}` });
  win.once("ready-to-show", () => win.showInactive());
  return win;
}

export function createAudioWindow(): BrowserWindow {
  const win = new BrowserWindow(baseInternal({ show: false, width: 200, height: 100, title: "ShapesOS audio", skipTaskbar: true }));
  void win.loadFile(rendererFile("audio"));
  return win;
}

export function createAskWindow(): BrowserWindow {
  const win = new BrowserWindow(
    baseInternal({
      show: false,
      width: 520,
      height: 120,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreenable: false,
      title: "Ask ShapesOS",
    }),
  );
  win.on("blur", () => win.hide());
  void win.loadFile(rendererFile("ask"));
  return win;
}

export function showAskNearCursor(win: BrowserWindow): void {
  const p = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(p);
  const [w, h] = win.getSize() as [number, number];
  const x = Math.min(Math.max(p.x - w / 2, d.workArea.x + 8), d.workArea.x + d.workArea.width - w - 8);
  const y = Math.min(p.y + 24, d.workArea.y + d.workArea.height - h - 8);
  win.setPosition(Math.round(x), Math.round(y));
  win.show();
  win.focus();
  win.webContents.send("ask:reset");
}

export function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow(
    baseInternal({
      width: 720,
      height: 760,
      minWidth: 560,
      minHeight: 520,
      show: false,
      title: "ShapesOS settings",
      backgroundColor: "#F3F3F1",
    }),
  );
  void win.loadFile(rendererFile("settings"));
  win.once("ready-to-show", () => win.show());
  return win;
}

/** Only our own file:// renderers may use the internal IPC channels. */
export function isInternalSender(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "file:" && decodeURIComponent(u.pathname).startsWith(dist("renderer").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1:"));
  } catch {
    return false;
  }
}

export function appVersion(): string {
  return app.getVersion();
}
