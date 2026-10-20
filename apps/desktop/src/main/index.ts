// ShapesOS Desktop — main process entry.
//
// Two parts (plan 19A): (1) the full ShapesOS app in a native window and
// (2) a system-wide cursor companion. ShapesOS is the key proxy: this app
// holds no provider keys and calls only the ShapesOS server it is pointed at.

import { app, BrowserWindow, globalShortcut, ipcMain, session, type IpcMainEvent } from "electron";
import { join } from "node:path";
import type { UiMapEntry } from "../shared/contract";
import { formatHotkey } from "../shared/hotkeys";
import { PAGE_CHANNELS, type PermissionKind, type SettingsPayload, type VoicesResult } from "../shared/ipc";
import { DEFAULT_EXCLUSIONS } from "../shared/exclusions";
import { ShapesApi } from "./api";
import { CursorController } from "./controller";
import { HoldKeyService } from "./hold-key";
import { Notifier } from "./notifier";
import { OverlayManager } from "./overlay-manager";
import { allPermissions, missingPermissions, openSystemSettings, requestPermission } from "./permissions";
import { SpeechIn, SpeechOut } from "./speech";
import { SettingsStore } from "./store";
import { TrayController } from "./tray";
import { Updater } from "./updater";
import {
  createAskWindow,
  createAudioWindow,
  createMainWindow,
  createSettingsWindow,
  hardenMainSession,
  isInternalSender,
  MAIN_PARTITION,
  showAskNearCursor,
} from "./windows";

if (__TEST_HOOKS__ && process.env.SHAPES_TEST_USER_DATA) {
  app.setPath("userData", process.env.SHAPES_TEST_USER_DATA);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let askWindow: BrowserWindow | null = null;
let audioWindow: BrowserWindow | null = null;
let quitting = false;

const assets = app.isPackaged ? join(process.resourcesPath, "assets") : join(__dirname, "..", "..", "assets");

function boot(): void {
  const store = new SettingsStore();
  if (__TEST_HOOKS__ && process.env.SHAPES_TEST_SERVER_URL) store.update({ serverUrl: process.env.SHAPES_TEST_SERVER_URL });
  const serverUrl = () => store.get().serverUrl;

  hardenMainSession(serverUrl);
  // Our own renderers (overlay, audio, ask, settings) live in the default
  // session: microphone only, nothing else.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const audioOnly = permission === "media" && (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === "audio");
    cb(Boolean(audioOnly) && isInternalSender(wc.getURL()));
  });

  const partition = session.fromPartition(MAIN_PARTITION);
  const api = new ShapesApi(serverUrl, (input, init) => partition.fetch(input, init));

  const openShapes = (path?: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow(serverUrl);
    if (path) void mainWindow.loadURL(`${serverUrl()}${path.startsWith("/") ? path : `/${path}`}`);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };

  const openSettings = () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
    settingsWindow = createSettingsWindow();
  };

  const ask = () => {
    if (!askWindow || askWindow.isDestroyed()) askWindow = createAskWindow();
    showAskNearCursor(askWindow);
  };

  const overlays = new OverlayManager();
  audioWindow = createAudioWindow();
  const speechOut = new SpeechOut(api, () => audioWindow);
  const speechIn = new SpeechIn(api, () => audioWindow);

  // ---- page bridge: uiMap, ⌘K -------------------------------------------------
  let uiMapSeq = 0;
  const uiMapWaiters = new Map<number, (m: UiMapEntry[] | null) => void>();
  const getUiMap = (): Promise<UiMapEntry[] | null> => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return Promise.resolve(null);
    const id = ++uiMapSeq;
    return new Promise((resolve) => {
      uiMapWaiters.set(id, resolve);
      win.webContents.send(PAGE_CHANNELS.getUiMap, { id });
      setTimeout(() => {
        if (uiMapWaiters.delete(id)) resolve(null);
      }, 600);
    });
  };
  const fromShapesPage = (e: IpcMainEvent): boolean => {
    const url = e.senderFrame?.url ?? "";
    try {
      return new URL(url).origin === new URL(serverUrl()).origin && e.sender === mainWindow?.webContents;
    } catch {
      return false;
    }
  };
  ipcMain.on(PAGE_CHANNELS.uiMap, (e, msg: { id: number; entries: unknown }) => {
    if (!fromShapesPage(e)) return;
    const waiter = uiMapWaiters.get(msg?.id);
    if (!waiter) return;
    uiMapWaiters.delete(msg.id);
    waiter(sanitiseUiMap(msg.entries));
  });

  const notifier = new Notifier(api, (href) => openShapes(href ?? undefined));
  ipcMain.on(PAGE_CHANNELS.notify, (e, n: { title?: unknown; body?: unknown; href?: unknown }) => {
    if (!fromShapesPage(e) || !store.get().notifications) return;
    if (typeof n?.title !== "string") return;
    notifier.show(n.title, typeof n.body === "string" ? n.body : undefined, typeof n.href === "string" && n.href.startsWith("/") ? n.href : null);
  });

  const holdKey = new HoldKeyService((sig) => {
    if (sig === "start") void controller.holdStart();
    else if (sig === "end") void controller.holdEnd();
    else controller.stop();
  });

  const tray = new TrayController(
    api,
    {
      openShapes,
      ask,
      settings: openSettings,
      quit: () => {
        quitting = true;
        app.quit();
      },
      holdHint: () =>
        holdKey.mode === "hold"
          ? `hold ${formatHotkey(store.get().holdKey, process.platform)}`
          : `press ${formatHotkey(store.get().toggleKey, process.platform)}`,
    },
    assets,
  );

  const controller = new CursorController({
    api,
    overlays,
    speechIn,
    speechOut,
    holdKey,
    tray,
    settings: () => store.get(),
    mainWindow: () => mainWindow,
    getUiMap,
    notify: (title, body, href) => notifier.show(title, body, href),
  });
  speechOut.onActive = (active) => {
    if (active) holdKey.armStop(store.get().stopKey);
  };

  // ---- internal IPC (overlay, audio, ask) -----------------------------------
  const internal = (e: IpcMainEvent) => isInternalSender(e.senderFrame?.url ?? "");
  ipcMain.on("overlay:interactive", (e, on: unknown) => {
    if (!internal(e)) return;
    const id = overlays.displayIdOf(e.sender.id);
    if (id !== null) overlays.setInteractive(id, on === true);
  });
  ipcMain.on("overlay:decide", (e, m: { approvalId?: unknown; decision?: unknown }) => {
    if (!internal(e) || typeof m?.approvalId !== "string") return;
    if (m.decision !== "approve" && m.decision !== "reject") return;
    void controller.clickDecision(m.approvalId, m.decision);
  });
  ipcMain.on("overlay:dictation", (e, m: { action?: unknown }) => {
    if (!internal(e)) return;
    if (m?.action === "paste" || m?.action === "cancel") void controller.dictationAction(m.action);
  });
  ipcMain.on("overlay:dismiss", (e) => {
    if (internal(e)) overlays.caption(null);
  });
  ipcMain.on("audio:stt-update", (e, m: { text?: unknown }) => {
    if (internal(e) && typeof m?.text === "string") speechIn.update(m.text);
  });
  ipcMain.on("audio:stt-final", (e, m: { text?: unknown; error?: unknown }) => {
    if (!internal(e)) return;
    speechIn.final(typeof m?.text === "string" ? m.text : "", typeof m?.error === "string" ? m.error : null);
  });
  ipcMain.on("audio:pcm", (e, bytes: unknown) => {
    if (internal(e) && bytes instanceof Uint8Array && bytes.byteLength <= 64 * 1024) speechIn.pcm(bytes);
  });
  ipcMain.on("audio:tts-done", (e, m: { id?: unknown }) => {
    if (internal(e) && typeof m?.id === "number") speechOut.done(m.id);
  });
  ipcMain.on("ask:submit", (e, text: unknown) => {
    if (!internal(e) || typeof text !== "string") return;
    askWindow?.hide();
    void controller.typed(text.slice(0, 4000));
  });
  ipcMain.on("ask:close", (e) => {
    if (internal(e)) askWindow?.hide();
  });

  // ---- settings ---------------------------------------------------------------
  const updater = new Updater(() => store.get());
  const payload = async (): Promise<SettingsPayload> => {
    const s = api.current ?? (await api.ensureSession().catch(() => null));
    return {
      settings: store.get(),
      status: {
        platform: process.platform,
        version: app.getVersion(),
        signedIn: !!s,
        userName: s?.user.name ?? null,
        voice: s?.voice.label ?? null,
        providers: s ? { ...s.providers } : null,
        talkMinutes: s ? { used: s.limits.talkMinutesUsed, included: s.limits.talkMinutesIncluded } : null,
        holdKeyAvailable: holdKey.mode === "hold",
        holdKeyError: holdKey.error,
        updates: { enabled: updater.config.enabled, reason: updater.config.reason, channel: updater.config.channel, state: updater.state },
        permissions: allPermissions(),
        storage: store.encrypted ? "encrypted" : "plain",
      },
    };
  };
  const handle = (channel: string, fn: (arg: unknown) => unknown) =>
    ipcMain.handle(channel, (e, arg) => {
      if (!isInternalSender(e.senderFrame?.url ?? "")) throw new Error("Not allowed");
      return fn(arg);
    });
  handle("settings:get", () => payload());
  handle("settings:save", (patch) => store.update(patch));
  handle("settings:reset-exclusions", () => store.update({ exclusions: [...DEFAULT_EXCLUSIONS] }));
  handle("settings:ask-permission", (k) => requestPermission(k as PermissionKind));
  handle("settings:open-system", (k) => openSystemSettings(k as PermissionKind));
  handle("settings:check-updates", () => updater.checkNow());
  handle("settings:open-shapes", (p) => openShapes(typeof p === "string" && p.startsWith("/") ? p : undefined));
  handle("settings:voices", async (): Promise<VoicesResult> => {
    try {
      const v = await api.voices();
      const voices = Array.isArray(v.voices) ? v.voices.filter((x) => typeof x?.id === "string").slice(0, 200) : [];
      return { ok: true, provider: String(v.provider ?? "none"), voices, selected: v.selected?.id ?? null, error: v.error ?? null };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Couldn't read the voice list." };
    }
  });
  handle("settings:set-voice", async (id): Promise<{ ok: boolean; error?: string }> => {
    if (typeof id !== "string" || !id || id.length > 200) return { ok: false, error: "Pick a voice from the list." };
    try {
      await api.setVoice(id);
      await api.ensureSession(true).catch(() => null); // the session carries the voice label
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Couldn't save the voice." };
    }
  });

  // ---- global shortcuts ----------------------------------------------------------
  // Spotlight: focus ShapesOS and open its ⌘K palette.
  const spotlight = () => {
    openShapes();
    mainWindow?.webContents.send(PAGE_CHANNELS.openPalette, { mac: process.platform === "darwin" });
  };
  const registered: string[] = [];
  const applyShortcuts = () => {
    for (const a of registered.splice(0)) globalShortcut.unregister(a);
    const s = store.get();
    const reg = (accel: string, fn: () => void) => {
      try {
        if (globalShortcut.register(accel, fn)) registered.push(accel);
      } catch {
        /* validated in settings; a clash with another app just doesn't register */
      }
    };
    // Spotlight: focus ShapesOS and open ⌘K.
    reg(s.spotlightKey, spotlight);
    reg(s.typeKey, ask);
    holdKey.apply(s);
  };

  store.onChange((s, prev) => {
    applyShortcuts();
    notifier.enabled = s.notifications;
    if (s.launchAtLogin !== prev.launchAtLogin) app.setLoginItemSettings({ openAtLogin: s.launchAtLogin });
    if (s.updateChannel !== prev.updateChannel || s.autoUpdate !== prev.autoUpdate) void updater.apply();
    if (s.serverUrl !== prev.serverUrl) {
      api.forget();
      mainWindow?.destroy();
      mainWindow = createMainWindow(serverUrl);
    }
    for (const w of BrowserWindow.getAllWindows()) if (isInternalSender(w.webContents.getURL())) w.webContents.send("settings:changed");
  });

  // ---- start ------------------------------------------------------------------------
  mainWindow = createMainWindow(serverUrl);
  mainWindow.on("close", (e) => {
    // Closing the window keeps the companion running in the tray.
    if (!quitting && process.platform !== "linux") {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  overlays.start();
  applyShortcuts();
  tray.start();
  notifier.enabled = store.get().notifications;
  notifier.start();
  void updater.apply();
  if (process.platform === "darwin" && missingPermissions().length && !__TEST_HOOKS__) openSettings();

  if (__TEST_HOOKS__) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("./test-hooks") as typeof import("./test-hooks")).installTestHooks({ controller, overlays, tray, speechOut, speechIn, holdKey, openSettings, openPalette: spotlight });
  }

  app.on("second-instance", () => openShapes());
  app.on("activate", () => openShapes());
  app.on("before-quit", () => {
    quitting = true;
    holdKey.dispose();
    globalShortcut.unregisterAll();
    controller.stop();
    tray.destroy();
    notifier.stop();
    overlays.destroy();
  });
}

function sanitiseUiMap(v: unknown): UiMapEntry[] | null {
  if (!Array.isArray(v)) return null;
  const out: UiMapEntry[] = [];
  for (const e of v.slice(0, 400)) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const r = o.rect as Record<string, unknown> | undefined;
    if (typeof o.id !== "string" || !r) continue;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : NaN);
    const rect = { x: n(r.x), y: n(r.y), w: n(r.w), h: n(r.h) };
    if (Object.values(rect).some(Number.isNaN)) continue;
    out.push({
      id: o.id.slice(0, 200),
      label: typeof o.label === "string" ? o.label.slice(0, 200) : "",
      role: typeof o.role === "string" ? o.role.slice(0, 40) : "",
      rect,
    });
  }
  return out;
}

app.on("window-all-closed", () => {
  // The companion lives in the tray; only Linux (no reliable tray) quits.
  if (process.platform === "linux" && quitting) app.quit();
});

void app.whenReady().then(boot);
