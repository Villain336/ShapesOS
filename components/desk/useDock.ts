"use client";

// ShapesOS — Phase 18.1 (WS=desk): the member's dock on the client.
//
// Pins (an overlay on lib/nav/config.ts — only hrefs, in the member's order)
// and recents, server-rendered first (layout props), then kept fresh: a
// visit (RecentsTracker) or a pin change on one surface updates every
// mounted sidebar / switcher through one window event.

import { useCallback, useEffect, useState } from "react";
import { movePin, togglePin, type NavPrefs } from "@/lib/desktop/nav-overlay";
import type { RecentItem } from "@/lib/desktop/recents";
// Phase 18.1 (integration): its one message in the person's language.
import { useI18n } from "@/components/i18n/I18nProvider";

export const DOCK_CHANGED_EVENT = "shapes:dock-changed";

export interface DockState {
  pinned: string[];
  recents: RecentItem[];
}

/** Ask every mounted dock to re-read (after a visit was recorded). */
export function notifyDockChanged(next?: Partial<DockState>) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(DOCK_CHANGED_EVENT, { detail: next ?? null }));
}

// One read serves every mounted dock (the sidebar and the ⌃Tab switcher both
// listen for DOCK_CHANGED_EVENT): concurrent callers share the request in
// flight instead of each spending a request from the per-user read budget.
let dockInFlight: Promise<DockState | null> | null = null;

function fetchDock(): Promise<DockState | null> {
  if (dockInFlight) return dockInFlight;
  dockInFlight = fetch("/api/desk/dock", { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<DockState>) : null))
    .then((b) => (b ? { pinned: b.pinned ?? [], recents: b.recents ?? [] } : null))
    .catch(() => null) // keep the last good dock
    .finally(() => {
      dockInFlight = null;
    });
  return dockInFlight;
}

export function useDock(initial: DockState | null) {
  const { t } = useI18n();
  const [state, setState] = useState<DockState>(initial ?? { pinned: [], recents: [] });
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => fetchDock().then((d) => d && setState(d)), []);

  useEffect(() => {
    let live = true;
    const load = () => void fetchDock().then((d) => live && d && setState(d));
    if (!initial) load();
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<Partial<DockState> | null>).detail;
      if (detail) setState((s) => ({ ...s, ...detail }));
      else load();
    };
    window.addEventListener(DOCK_CHANGED_EVENT, onChanged);
    return () => {
      live = false;
      window.removeEventListener(DOCK_CHANGED_EVENT, onChanged);
    };
  }, [initial]);

  const savePins = useCallback(async (next: NavPrefs, prev: NavPrefs) => {
    setState((s) => ({ ...s, pinned: next.pinned }));
    setError(null);
    try {
      const res = await fetch("/api/desk/dock", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: next.pinned }),
      });
      const body = (await res.json().catch(() => ({}))) as { pinned?: string[]; error?: string };
      if (!res.ok || !body.pinned) throw new Error(body.error ?? t("desk.dock.notSaved"));
      notifyDockChanged({ pinned: body.pinned });
    } catch (err) {
      setState((s) => ({ ...s, pinned: prev.pinned }));
      setError(err instanceof Error ? err.message : t("desk.dock.notSaved"));
    }
  }, [t]);

  const toggle = useCallback(
    (href: string) => {
      const prev = { pinned: state.pinned };
      void savePins(togglePin(prev, href), prev);
    },
    [state.pinned, savePins],
  );

  const move = useCallback(
    (href: string, dir: -1 | 1) => {
      const prev = { pinned: state.pinned };
      void savePins(movePin(prev, href, dir), prev);
    },
    [state.pinned, savePins],
  );

  return { ...state, error, toggle, move, refresh };
}
