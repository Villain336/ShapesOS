// ShapesOS — Phase 18.1 (WS=desk): window events between the shell's pieces
// (sidebar, top bar, switcher, cheat-sheet, Control Center, split view), so
// none of them imports another's internals.

export const OPEN_SWITCHER_EVENT = "shapes:switcher-open";
export const OPEN_SHORTCUTS_EVENT = "shapes:shortcuts-open";
export const OPEN_CONTROL_CENTER_EVENT = "shapes:control-center-open";
export const TOGGLE_FOCUS_EVENT = "shapes:focus-toggle";
export const SHORTCUTS_CHANGED_EVENT = "shapes:shortcuts-changed";
export const CONTROL_CHANGED_EVENT = "shapes:control-changed";

function fire(name: string, detail?: unknown) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(name, { detail }));
}

export const openAppSwitcher = () => fire(OPEN_SWITCHER_EVENT);
export const openShortcuts = () => fire(OPEN_SHORTCUTS_EVENT);
export const openControlCenter = () => fire(OPEN_CONTROL_CENTER_EVENT);
export const toggleFocus = () => fire(TOGGLE_FOCUS_EVENT);
export const notifyShortcutsChanged = (overrides: Record<string, string>) => fire(SHORTCUTS_CHANGED_EVENT, overrides);
export const notifyControlChanged = () => fire(CONTROL_CHANGED_EVENT);

/** Split view of a page next to another (default: the Assistant). */
export function splitHref(left: string, right = "/dashboard/assistant"): string {
  const p = new URLSearchParams({ left, right });
  return `/dashboard/split?${p.toString()}`;
}
