// ShapesOS Desktop: settings, defaults and validation.
//
// Settings hold ONLY the server URL and preferences (no provider keys, ever:
// ShapesOS is the key proxy). They are stored with Electron safeStorage
// (src/main/store.ts). Validation is strict and returns per-field messages
// for the Settings window.

import { DEFAULT_EXCLUSIONS, normaliseExclusions, parseExclusion } from "./exclusions";
import { hotkeyProblem } from "./hotkeys";

export const DEFAULT_SERVER_URL = "https://app.shapesos.com";

export interface DesktopSettings {
  version: 1;
  /** ShapesOS server (hosted or self-hosted). */
  serverUrl: string;
  /** Hold to talk (raw key down/up). */
  holdKey: string;
  /** "hold" (default) or "toggle" (press once to start, again to send). */
  holdMode: "hold" | "toggle";
  /** Toggle shortcut, also the fallback when the hold-key hook can't load. */
  toggleKey: string;
  /** Cuts the spoken answer and the turn instantly. */
  stopKey: string;
  /** Focus ShapesOS and open ⌘K. */
  spotlightKey: string;
  /** Typing fallback: a small input near the cursor. */
  typeKey: string;
  exclusions: string[];
  /** Capture every display, or only the one under the cursor. */
  captureScreens: "all" | "cursor";
  speakAnswers: boolean;
  notifications: boolean;
  launchAtLogin: boolean;
  autoUpdate: boolean;
  updateChannel: "stable" | "beta";
  /** Agent mode cap when none is spoken (USD). */
  agentDefaultUsd: number;
  /** The highest cap a spoken request may set (USD). */
  agentCeilingUsd: number;
}

export function defaultSettings(platform: string): DesktopSettings {
  return {
    version: 1,
    serverUrl: DEFAULT_SERVER_URL,
    // HeyClicky's default, on both platforms: Ctrl+Option (mac) / Ctrl+Alt (Windows).
    holdKey: "Control+Alt",
    holdMode: "hold",
    toggleKey: "Control+Alt+Space",
    stopKey: "Escape",
    spotlightKey: platform === "darwin" ? "Command+Shift+K" : "Control+Shift+K",
    typeKey: platform === "darwin" ? "Command+Shift+Space" : "Control+Shift+Space",
    exclusions: [...DEFAULT_EXCLUSIONS],
    captureScreens: "all",
    speakAnswers: true,
    notifications: true,
    launchAtLogin: false,
    autoUpdate: true,
    updateChannel: "stable",
    agentDefaultUsd: 1,
    agentCeilingUsd: 10,
  };
}

export type SettingsErrors = Partial<Record<keyof DesktopSettings, string>>;

const PRIVATE_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local|[a-z0-9.-]+\.localhost)$/i;

/** Normalised server URL, or an error. https everywhere; http only for loopback/LAN self-hosts. */
export function checkServerUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: "Enter a full address, like https://app.shapesos.com." };
  }
  if (u.username || u.password) return { ok: false, error: "Leave the user name and password out of the address." };
  if (u.search || u.hash) return { ok: false, error: "Use the server address without ? or #." };
  if (u.protocol === "http:") {
    if (!PRIVATE_HOST.test(u.hostname) && !PRIVATE_HOST.test(u.host)) {
      return { ok: false, error: "Use https:// (http is only allowed for a local or LAN server)." };
    }
  } else if (u.protocol !== "https:") {
    return { ok: false, error: "Use an https:// address." };
  }
  const path = u.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${u.protocol}//${u.host}${path}` };
}

function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function money(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1000 ? Math.round(v * 100) / 100 : null;
}

export type SettingsResult = { ok: true; settings: DesktopSettings } | { ok: false; errors: SettingsErrors };

/**
 * Validate a (possibly partial) settings object on top of `base`. Unknown
 * keys are ignored; a wrong type or value is an error for that field.
 */
export function validateSettings(input: unknown, base: DesktopSettings, platform: string): SettingsResult {
  const errors: SettingsErrors = {};
  const out: DesktopSettings = { ...base, exclusions: [...base.exclusions] };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: { version: "Settings must be an object." } };
  }
  const v = input as Record<string, unknown>;

  if ("serverUrl" in v) {
    const r = typeof v.serverUrl === "string" ? checkServerUrl(v.serverUrl) : null;
    if (r?.ok) out.serverUrl = r.url;
    else errors.serverUrl = r && !r.ok ? r.error : "Enter the server address.";
  }

  const keys: [keyof DesktopSettings, "hold" | "global" | "stop"][] = [
    ["holdKey", "hold"],
    ["toggleKey", "global"],
    ["stopKey", "stop"],
    ["spotlightKey", "global"],
    ["typeKey", "global"],
  ];
  for (const [field, role] of keys) {
    if (!(field in v)) continue;
    const s = v[field];
    const problem = typeof s === "string" ? hotkeyProblem(s, role, platform) : "Choose a shortcut.";
    if (problem) errors[field] = problem;
    else (out as unknown as Record<string, unknown>)[field] = (s as string).trim();
  }
  // Two global shortcuts can't share keys.
  const globals = [out.toggleKey, out.spotlightKey, out.typeKey].map((s) => s.toLowerCase().replace(/\s/g, ""));
  if (new Set(globals).size !== globals.length && !errors.typeKey) {
    errors.typeKey = "Each shortcut needs its own keys.";
  }

  if ("holdMode" in v) {
    if (v.holdMode === "hold" || v.holdMode === "toggle") out.holdMode = v.holdMode;
    else errors.holdMode = "Choose hold or toggle.";
  }
  if ("captureScreens" in v) {
    if (v.captureScreens === "all" || v.captureScreens === "cursor") out.captureScreens = v.captureScreens;
    else errors.captureScreens = "Choose all screens or the screen under the cursor.";
  }
  if ("updateChannel" in v) {
    if (v.updateChannel === "stable" || v.updateChannel === "beta") out.updateChannel = v.updateChannel;
    else errors.updateChannel = "Choose stable or beta.";
  }
  for (const f of ["speakAnswers", "notifications", "launchAtLogin", "autoUpdate"] as const) {
    if (!(f in v)) continue;
    if (isBool(v[f])) out[f] = v[f];
    else errors[f] = "Turn this on or off.";
  }

  if ("exclusions" in v) {
    const list = v.exclusions;
    if (!Array.isArray(list) || list.length > 300 || list.some((e) => typeof e !== "string")) {
      errors.exclusions = "Use one app, url: or title: entry per line (300 at most).";
    } else {
      const bad = (list as string[]).filter((e) => e.trim() && !parseExclusion(e));
      if (bad.length) errors.exclusions = `Can't read: ${bad.slice(0, 3).join(", ")}.`;
      else out.exclusions = normaliseExclusions(list as string[]);
    }
  }

  if ("agentDefaultUsd" in v) {
    const n = money(v.agentDefaultUsd);
    if (n === null) errors.agentDefaultUsd = "Enter an amount between $0.01 and $1,000.";
    else out.agentDefaultUsd = n;
  }
  if ("agentCeilingUsd" in v) {
    const n = money(v.agentCeilingUsd);
    if (n === null) errors.agentCeilingUsd = "Enter an amount between $0.01 and $1,000.";
    else out.agentCeilingUsd = n;
  }
  if (!errors.agentDefaultUsd && !errors.agentCeilingUsd && out.agentDefaultUsd > out.agentCeilingUsd) {
    errors.agentDefaultUsd = "The default cap can't be above the limit.";
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, settings: out };
}

/** Load stored JSON: anything invalid falls back to defaults field by field. */
export function loadSettings(stored: unknown, platform: string): DesktopSettings {
  const base = defaultSettings(platform);
  if (!stored || typeof stored !== "object") return base;
  const r = validateSettings(stored, base, platform);
  if (r.ok) return r.settings;
  // Drop the bad fields and keep the rest.
  const clean: Record<string, unknown> = { ...(stored as Record<string, unknown>) };
  for (const k of Object.keys(r.errors)) delete clean[k];
  const again = validateSettings(clean, base, platform);
  return again.ok ? again.settings : base;
}
