"use client";

// ShapesOS — Phase 18.1 (WS=desk): the ⌃Tab app switcher.
//
// A modal over the page listing the member's recent apps and records (their
// dock's recents, then pins). Keyboard-first, like an OS switcher:
//   hold ⌃ and press Tab → it opens on the previous page; Tab / Shift+Tab
//   move; let go of ⌃ → that one opens. Esc cancels. ↵ opens, Shift+↵ opens
//   it next to the current page in split view. Arrow keys and the mouse work
//   too. Also reachable from the dock's "Switch" button and from ⌘K
//   ("Switch app" → /dashboard/switch, the same list as a page).
// The trigger is a registry shortcut (lib/keyboard/shortcuts.ts
// "switcher.open"), so it can be rebound; components/desk/ShortcutHost.tsx
// opens this with the key to hold and the key that cycles.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeftRight, Columns2, History } from "lucide-react";
import { cn } from "@/lib/utils";
import { KeyCaps } from "@/components/aos/AgentAvatar";
import { allNavItems, navItemVisible } from "@/lib/nav/config";
import { appForHref, RECENTS_SHOWN, type RecentItem } from "@/lib/desktop/recents";
import { OPEN_SWITCHER_EVENT, splitHref } from "./events";
import { useDock, type DockState } from "./useDock";

export interface SwitcherOpenDetail {
  /** The modifier to hold ("Control", "Alt", "Meta", "Shift"); null = a click (stays open). */
  holdKey?: string | null;
  /** The key that cycles while the modifier is held (e.g. "Tab", "`"). */
  cycleKey?: string | null;
}

export interface SwitcherEntry {
  href: string;
  title: string;
  kind: "app" | "record";
  hint: string;
}

/** The switcher's list: recents (newest first, not the current page), then pins, then a few apps. PURE. */
export function switcherEntries(
  recents: readonly RecentItem[],
  pinned: readonly string[],
  pathname: string,
  role: string | null | undefined,
  max = RECENTS_SHOWN,
): SwitcherEntry[] {
  const out: SwitcherEntry[] = [];
  const seen = new Set<string>([pathname]);
  for (const r of recents) {
    if (seen.has(r.href)) continue;
    seen.add(r.href);
    const app = appForHref(r.href);
    out.push({ href: r.href, title: r.title, kind: r.kind, hint: r.kind === "record" ? (app ? `${app.label} record` : "Record") : "App" });
    if (out.length >= max) return out;
  }
  const items = allNavItems().filter((i) => navItemVisible(i, role));
  const byHref = new Map(items.map((i) => [i.href, i]));
  for (const href of [...pinned, "/dashboard", "/dashboard/assistant", "/dashboard/approvals", "/dashboard/crm"]) {
    const item = byHref.get(href);
    if (!item || seen.has(href)) continue;
    seen.add(href);
    out.push({ href, title: item.label, kind: "app", hint: pinned.includes(href) ? "Pinned" : "App" });
    if (out.length >= max) return out;
  }
  return out;
}

export function AppSwitcher({ role, initialDock }: { role?: string | null; initialDock?: DockState | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const dock = useDock(initialDock ?? null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const hold = useRef<SwitcherOpenDetail>({ holdKey: null, cycleKey: null });
  const listRef = useRef<HTMLUListElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const entries = useMemo(() => switcherEntries(dock.recents, dock.pinned, pathname, role), [dock.recents, dock.pinned, pathname, role]);
  const entriesRef = useRef(entries);
  const activeRef = useRef(active);
  useEffect(() => {
    entriesRef.current = entries;
    activeRef.current = active;
  }, [entries, active]);

  const close = useCallback(() => {
    setOpen(false);
    hold.current = { holdKey: null, cycleKey: null };
    returnFocus.current?.focus?.();
  }, []);

  const go = useCallback(
    (index: number, split = false) => {
      const e = entriesRef.current[index];
      setOpen(false);
      hold.current = { holdKey: null, cycleKey: null };
      if (!e) return;
      router.push(split ? splitHref(pathname, e.href) : e.href);
    },
    [router, pathname],
  );

  // Open (from the shortcut host, the dock's button or the /dashboard/switch page).
  useEffect(() => {
    const onOpen = (ev: Event) => {
      const detail = ((ev as CustomEvent<SwitcherOpenDetail | null>).detail ?? {}) as SwitcherOpenDetail;
      if (open) {
        // The trigger again while open = next.
        setActive((a) => (entriesRef.current.length ? (a + 1) % entriesRef.current.length : 0));
        return;
      }
      returnFocus.current = document.activeElement as HTMLElement | null;
      hold.current = { holdKey: detail.holdKey ?? null, cycleKey: detail.cycleKey ?? null };
      setActive(0);
      setOpen(true);
      void dock.refresh();
    };
    window.addEventListener(OPEN_SWITCHER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SWITCHER_EVENT, onOpen);
  }, [open, dock]);

  // While open: own the keyboard (capture phase, so Tab never leaves the modal).
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => listRef.current?.focus());
    const n = () => Math.max(entriesRef.current.length, 1);
    const onKeyDown = (e: KeyboardEvent) => {
      const { cycleKey } = hold.current;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === "Tab" || (cycleKey && e.key === cycleKey)) {
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => (a + (e.shiftKey ? -1 : 1) + n()) % n());
      } else if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        setActive((a) => (a + 1) % n());
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        setActive((a) => (a - 1 + n()) % n());
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        go(activeRef.current, e.shiftKey);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      // Letting go of the held modifier opens the highlighted entry.
      if (hold.current.holdKey && e.key === hold.current.holdKey) go(activeRef.current);
    };
    const onBlur = () => {
      if (hold.current.holdKey) close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, close, go]);

  if (!open) return null;
  const activeId = entries[active] ? `switcher-opt-${active}` : undefined;
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-ink/40 px-4 pt-[12vh]" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-modal="true" aria-labelledby="switcher-title" className="w-full max-w-[520px] overflow-hidden rounded-lg bg-paper shadow-overlay" data-testid="app-switcher">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <ArrowLeftRight className="size-4 text-muted" aria-hidden />
          <h2 id="switcher-title" className="flex-1 text-base font-bold stretch-heading text-ink">
            Switch app
          </h2>
          <KeyCaps keys={["esc"]} />
        </div>
        {entries.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">Nothing recent yet. Pages and records you open show up here.</p>
        ) : (
          <ul
            ref={listRef}
            role="listbox"
            tabIndex={-1}
            aria-label="Recent apps and records"
            aria-activedescendant={activeId}
            className="max-h-[60vh] overflow-y-auto p-1.5 outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
          >
            {entries.map((e, i) => {
              const app = appForHref(e.href);
              const Icon = app?.icon ?? History;
              const on = i === active;
              return (
                <li
                  key={e.href}
                  id={`switcher-opt-${i}`}
                  role="option"
                  aria-selected={on}
                  onMouseEnter={() => setActive(i)}
                  onClick={(ev) => go(i, ev.shiftKey)}
                  className={cn("flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-3 py-1.5", on ? "bg-ink text-paper" : "text-ink hover:bg-hover-paper")}
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-semibold">{e.title}</span>
                    <span className={cn("aos-mono block truncate text-xs", on ? "text-night-soft" : "text-muted")}>{e.href}</span>
                  </span>
                  <span className={cn("shrink-0 text-xs", on ? "text-night-soft" : "text-muted")}>{e.hint}</span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2.5 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5">
            <KeyCaps keys={["Tab"]} /> Next
          </span>
          <span className="inline-flex items-center gap-1.5">
            <KeyCaps keys={["↵"]} /> Open
          </span>
          <span className="inline-flex items-center gap-1.5">
            <KeyCaps keys={["⇧", "↵"]} />
            <Columns2 className="size-3.5" aria-hidden /> Open beside this page
          </span>
        </div>
      </div>
    </div>
  );
}
