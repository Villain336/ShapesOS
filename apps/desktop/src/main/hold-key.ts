// ShapesOS Desktop: hold-to-talk input.
//
// Electron's globalShortcut fires on key DOWN only, so holding a key needs
// raw global key events: uiohook-napi (MIT, N-API prebuilds for mac/win). It
// is an optional dependency loaded lazily; if it fails to load (or the person
// picks toggle mode) we fall back to a globalShortcut TOGGLE: press once to
// start talking, again to send. On macOS uiohook needs Accessibility (Input
// Monitoring) permission; without it no events arrive, which Settings
// explains.
//
// The stop key is registered with globalShortcut ONLY while a turn or answer
// is active, so Escape keeps working in every other app the rest of the time.

import { globalShortcut } from "electron";
import { HoldDetector, parseHotkey, uiohookKeyName, type HoldSignal } from "../shared/hotkeys";
import type { DesktopSettings } from "../shared/settings";

interface Uiohook {
  uIOhook: {
    on(ev: "keydown" | "keyup", fn: (e: { keycode: number }) => void): void;
    removeAllListeners(ev?: string): void;
    start(): void;
    stop(): void;
    keyTap(key: number, modifiers?: number[]): void;
  };
  UiohookKey: Record<string, number>;
}

let hook: Uiohook | null | undefined;
let hookError: string | null = null;

/** Load uiohook-napi once (null when unavailable or disabled for tests). */
export function loadUiohook(): Uiohook | null {
  if (hook !== undefined) return hook;
  if (process.env.SHAPES_DESKTOP_NO_NATIVE_HOOK === "1") {
    hookError = "The key hook is turned off for this run.";
    hook = null;
    return hook;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    hook = require("uiohook-napi") as Uiohook;
  } catch (e) {
    hookError = e instanceof Error ? e.message : String(e);
    hook = null;
  }
  return hook;
}

export function uiohookError(): string | null {
  return hookError;
}

export type HoldMode = "hold" | "toggle";

export class HoldKeyService {
  private detector: HoldDetector | null = null;
  private started = false;
  private toggled = false;
  private registered: string[] = [];
  private stopRegistered: string | null = null;
  mode: HoldMode = "toggle";
  error: string | null = null;

  constructor(private emit: (s: HoldSignal) => void) {}

  apply(settings: DesktopSettings, platform = process.platform): void {
    this.dispose();
    const wantHold = settings.holdMode === "hold";
    const h = wantHold ? loadUiohook() : null;
    const combo = parseHotkey(settings.holdKey, platform);
    if (h && combo) {
      this.detector = new HoldDetector(combo, parseHotkey(settings.stopKey, platform), this.emit, {
        minHoldMs: 150,
        now: Date.now,
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      });
      h.uIOhook.on("keydown", (e) => this.raw("down", e.keycode, h));
      h.uIOhook.on("keyup", (e) => this.raw("up", e.keycode, h));
      try {
        h.uIOhook.start();
        this.started = true;
        this.mode = "hold";
        this.error = null;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        this.detector = null;
      }
    } else if (wantHold) {
      this.error = uiohookError() ?? "The hold key isn't available on this system.";
    }
    if (this.mode !== "hold" || !this.started) {
      this.mode = "toggle";
      this.registerToggle(settings.toggleKey);
    }
  }

  private raw(type: "down" | "up", keycode: number, h: Uiohook): void {
    const key = uiohookKeyName(keycode, h.UiohookKey);
    if (key) this.detector?.feed({ type, key });
  }

  private registerToggle(accel: string): void {
    try {
      const ok = globalShortcut.register(accel, () => {
        this.toggled = !this.toggled;
        this.emit(this.toggled ? "start" : "end");
      });
      if (ok) this.registered.push(accel);
      else this.error = `${accel} is used by another app. Pick another toggle key in Settings.`;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** While a turn or answer is active, the stop key works everywhere. */
  armStop(accel: string | null): void {
    if (accel === this.stopRegistered) return;
    if (this.stopRegistered) {
      globalShortcut.unregister(this.stopRegistered);
      this.stopRegistered = null;
    }
    // With uiohook running the detector already sees the stop key without
    // stealing it from other apps.
    if (!accel || this.mode === "hold") return;
    try {
      if (globalShortcut.register(accel, () => this.emit("stop"))) this.stopRegistered = accel;
    } catch {
      /* invalid accelerator: settings validation should prevent this */
    }
  }

  /** Release any held state (the app lost track of key state). */
  reset(): void {
    this.detector?.reset();
    if (this.toggled) {
      this.toggled = false;
      this.emit("end");
    }
  }

  dispose(): void {
    for (const a of this.registered) globalShortcut.unregister(a);
    this.registered = [];
    this.armStop(null);
    if (hook && this.started) {
      hook.uIOhook.removeAllListeners("keydown");
      hook.uIOhook.removeAllListeners("keyup");
      try {
        hook.uIOhook.stop();
      } catch {
        /* already stopped */
      }
    }
    this.started = false;
    this.detector = null;
    this.toggled = false;
    this.mode = "toggle";
  }
}
