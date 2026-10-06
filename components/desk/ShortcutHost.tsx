"use client";

// ShapesOS — Phase 18.1 (WS=desk): the keyboard host.
//
// One window listener (capture phase) for the registry in
// lib/keyboard/shortcuts.ts, honouring the member's rebindings:
//   - the desk's own shortcuts (⌃Tab switcher, "?" cheat-sheet, Control
//     Center, focus, split view, desktop editing) run here;
//   - the command bar's shortcuts (⌘K, ⌘N, ⌘J, G I, ⌥M, ⌥P, ⌥1–⌥6) keep
//     their handlers in components/command-bar/* (not edited): when the
//     member rebinds one, this host replays the default combo on the new
//     keys and swallows the old keys — a true rebind without a second
//     palette.
// Inside a split-view pane (window.top !== window) the pane bridge forwards
// the desk keys to the top window instead (the switcher and split commands
// live there).

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  SHORTCUTS,
  comboMatches,
  effectiveCombo,
  parseCombo,
  sanitizeOverrides,
  stepMatches,
  stepToEventInit,
  type KeyStep,
  type ShortcutDef,
} from "@/lib/keyboard/shortcuts";
import { isTypingTarget } from "@/components/command-bar/lib";
import {
  OPEN_CONTROL_CENTER_EVENT,
  OPEN_SHORTCUTS_EVENT,
  OPEN_SWITCHER_EVENT,
  SHORTCUTS_CHANGED_EVENT,
  TOGGLE_FOCUS_EVENT,
  splitHref,
} from "./events";
import { DESKTOP_EDIT_EVENT } from "@/components/desktop/Desktop";
import { SPLIT_COMMAND_EVENT, type SplitCommand } from "./SplitView";
import { ShortcutsDialog } from "./ShortcutsDialog";

const SEQUENCE_WINDOW_MS = 1200;
const MODIFIER_KEYS: Record<string, "Control" | "Alt" | "Meta" | "Shift"> = { ctrl: "Control", alt: "Alt", mod: "Control", shift: "Shift" };

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad/i.test(p);
}

/** Events this host dispatched itself (replays) — never handled twice. */
const replayed = new WeakSet<Event>();

function holdKeyOf(step: KeyStep, mac: boolean): string | null {
  if (step.ctrl) return "Control";
  if (step.mod) return mac ? "Meta" : "Control";
  if (step.alt) return "Alt";
  if (step.shift) return MODIFIER_KEYS.shift!;
  return null;
}

const SPLIT_COMMANDS: Record<string, SplitCommand> = {
  "split.swap": "swap",
  "split.close": "close",
  "split.focus_left": "focus-left",
  "split.focus_right": "focus-right",
  "split.shrink_left": "shrink-left",
  "split.grow_left": "grow-left",
};

export function ShortcutHost({ initialOverrides }: { initialOverrides: Record<string, string> }) {
  const router = useRouter();
  const pathname = usePathname();
  const [overrides, setOverrides] = useState(() => sanitizeOverrides(initialOverrides));
  const [helpOpen, setHelpOpen] = useState(false);
  const seq = useRef<{ id: string; at: number } | null>(null);
  const state = useRef({ overrides, pathname });
  useEffect(() => {
    state.current = { overrides, pathname };
  }, [overrides, pathname]);

  useEffect(() => {
    const onChanged = (e: Event) => setOverrides(sanitizeOverrides((e as CustomEvent<Record<string, string>>).detail));
    const onOpenHelp = () => setHelpOpen(true);
    window.addEventListener(SHORTCUTS_CHANGED_EVENT, onChanged);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpenHelp);
    return () => {
      window.removeEventListener(SHORTCUTS_CHANGED_EVENT, onChanged);
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpenHelp);
    };
  }, []);

  const runDesk = useCallback(
    (def: ShortcutDef, step: KeyStep, e: KeyboardEvent): boolean => {
      const path = state.current.pathname;
      const fire = (name: string, detail?: unknown) => window.dispatchEvent(new CustomEvent(name, { detail }));
      switch (def.id) {
        case "switcher.open":
          fire(OPEN_SWITCHER_EVENT, { holdKey: holdKeyOf(step, isMacPlatform()), cycleKey: step.key.length === 1 ? e.key : step.key });
          return true;
        case "help.shortcuts":
          setHelpOpen(true);
          return true;
        case "control.open":
          fire(OPEN_CONTROL_CENTER_EVENT);
          return true;
        case "focus.toggle":
          fire(TOGGLE_FOCUS_EVENT);
          return true;
        case "split.open":
          if (path === "/dashboard/split") return false;
          router.push(splitHref(path));
          return true;
        case "desktop.edit":
          if (path !== "/dashboard") return false;
          fire(DESKTOP_EDIT_EVENT);
          return true;
        default:
          if (SPLIT_COMMANDS[def.id] && path === "/dashboard/split") {
            fire(SPLIT_COMMAND_EVENT, SPLIT_COMMANDS[def.id]);
            return true;
          }
          return false;
      }
    },
    [router],
  );

  useEffect(() => {
    const mac = isMacPlatform();
    const replay = (def: ShortcutDef) => {
      // Re-send the default keys to the command bar's own handler.
      const steps = parseCombo(def.combo);
      const target = (document.activeElement as HTMLElement | null) ?? document.body;
      for (const s of steps) {
        const ev = new KeyboardEvent("keydown", stepToEventInit(s, mac));
        replayed.add(ev);
        target.dispatchEvent(ev);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (replayed.has(e) || e.defaultPrevented || e.repeat) return;
      const { overrides: ov } = state.current;
      const typing = isTypingTarget(e.target as HTMLElement | null);
      const now = Date.now();
      const hasMod = e.ctrlKey || e.metaKey || e.altKey;
      for (const def of SHORTCUTS) {
        if (!def.rebindable && def.owner === "desk") continue; // in-dialog keys are handled by their dialog
        const combos = [effectiveCombo(def.id, ov), ...(def.alternates ?? [])];
        for (const text of combos) {
          let steps: KeyStep[];
          try {
            steps = parseCombo(text);
          } catch {
            continue;
          }
          const first = steps[0]!;
          const bare = !first.mod && !first.ctrl && !first.alt;
          if (bare && typing) continue;
          let matched = false;
          if (steps.length === 1) {
            matched = stepMatches(first, e);
          } else if (!hasMod && !typing) {
            // Two-step sequence ("G I").
            const prev = seq.current;
            if (prev?.id === def.id && now - prev.at <= SEQUENCE_WINDOW_MS && stepMatches(steps[1]!, e)) {
              matched = true;
              seq.current = null;
            } else if (stepMatches(first, e)) {
              seq.current = { id: def.id, at: now };
            }
          }
          if (!matched) continue;
          if (def.owner === "desk") {
            if (runDesk(def, first, e)) {
              e.preventDefault();
              e.stopImmediatePropagation();
              return;
            }
            continue;
          }
          // A command-bar shortcut on rebound keys → replay its default keys.
          if (ov[def.id]) {
            e.preventDefault();
            e.stopImmediatePropagation();
            replay(def);
            return;
          }
        }
        // The old default of a rebound command-bar shortcut no longer fires it.
        if (def.owner === "command-bar" && ov[def.id] && !typing) {
          const steps = parseCombo(def.combo);
          if (steps.length === 1 && comboMatches(def.combo, e)) {
            const takenByOther = SHORTCUTS.some((o) => o.id !== def.id && effectiveCombo(o.id, ov) === def.combo);
            if (!takenByOther) {
              e.stopImmediatePropagation();
              return;
            }
          }
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [runDesk]);

  return (
    <ShortcutsDialog
      open={helpOpen}
      onOpenChange={setHelpOpen}
      overrides={overrides}
      onOverridesChange={(next) => setOverrides(sanitizeOverrides(next))}
    />
  );
}

/**
 * Inside a split-view pane: forward the desk's keys (and the modifier
 * releases the switcher waits for) to the top window, where the switcher
 * and the split commands live.
 */
export function PaneBridge({ initialOverrides }: { initialOverrides: Record<string, string> }) {
  useEffect(() => {
    if (window.top === window) return;
    const top = window.top as (Window & typeof globalThis) | null;
    if (!top) return;
    const overrides = sanitizeOverrides(initialOverrides);
    const forwarded = SHORTCUTS.filter((s) => s.owner === "desk" && s.rebindable && s.id !== "help.shortcuts");
    const clone = (e: KeyboardEvent) =>
      new top.KeyboardEvent(e.type, { key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, bubbles: true, cancelable: true });
    const onDown = (e: KeyboardEvent) => {
      const hit = forwarded.some((s) => [effectiveCombo(s.id, overrides), ...(s.alternates ?? [])].some((c) => comboMatches(c, e)));
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      try {
        top.dispatchEvent(clone(e));
      } catch {
        // the top window is not ours (should not happen) — ignore
      }
    };
    const onUp = (e: KeyboardEvent) => {
      if (!["Control", "Alt", "Meta", "Shift"].includes(e.key)) return;
      try {
        top.dispatchEvent(clone(e));
      } catch {
        // ignore
      }
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
    };
  }, [initialOverrides]);
  return null;
}
