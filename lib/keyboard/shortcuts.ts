// ShapesOS — Phase 18.1 (WS=desk): the keyboard shortcut registry (PURE).
//
// One list of every shortcut the app answers to: the ones that already
// existed (⌘K, ⌘N, ⌘J, "G I", ⌥M, ⌥P and ⌥1–⌥6 — handled in
// components/command-bar/CommandBar.tsx and NewTaskDialog.tsx) and the
// desktop's own (⌃Tab switcher, "?" cheat-sheet, Control Center, focus,
// split view, desktop editing). The cheat-sheet renders this list, and
// rebinding goes through it:
//   - a member's overrides ({ [id]: "Ctrl+Shift+K" }) are stored as the
//     "keyboard.shortcuts" preference (lib/desktop/prefs.ts, the UserPrefs
//     seam shared with WS=find);
//   - applyOverrides() REFUSES a binding that clashes with another shortcut
//     that can be live at the same time, a reserved browser/OS combo, or a
//     bare navigation key — the API returns the reason and stores nothing;
//   - the command bar's handlers are not edited here: components/desk/
//     ShortcutHost.tsx remaps a rebound command-bar shortcut by replaying its
//     default combo (and swallowing the old one), so rebinding works for them
//     too.
//
// Combo text: "Mod+K" (⌘ on Mac, Ctrl elsewhere — the existing shortcuts
// accept either), "Ctrl+Tab" (Control on every platform), "Alt+Shift+C",
// "?" and sequences separated by a space ("G I").

export type ShortcutScope = "global" | "palette" | "switcher" | "split" | "desktop" | "desktop-edit";
export type ShortcutGroup = "General" | "Navigation" | "Agents" | "Desktop" | "Split view" | "App switcher";

export interface ShortcutDef {
  id: string;
  label: string;
  group: ShortcutGroup;
  /** Default binding (combo text). */
  combo: string;
  /** Extra default bindings that also work (not rebindable themselves). */
  alternates?: readonly string[];
  /** Where it is live. "global" is live everywhere (and clashes with every scope). */
  scope: ShortcutScope;
  /** Who handles it: the command bar (existing handlers) or the desk host. */
  owner: "command-bar" | "desk";
  rebindable: boolean;
  /** One line for the cheat-sheet when the label needs it. */
  hint?: string;
}

export interface KeyStep {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Lowercase letter / digit, or a key name: Tab, Escape, Enter, ArrowLeft, "?", "`", "[" … */
  key: string;
}

export type Combo = KeyStep[];

const NAMED: Record<string, string> = {
  tab: "Tab",
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  // WS=find's stored names for punctuation (lib/preferences/schema.ts).
  backquote: "`",
  slash: "/",
  period: ".",
  comma: ",",
  minus: "-",
  equal: "=",
};

/** Parse combo text; throws a readable error when it is not a combo. */
export function parseCombo(text: string): Combo {
  const steps = text.trim().split(/\s+/).filter(Boolean);
  if (steps.length === 0 || steps.length > 2) throw new Error("A shortcut is one key combination, or two keys in a row.");
  return steps.map((s) => parseStep(s));
}

function parseStep(s: string): KeyStep {
  // "?" and "+" are keys themselves; everything else splits on "+".
  const parts = s === "+" ? ["+"] : s.split("+").filter((p, i, a) => p !== "" || i === a.length - 1);
  const step: KeyStep = { mod: false, ctrl: false, alt: false, shift: false, key: "" };
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i]!;
    const p = raw.toLowerCase();
    const last = i === parts.length - 1;
    if (!last && (p === "mod" || p === "cmd" || p === "meta" || p === "⌘")) step.mod = true;
    else if (!last && (p === "ctrl" || p === "control" || p === "⌃")) step.ctrl = true;
    else if (!last && (p === "alt" || p === "option" || p === "opt" || p === "⌥")) step.alt = true;
    else if (!last && (p === "shift" || p === "⇧")) step.shift = true;
    else if (last) step.key = normalizeKey(raw);
    else throw new Error(`"${raw}" is not a modifier (use Mod, Ctrl, Alt or Shift).`);
  }
  if (!step.key) throw new Error("The shortcut has no key.");
  return step;
}

function normalizeKey(raw: string): string {
  const p = raw.toLowerCase();
  if (NAMED[p]) return NAMED[p]!;
  if (/^f([1-9]|1[0-2])$/.test(p)) return p.toUpperCase();
  if (raw.length === 1) return raw.toLowerCase();
  throw new Error(`"${raw}" is not a key.`);
}

/** Canonical text: modifiers in Mod, Ctrl, Alt, Shift order. */
export function formatCombo(combo: Combo): string {
  return combo.map(stepText).join(" ");
}

function stepText(s: KeyStep): string {
  const mods = [s.mod && "Mod", s.ctrl && "Ctrl", s.alt && "Alt", s.shift && "Shift"].filter(Boolean) as string[];
  const key = s.key.length === 1 ? s.key.toUpperCase() : s.key;
  return [...mods, key].join("+");
}

/**
 * The binding as WS=find's "shortcuts" preference stores it
 * (lib/preferences/schema.ts parseShortcut): lower case, "mod+shift+k",
 * "ctrl+alt+left", "g i", "?". parseCombo() reads it back.
 */
export function toStoredBinding(text: string): string {
  const named: Record<string, string> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Escape: "escape", Enter: "enter", Space: "space", Backspace: "backspace", Delete: "delete", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown" };
  return parseCombo(text)
    .map((s) => {
      const mods = [s.mod && "mod", s.ctrl && "ctrl", s.alt && "alt", s.shift && "shift"].filter(Boolean) as string[];
      return [...mods, named[s.key] ?? s.key.toLowerCase()].join("+");
    })
    .join(" ");
}

/** Shortcut ids follow WS=find's action-id rule (dotted lower case, digits, underscores). */
export const SHORTCUT_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/;

/** Normalize combo text (throws when invalid). */
export function canonicalCombo(text: string): string {
  return formatCombo(parseCombo(text));
}

/** Keycaps for display: ⌘ ⌃ ⌥ ⇧ on Mac, words elsewhere. */
export function comboKeycaps(text: string, mac: boolean): string[][] {
  let combo: Combo;
  try {
    combo = parseCombo(text);
  } catch {
    return [[text]];
  }
  const keyName: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Escape: "esc", Enter: "↵", Space: "Space" };
  return combo.map((s) => {
    const caps: string[] = [];
    if (s.mod) caps.push(mac ? "⌘" : "Ctrl");
    if (s.ctrl) caps.push(mac ? "⌃" : "Ctrl");
    if (s.alt) caps.push(mac ? "⌥" : "Alt");
    if (s.shift) caps.push(mac ? "⇧" : "Shift");
    caps.push(keyName[s.key] ?? (s.key.length === 1 ? s.key.toUpperCase() : s.key));
    return caps;
  });
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** ⌥1–⌥6: the original ⌘K Go targets (lib/nav/config.ts NAV_HOTKEYS). */
const NAV_DIGITS: readonly [string, string][] = [
  ["1", "Overview"],
  ["2", "Studio"],
  ["3", "CRM"],
  ["4", "Reports"],
  ["5", "Assistant"],
  ["6", "Settings"],
];

export const SHORTCUTS: readonly ShortcutDef[] = Object.freeze([
  // --- existing (command bar) ---------------------------------------------
  { id: "palette.toggle", label: "Open the command bar", group: "General", combo: "Mod+K", scope: "global", owner: "command-bar", rebindable: true },
  { id: "task.new", label: "New task", group: "Agents", combo: "Mod+N", scope: "global", owner: "command-bar", rebindable: true, hint: "Hand a goal to the lead agent" },
  { id: "schedule.new", label: "Schedule a run", group: "Agents", combo: "Mod+J", scope: "global", owner: "command-bar", rebindable: true },
  { id: "go.approvals", label: "Open approvals", group: "Navigation", combo: "G I", scope: "global", owner: "command-bar", rebindable: true, hint: "Press G, then I" },
  { id: "palette.missions", label: "Start a mission", group: "Agents", combo: "Alt+M", scope: "palette", owner: "command-bar", rebindable: true, hint: "In the command bar" },
  { id: "palette.playbooks", label: "Run a playbook step", group: "Agents", combo: "Alt+P", scope: "palette", owner: "command-bar", rebindable: true, hint: "In the command bar" },
  ...NAV_DIGITS.map(([d, label]) => ({
    id: `palette.go.${label.toLowerCase()}`,
    label: `Go to ${label}`,
    group: "Navigation" as const,
    combo: `Alt+${d}`,
    scope: "palette" as const,
    owner: "command-bar" as const,
    rebindable: true,
    hint: "In the command bar",
  })),
  // --- desk ---------------------------------------------------------------
  {
    id: "switcher.open",
    label: "Switch app",
    group: "App switcher",
    combo: "Ctrl+Tab",
    alternates: ["Ctrl+`"],
    scope: "global",
    owner: "desk",
    rebindable: true,
    hint: "Hold Control, press Tab to move, let go to open. Some browsers keep Control+Tab for their own tabs; Control+` always works.",
  },
  { id: "switcher.next", label: "Next in the switcher", group: "App switcher", combo: "Tab", scope: "switcher", owner: "desk", rebindable: false },
  { id: "switcher.prev", label: "Previous in the switcher", group: "App switcher", combo: "Shift+Tab", scope: "switcher", owner: "desk", rebindable: false },
  { id: "switcher.split", label: "Open next to this page", group: "App switcher", combo: "Shift+Enter", scope: "switcher", owner: "desk", rebindable: false },
  { id: "switcher.cancel", label: "Close the switcher", group: "App switcher", combo: "Escape", scope: "switcher", owner: "desk", rebindable: false },
  { id: "help.shortcuts", label: "Keyboard shortcuts", group: "General", combo: "?", scope: "global", owner: "desk", rebindable: true, hint: "This list" },
  { id: "control.open", label: "Control Center", group: "General", combo: "Alt+Shift+C", scope: "global", owner: "desk", rebindable: true },
  { id: "focus.toggle", label: "Turn focus on or off", group: "General", combo: "Alt+Shift+D", scope: "global", owner: "desk", rebindable: true, hint: "Do not disturb for an hour" },
  { id: "split.open", label: "Open this page in split view", group: "Split view", combo: "Alt+Shift+S", scope: "global", owner: "desk", rebindable: true, hint: "Next to the Assistant" },
  { id: "split.swap", label: "Swap panes", group: "Split view", combo: "Ctrl+Alt+S", scope: "split", owner: "desk", rebindable: true },
  { id: "split.close", label: "Close the focused pane", group: "Split view", combo: "Ctrl+Alt+W", scope: "split", owner: "desk", rebindable: true },
  { id: "split.focus_left", label: "Focus the left pane", group: "Split view", combo: "Ctrl+Alt+ArrowLeft", scope: "split", owner: "desk", rebindable: true },
  { id: "split.focus_right", label: "Focus the right pane", group: "Split view", combo: "Ctrl+Alt+ArrowRight", scope: "split", owner: "desk", rebindable: true },
  { id: "split.shrink_left", label: "Move the divider left", group: "Split view", combo: "Ctrl+Alt+[", scope: "split", owner: "desk", rebindable: true },
  { id: "split.grow_left", label: "Move the divider right", group: "Split view", combo: "Ctrl+Alt+]", scope: "split", owner: "desk", rebindable: true },
  { id: "desktop.edit", label: "Edit the desktop", group: "Desktop", combo: "Alt+Shift+E", scope: "desktop", owner: "desk", rebindable: true, hint: "On Home" },
  { id: "desktop.move", label: "Move the focused widget", group: "Desktop", combo: "ArrowLeft", scope: "desktop-edit", owner: "desk", rebindable: false, hint: "Arrow keys, while editing" },
  { id: "desktop.resize", label: "Resize the focused widget", group: "Desktop", combo: "Shift+ArrowRight", scope: "desktop-edit", owner: "desk", rebindable: false, hint: "Shift + arrow keys, while editing" },
  { id: "desktop.remove", label: "Remove the focused widget", group: "Desktop", combo: "Delete", scope: "desktop-edit", owner: "desk", rebindable: false, hint: "While editing" },
] satisfies ShortcutDef[]);

export const SHORTCUTS_BY_ID: ReadonlyMap<string, ShortcutDef> = new Map(SHORTCUTS.map((s) => [s.id, s]));

/** Browser and OS combos a page cannot (or must not) take. */
export const RESERVED_COMBOS: readonly string[] = [
  "Mod+W", "Mod+T", "Mod+Q", "Mod+R", "Mod+L", "Mod+P", "Mod+S", "Mod+F", "Mod+C", "Mod+V", "Mod+X", "Mod+Z", "Mod+A",
  "Mod+Shift+T", "Mod+Shift+N", "Mod+Shift+W", "Mod+Shift+C", "Mod+Shift+I", "Mod+Shift+J",
  "Alt+Tab", "Alt+F4", "F5", "F11", "F12",
].map((c) => canonicalCombo(c));

const RESERVED_STEPS: readonly KeyStep[] = RESERVED_COMBOS.map((c) => parseCombo(c)[0]!);

/** Is any step a reserved browser/OS combo? (Ctrl+W is reserved like ⌘W.) */
export function isReserved(combo: Combo): boolean {
  return combo.some((s) => RESERVED_STEPS.some((r) => stepEq(r, s)));
}

/** Keys that must keep their meaning (navigation, dialogs, typing). */
const BARE_FORBIDDEN = new Set(["Tab", "Escape", "Enter", "Space", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** Page scopes are exclusive (one page at a time); the palette and the switcher open over any page. */
const PAGE_SCOPES = new Set<ShortcutScope>(["split", "desktop", "desktop-edit"]);
const OVERLAY_SCOPES = new Set<ShortcutScope>(["palette", "switcher"]);

/** Can two scopes be live at the same time? */
export function scopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean {
  if (a === b) return true;
  if (a === "global" || b === "global") return true;
  const pair = new Set([a, b]);
  // Editing the desktop happens on the desktop.
  if (pair.has("desktop") && pair.has("desktop-edit")) return true;
  // An overlay is open over some page: it overlaps every page scope.
  if ((OVERLAY_SCOPES.has(a) && PAGE_SCOPES.has(b)) || (OVERLAY_SCOPES.has(b) && PAGE_SCOPES.has(a))) return true;
  // Two pages, or two overlays, are never live together.
  return false;
}

function stepEq(a: KeyStep, b: KeyStep): boolean {
  // Mod accepts ⌘ or Ctrl (the existing handlers do), so it collides with Ctrl.
  const aCtrlish = a.mod || a.ctrl;
  const bCtrlish = b.mod || b.ctrl;
  const ctrlClash = a.mod || b.mod ? aCtrlish === bCtrlish : a.ctrl === b.ctrl;
  return ctrlClash && a.alt === b.alt && a.shift === b.shift && a.key === b.key;
}

/** Same combo, or one is a prefix of the other (a sequence starting with a bound key). */
export function combosClash(a: Combo, b: Combo): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (!stepEq(a[i]!, b[i]!)) return false;
  return true;
}

export interface Binding {
  id: string;
  combo: string;
  scope: ShortcutScope;
}

/** Every active binding (primary + alternates) for a given overrides map. */
export function bindingsFor(overrides: Readonly<Record<string, string>> = {}): Binding[] {
  const out: Binding[] = [];
  for (const s of SHORTCUTS) {
    out.push({ id: s.id, combo: overrides[s.id] ?? s.combo, scope: s.scope });
    for (const alt of s.alternates ?? []) out.push({ id: s.id, combo: alt, scope: s.scope });
  }
  return out;
}

export interface Clash {
  a: string;
  b: string;
  combo: string;
}

/** Every pair of shortcuts that would fire on the same keys at the same time. */
export function findClashes(bindings: readonly Binding[]): Clash[] {
  const parsed = bindings.map((b) => ({ ...b, steps: parseCombo(b.combo) }));
  const out: Clash[] = [];
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const a = parsed[i]!;
      const b = parsed[j]!;
      if (a.id === b.id) continue;
      if (scopesOverlap(a.scope, b.scope) && combosClash(a.steps, b.steps)) out.push({ a: a.id, b: b.id, combo: formatCombo(a.steps) });
    }
  }
  return out;
}

export type RebindResult = { ok: true; overrides: Record<string, string> } | { ok: false; error: string };

/**
 * Rebind `id` to `combo` on top of `current` overrides. Refuses (and changes
 * nothing) when the shortcut is fixed, the combo is invalid, reserved, a bare
 * navigation key, or clashes with another live shortcut. `combo === null`
 * (or the default) resets it.
 */
export function rebind(current: Readonly<Record<string, string>>, id: string, combo: string | null): RebindResult {
  const def = SHORTCUTS_BY_ID.get(id);
  if (!def) return { ok: false, error: "That shortcut does not exist." };
  if (!def.rebindable) return { ok: false, error: `${def.label} can't be changed.` };
  const next: Record<string, string> = { ...sanitizeOverrides(current) };
  if (combo === null) {
    delete next[id];
  } else {
    let canonical: string;
    try {
      canonical = canonicalCombo(combo);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "That is not a shortcut." };
    }
    const steps = parseCombo(canonical);
    if (isReserved(steps)) return { ok: false, error: `${canonical} belongs to the browser.` };
    const first = steps[0]!;
    const bare = !first.mod && !first.ctrl && !first.alt;
    if (bare && BARE_FORBIDDEN.has(first.key)) return { ok: false, error: `${canonical} is needed to move around the page.` };
    if (bare && !first.shift && steps.length === 1 && first.key.length === 1 && def.scope !== "global") {
      // Single letters only make sense as global "press when not typing" keys.
      return { ok: false, error: "Use a modifier (Ctrl, Alt or ⌘) for this one." };
    }
    if (canonical === canonicalCombo(def.combo)) delete next[id];
    else next[id] = canonical;
  }
  const all = bindingsFor(next);
  const clashes = findClashes(all).filter((c) => c.a === id || c.b === id);
  if (clashes.length) {
    const otherId = clashes[0]!.a === id ? clashes[0]!.b : clashes[0]!.a;
    const other = SHORTCUTS_BY_ID.get(otherId);
    const mine = effectiveCombo(id, next);
    const theirs = all.find((b) => b.id === otherId && combosClash(parseCombo(b.combo), parseCombo(mine)))?.combo ?? mine;
    const label = other ? `"${other.label}"` : "another shortcut";
    return { ok: false, error: theirs === mine ? `${mine} is already ${label}.` : `${mine} clashes with ${theirs} (${label}).` };
  }
  return { ok: true, overrides: next };
}

/**
 * Stored overrides, made safe: unknown ids, fixed shortcuts and invalid
 * combos are dropped; if the set clashes (e.g. a new default arrived), the
 * clashing overrides are dropped so the defaults win. Never throws.
 */
export function sanitizeOverrides(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const def = SHORTCUTS_BY_ID.get(id);
    if (!def?.rebindable || typeof v !== "string" || v.length > 40) continue;
    try {
      out[id] = canonicalCombo(v);
    } catch {
      // drop it
    }
  }
  for (const c of findClashes(bindingsFor(out))) {
    delete out[c.a];
    delete out[c.b];
  }
  return out;
}

/** The effective combo text for a shortcut. */
export function effectiveCombo(id: string, overrides: Readonly<Record<string, string>> = {}): string {
  return overrides[id] ?? SHORTCUTS_BY_ID.get(id)?.combo ?? "";
}

// ---------------------------------------------------------------------------
// Matching keyboard events
// ---------------------------------------------------------------------------

export interface KeyEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const CODE_KEYS: Record<string, string> = {
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
  Backslash: "\\",
};

/**
 * The key an event means, layout-safe: letters and digits come from the
 * physical key (Option+C on a Mac types "ç" but means C), named keys from
 * event.key.
 */
export function eventKey(e: KeyEventLike): string {
  const code = e.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!.toLowerCase();
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1]!;
  if (e.key === "?") return "?";
  if (CODE_KEYS[code] && (e.ctrlKey || e.altKey || e.metaKey)) return CODE_KEYS[code]!;
  if (e.key === " ") return "Space";
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

/** Does one keydown match one step? ("?" ignores Shift: it takes Shift to type it.) */
export function stepMatches(step: KeyStep, e: KeyEventLike): boolean {
  const key = eventKey(e);
  if (key !== step.key) return false;
  if (step.key !== "?" && e.shiftKey !== step.shift) return false;
  if (e.altKey !== step.alt) return false;
  if (step.mod) return (e.metaKey || e.ctrlKey) && !(step.ctrl && !e.ctrlKey);
  return e.metaKey === false && e.ctrlKey === step.ctrl;
}

/** Single-step combo match (sequences are tracked by the host). */
export function comboMatches(text: string, e: KeyEventLike): boolean {
  try {
    const c = parseCombo(text);
    return c.length === 1 && stepMatches(c[0]!, e);
  } catch {
    return false;
  }
}

/** A KeyboardEventInit that reproduces a step (used to replay a default combo). */
export function stepToEventInit(step: KeyStep, mac: boolean): KeyboardEventInit {
  const isLetter = /^[a-z]$/.test(step.key);
  const isDigit = /^\d$/.test(step.key);
  return {
    key: step.key === "Space" ? " " : step.key,
    code: isLetter ? `Key${step.key.toUpperCase()}` : isDigit ? `Digit${step.key}` : undefined,
    metaKey: step.mod && mac,
    ctrlKey: step.ctrl || (step.mod && !mac),
    altKey: step.alt,
    shiftKey: step.shift,
    bubbles: true,
    cancelable: true,
  };
}
