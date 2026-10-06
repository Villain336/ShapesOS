"use client";

// ShapesOS — Phase 18.1 (WS=desk): the app switcher as a page
// (/dashboard/switch — ⌘K "Switch app"). The same list as the ⌃Tab modal
// (switcherEntries), keyboard-first: ↑/↓ move, ↵ opens, Shift+↵ opens it
// beside the page you came from in split view.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Columns2, History } from "lucide-react";
import { cn } from "@/lib/utils";
import { KeyCaps } from "@/components/aos/AgentAvatar";
import { appForHref } from "@/lib/desktop/recents";
import { splitHref } from "./events";
import { switcherEntries } from "./AppSwitcher";
import { useDock, type DockState } from "./useDock";

export function SwitchList({ role, initialDock }: { role: string; initialDock: DockState }) {
  const router = useRouter();
  const dock = useDock(initialDock);
  const entries = switcherEntries(dock.recents, dock.pinned, "/dashboard/switch", role, 12);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => listRef.current?.focus(), []);

  function go(i: number, split: boolean) {
    const e = entries[i];
    if (!e) return;
    // "Beside" = next to the most recent other page (the one you came from).
    const from = entries.find((x) => x.href !== e.href)?.href ?? "/dashboard";
    router.push(split ? splitHref(from, e.href) : e.href);
  }

  return (
    <div className="flex flex-col gap-4">
      {entries.length === 0 ? (
        <p className="rounded-lg bg-paper p-6 text-sm text-muted shadow-hairline">Nothing recent yet. Pages and records you open show up here.</p>
      ) : (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={0}
          aria-label="Recent apps and records"
          aria-activedescendant={`switch-opt-${active}`}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => (a + 1) % entries.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a - 1 + entries.length) % entries.length);
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(active, e.shiftKey);
            }
          }}
          className="rounded-lg bg-paper p-1.5 shadow-hairline outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {entries.map((e, i) => {
            const Icon = appForHref(e.href)?.icon ?? History;
            const on = i === active;
            return (
              <li
                key={e.href}
                id={`switch-opt-${i}`}
                role="option"
                aria-selected={on}
                onMouseEnter={() => setActive(i)}
                onClick={(ev) => go(i, ev.shiftKey)}
                className={cn("flex min-h-12 cursor-pointer items-center gap-3 rounded-sm px-3 py-1.5", on ? "bg-ink text-paper" : "text-ink hover:bg-hover-paper")}
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
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <KeyCaps keys={["↑", "↓"]} /> Move
        </span>
        <span className="inline-flex items-center gap-1.5">
          <KeyCaps keys={["↵"]} /> Open
        </span>
        <span className="inline-flex items-center gap-1.5">
          <KeyCaps keys={["⇧", "↵"]} />
          <Columns2 className="size-3.5" aria-hidden /> Open beside the last page
        </span>
        <span>Anywhere: hold ⌃ and press Tab (or ⌃`).</span>
      </p>
    </div>
  );
}
