// ShapesOS Desktop: hotkey strings and the hold-to-talk detector.
//
// Hotkeys are Electron accelerator strings ("Control+Alt", "Control+Alt+Space",
// "CommandOrControl+Shift+K"). The hold key may be modifiers only (the
// HeyClicky default: Ctrl+Option on mac, Ctrl+Alt on Windows), because it is
// read from raw key DOWN/UP events (uiohook-napi), which Electron's
// globalShortcut cannot give. Everything else is a globalShortcut
// accelerator and needs a non-modifier key.

export type Modifier = "control" | "alt" | "shift" | "meta";

const MODIFIER_ALIASES: Record<string, Modifier | "cmdorctrl"> = {
  control: "control",
  ctrl: "control",
  alt: "alt",
  option: "alt",
  altgr: "alt",
  shift: "shift",
  command: "meta",
  cmd: "meta",
  super: "meta",
  meta: "meta",
  commandorcontrol: "cmdorctrl",
  cmdorctrl: "cmdorctrl",
};

const NAMED_KEYS = new Set([
  "space", "tab", "backspace", "delete", "insert", "return", "enter", "up", "down", "left", "right",
  "home", "end", "pageup", "pagedown", "escape", "esc", "capslock", "numlock", "scrolllock",
  "printscreen", "plus", "volumeup", "volumedown", "volumemute", "medianexttrack",
  "mediaprevioustrack", "mediastop", "mediaplaypause",
]);

export interface ParsedHotkey {
  modifiers: Modifier[];
  /** The non-modifier key, lower-case ("space", "k", "f5"), or null for modifiers only. */
  key: string | null;
}

function isKeyToken(t: string): boolean {
  return (
    /^[a-z0-9]$/.test(t) ||
    /^f([1-9]|1[0-9]|2[0-4])$/.test(t) ||
    /^num[0-9]$/.test(t) ||
    NAMED_KEYS.has(t) ||
    /^[`\-=[\];',./\\]$/.test(t)
  );
}

/** Parse an accelerator; null when invalid. `platform` resolves CommandOrControl. */
export function parseHotkey(s: string, platform: string): ParsedHotkey | null {
  if (typeof s !== "string") return null;
  const parts = s.split("+").map((p) => p.trim().toLowerCase());
  if (parts.length === 0 || parts.length > 5 || parts.some((p) => !p)) return null;
  const mods = new Set<Modifier>();
  let key: string | null = null;
  for (const p of parts) {
    const m = MODIFIER_ALIASES[p];
    if (m) {
      const mod: Modifier = m === "cmdorctrl" ? (platform === "darwin" ? "meta" : "control") : m;
      if (mods.has(mod)) return null;
      mods.add(mod);
      continue;
    }
    if (key !== null || !isKeyToken(p)) return null;
    key = p === "esc" ? "escape" : p === "enter" ? "return" : p;
  }
  const order: Modifier[] = ["control", "alt", "shift", "meta"];
  return { modifiers: order.filter((m) => mods.has(m)), key };
}

export type HotkeyRole = "hold" | "global" | "stop";

/** Validation message, or null when fine. */
export function hotkeyProblem(s: string, role: HotkeyRole, platform: string): string | null {
  const p = parseHotkey(s, platform);
  if (!p) return "Use keys like Control+Alt+Space.";
  if (role === "hold") {
    if (p.modifiers.length === 0) return "The talk key needs at least one modifier (Control, Alt, Shift or Command).";
    if (p.modifiers.length === 1 && !p.key) return "Hold two modifiers (like Control+Alt) or a modifier and a key.";
    return null;
  }
  if (role === "stop") return p.key ? null : "The stop key must include a non-modifier key, like Escape.";
  if (!p.key) return "Add a non-modifier key, like Space or K.";
  if (p.modifiers.length === 0) return "Add a modifier so the shortcut doesn't fire while you type.";
  return null;
}

/** Display form: "⌃⌥" style on mac, "Ctrl+Alt" elsewhere. */
export function formatHotkey(s: string, platform: string): string {
  const p = parseHotkey(s, platform);
  if (!p) return s;
  const mac: Record<Modifier, string> = { control: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" };
  const pc: Record<Modifier, string> = { control: "Ctrl", alt: "Alt", shift: "Shift", meta: "Win" };
  const key = p.key ? (p.key.length === 1 ? p.key.toUpperCase() : p.key[0]!.toUpperCase() + p.key.slice(1)) : null;
  if (platform === "darwin") return p.modifiers.map((m) => mac[m]).join("") + (key ?? "");
  return [...p.modifiers.map((m) => pc[m]), ...(key ? [key] : [])].join("+");
}

// ---------------------------------------------------------------------------
// The hold detector (pure; fed raw key events)
// ---------------------------------------------------------------------------

/** Raw key event with the key already named ("control", "alt", "space", "k", …). */
export interface RawKey {
  type: "down" | "up";
  key: string;
}

export interface HoldDetectorOptions {
  /** Hold this long before talking starts (so Ctrl+Alt+T in another app is not a talk). */
  minHoldMs: number;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
}

export type HoldSignal = "start" | "end" | "stop";

/**
 * Turns key DOWN/UP into talk start/end. Starts after the combo is held for
 * minHoldMs with no other key pressed; another key during that window means
 * it was a different shortcut (cancel). Ends when any combo key is released.
 * The stop key emits "stop" on its own down.
 */
export class HoldDetector {
  private down = new Set<string>();
  private pending: unknown = null;
  private active = false;
  private spoiled = false;

  constructor(
    private combo: ParsedHotkey,
    private stopKey: ParsedHotkey | null,
    private emit: (s: HoldSignal) => void,
    private opts: HoldDetectorOptions,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  private comboKeys(): string[] {
    return [...this.combo.modifiers, ...(this.combo.key ? [this.combo.key] : [])];
  }

  private comboHeld(): boolean {
    return this.comboKeys().every((k) => this.down.has(k));
  }

  feed(ev: RawKey): void {
    const k = ev.key;
    if (ev.type === "down") {
      const repeat = this.down.has(k);
      this.down.add(k);
      if (repeat) return;
      if (this.stopKey?.key === k && this.stopKey.modifiers.every((m) => this.down.has(m))) {
        this.emit("stop");
      }
      const inCombo = this.comboKeys().includes(k);
      if (!inCombo) {
        // Another key while arming: it was some other shortcut.
        if (this.pending !== null) {
          this.opts.clearTimer(this.pending);
          this.pending = null;
          this.spoiled = true;
        } else if (!this.active && this.comboKeys().some((c) => this.down.has(c))) {
          this.spoiled = true;
        }
        return;
      }
      if (!this.active && this.pending === null && !this.spoiled && this.comboHeld()) {
        this.pending = this.opts.setTimer(() => {
          this.pending = null;
          if (this.comboHeld() && !this.spoiled) {
            this.active = true;
            this.emit("start");
          }
        }, this.opts.minHoldMs);
      }
      return;
    }
    // up
    this.down.delete(k);
    if (this.comboKeys().includes(k)) {
      if (this.pending !== null) {
        this.opts.clearTimer(this.pending);
        this.pending = null;
      }
      if (this.active) {
        this.active = false;
        this.emit("end");
      }
    }
    // All combo keys up: a fresh press may arm again.
    if (!this.comboKeys().some((c) => this.down.has(c))) this.spoiled = false;
  }

  /** Focus lost / app hidden: treat everything as released. */
  reset(): void {
    if (this.pending !== null) this.opts.clearTimer(this.pending);
    this.pending = null;
    this.down.clear();
    this.spoiled = false;
    if (this.active) {
      this.active = false;
      this.emit("end");
    }
  }
}

/** uiohook-napi keycodes → our key names (the subset hotkeys can use). */
export function uiohookKeyName(keycode: number, table: Record<string, number>): string | null {
  for (const [name, code] of Object.entries(table)) {
    if (code !== keycode) continue;
    const n = name.toLowerCase();
    if (n === "ctrl" || n === "ctrlright") return "control";
    if (n === "alt" || n === "altright") return "alt";
    if (n === "shift" || n === "shiftright") return "shift";
    if (n === "meta" || n === "metaright") return "meta";
    if (n === "enter") return "return";
    return n;
  }
  return null;
}
