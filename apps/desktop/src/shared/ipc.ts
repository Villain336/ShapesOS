// ShapesOS Desktop: IPC channels between the main process and our own
// renderers (overlay, audio, ask, settings). The internal preload only
// forwards channels on these allowlists; the remote ShapesOS page gets a
// separate, smaller bridge (src/preload/shapes.ts).

import type { Point2 } from "./contract";
import type { DesktopSettings, SettingsErrors } from "./settings";

// ---- overlay -------------------------------------------------------------

export interface OverlayDrawing {
  id: string;
  kind: "circle" | "arrow" | "step";
  points: Point2[];
  step?: number;
  label?: string;
}

export interface OverlayCard {
  approvalId: string;
  tool: string;
  summary: string;
  tierLabel: string;
  hint: string;
  voiceApprovable: boolean;
  /** "pending" | "sending" | "approved" | "rejected" | "failed: <message>" */
  status: string;
  x: number;
  y: number;
}

export interface OverlayDictation {
  text: string;
  status: "preview" | "pasting" | "done";
  message: string | null;
  x: number;
  y: number;
}

export interface OverlayState {
  displayId: number;
  width: number;
  height: number;
  pointer: { x: number; y: number; label: string; seq: number } | null;
  drawings: OverlayDrawing[];
  caption: { text: string; kind: "listening" | "answering" | "notice" | "error"; x: number; y: number } | null;
  /** The visible capture indicator (screenshots are being taken). */
  capturing: boolean;
  /** Talk is active (listening) — shown on the display under the cursor. */
  listening: boolean;
  proposal: OverlayCard | null;
  dictation: OverlayDictation | null;
}

export const OVERLAY_TO_MAIN = ["overlay:interactive", "overlay:decide", "overlay:dictation", "overlay:dismiss"] as const;
export const MAIN_TO_OVERLAY = ["overlay:state"] as const;

// ---- audio (mic → STT socket; TTS playback) -------------------------------

export interface SttStart {
  url: string;
  protocols: string[];
  provider: string;
  sampleRate: number;
  closeMessage: string | null;
}

export const AUDIO_TO_MAIN = ["audio:stt-update", "audio:stt-final", "audio:tts-done", "audio:ready"] as const;
export const MAIN_TO_AUDIO = [
  "audio:stt-start",
  "audio:stt-stop",
  "audio:tts-begin",
  "audio:tts-chunk",
  "audio:tts-end",
  "audio:tts-stop",
] as const;

// ---- ask (typing fallback) ------------------------------------------------

export const ASK_TO_MAIN = ["ask:submit", "ask:close"] as const;
export const MAIN_TO_ASK = ["ask:reset"] as const;

// ---- settings --------------------------------------------------------------

export type PermissionKind = "microphone" | "screen" | "accessibility";
export type PermissionStatus = "granted" | "denied" | "not-determined" | "restricted" | "unknown" | "not-needed";

export interface SettingsStatus {
  platform: string;
  version: string;
  signedIn: boolean;
  userName: string | null;
  voice: string | null;
  providers: { stt: string; tts: string; vision: string } | null;
  talkMinutes: { used: number; included: number } | null;
  holdKeyAvailable: boolean;
  holdKeyError: string | null;
  updates: { enabled: boolean; reason: string | null; channel: string; state: string };
  permissions: Record<PermissionKind, PermissionStatus>;
  storage: "encrypted" | "plain";
}

export interface SettingsPayload {
  settings: DesktopSettings;
  status: SettingsStatus;
}

export type SaveResult = { ok: true; settings: DesktopSettings } | { ok: false; errors: SettingsErrors };

export const SETTINGS_INVOKE = [
  "settings:get",
  "settings:save",
  "settings:ask-permission",
  "settings:open-system",
  "settings:check-updates",
  "settings:open-shapes",
  "settings:reset-exclusions",
] as const;
export const MAIN_TO_SETTINGS = ["settings:changed"] as const;

export const SEND_CHANNELS: readonly string[] = [...OVERLAY_TO_MAIN, ...AUDIO_TO_MAIN, ...ASK_TO_MAIN];
export const RECEIVE_CHANNELS: readonly string[] = [...MAIN_TO_OVERLAY, ...MAIN_TO_AUDIO, ...MAIN_TO_ASK, ...MAIN_TO_SETTINGS];
export const INVOKE_CHANNELS: readonly string[] = [...SETTINGS_INVOKE];

/** What the internal preload exposes as `window.desktop`. */
export interface DesktopBridge {
  platform: string;
  send(channel: string, payload?: unknown): void;
  on(channel: string, cb: (payload: unknown) => void): () => void;
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<T>;
}

// ---- the ShapesOS page bridge -------------------------------------------------

export const PAGE_CHANNELS = {
  getUiMap: "page:get-ui-map",
  uiMap: "page:ui-map",
  openPalette: "page:open-palette",
  notify: "page:notify",
} as const;
