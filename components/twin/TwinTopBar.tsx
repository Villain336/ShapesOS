// ShapesOS — Phase 13 (twinui): the twin's top bar — back to sites, the site
// switcher (menu), search over objects / bookings / shipments with fly-to,
// the Live indicator (live / reconnecting / polling) with a clock, and the
// "Edit layout" toggle for editors. The Live dot is a neutral ink mark: the
// connection is not an agent state.

"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronLeft, PencilRuler, Search, Warehouse, Factory, Store, Check } from "lucide-react";
import type { TwinSiteKind, TwinSnapshot } from "@/lib/twin/types";
import { MenuSurface, MenuRow, MenuLabel } from "@/components/aos/Menu";
import { aosButton } from "@/components/aos/button";
import { SITE_KIND_LABEL, searchTwin, type TwinSearchHit } from "@/lib/twin/view-model";
import { cn } from "@/lib/utils";
import type { TwinLiveStatus } from "./useTwinLive";

export interface TwinSiteSummary {
  id: string;
  kind: TwinSiteKind;
  status: "draft" | "published";
  name: string;
  code: string;
}

export const SITE_ICON = { warehouse: Warehouse, factory: Factory, store: Store } as const;

function useOutside(ref: React.RefObject<HTMLElement | null>, onOut: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOut();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [ref, onOut, active]);
}

function SiteSwitcher({ current, sites, hrefFor }: { current: TwinSnapshot["site"]; sites: TwinSiteSummary[]; hrefFor: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, () => setOpen(false), open);
  const Icon = SITE_ICON[current.kind];
  return (
    <div ref={ref} className="relative" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-11 items-center gap-2.5 rounded-full bg-paper pl-3 pr-3.5 text-left shadow-control hover:shadow-outline"
      >
        <Icon size={18} aria-hidden />
        <span className="min-w-0">
          <span className="stretch-heading block truncate text-base font-heading leading-tight text-ink">{current.name}</span>
          <span className="block text-xs leading-tight text-muted">
            <span className="aos-mono">{current.code}</span> · {SITE_KIND_LABEL[current.kind]}
          </span>
        </span>
        <ChevronDown size={16} aria-hidden className="text-muted" />
      </button>
      {open && (
        <MenuSurface label="Switch site" className="absolute left-0 top-12 z-40 w-80">
          <MenuLabel>Sites</MenuLabel>
          {sites.map((s) => {
            const SIcon = SITE_ICON[s.kind];
            const active = s.id === current.id;
            return (
              <Link
                key={s.id}
                href={hrefFor(s.id)}
                role="menuitem"
                onClick={() => setOpen(false)}
                className={cn(
                  "flex min-h-11 items-center gap-3 rounded-sm px-3 text-base font-medium",
                  active ? "bg-ink text-paper" : "text-ink hover:bg-hover-paper",
                )}
              >
                <SIcon size={16} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <span className={cn("aos-mono text-xs", active ? "text-night-soft" : "text-muted")}>{s.code}</span>
                {active ? <Check size={14} aria-hidden /> : null}
              </Link>
            );
          })}
          <MenuRow label="All sites" icon={ChevronLeft} onClick={() => (window.location.href = "/dashboard/ops/twin")} />
        </MenuSurface>
      )}
    </div>
  );
}

function TwinSearch({ snapshot, onPick }: { snapshot: TwinSnapshot; onPick: (hit: TwinSearchHit) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listId = useId();
  useOutside(ref, () => setOpen(false), open);
  const hits = useMemo(() => searchTwin(snapshot, q), [snapshot, q]);
  const choose = (h: TwinSearchHit | undefined) => {
    if (!h) return;
    onPick(h);
    setOpen(false);
  };
  return (
    <div ref={ref} className="relative min-w-[220px] flex-1 lg:max-w-[440px]">
      <Search size={16} aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
      <input
        type="search"
        role="combobox"
        aria-expanded={open && hits.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label="Search this site"
        placeholder="Search docks, trucks, forklifts, racks, shipments…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setCursor(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => Math.min(hits.length - 1, c + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(0, c - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(hits[cursor]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        className="h-11 w-full rounded-full border-[1.5px] border-control bg-paper pl-10 pr-4 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]"
      />
      {open && q.trim() && (
        <div className="absolute left-0 right-0 top-12 z-40 rounded-lg bg-paper p-1.5 shadow-raised">
          {hits.length === 0 ? (
            <p className="px-3 py-2.5 text-sm text-muted">No matches for &lsquo;{q.trim()}&rsquo; on this site.</p>
          ) : (
            <ul id={listId} role="listbox" aria-label="Search results">
              {hits.map((h, i) => (
                <li key={h.key} role="option" aria-selected={i === cursor} onMouseEnter={() => setCursor(i)} onClick={() => choose(h)} className={cn("flex min-h-11 cursor-pointer flex-col justify-center rounded-sm px-3 py-1.5", i === cursor ? "bg-ink text-paper" : "text-ink")}>
                  <span className="text-sm font-semibold">{h.title}</span>
                  <span className={cn("text-xs", i === cursor ? "text-night-soft" : "text-muted")}>{h.hint}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const LIVE_LABEL: Record<TwinLiveStatus, string> = {
  live: "Live",
  reconnecting: "Reconnecting",
  polling: "Polling",
  off: "Snapshot",
};

function LiveIndicator({ status, generatedAt }: { status: TwinLiveStatus; generatedAt: string }) {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  const updated = new Date(generatedAt);
  return (
    <div
      className="flex h-11 items-center gap-2 rounded-full bg-paper px-3.5 shadow-hairline"
      role="status"
      aria-live="polite"
      title={`${status === "off" ? "Live updates need the editor role. " : ""}Updated ${Number.isNaN(updated.getTime()) ? "—" : updated.toLocaleTimeString("en-GB")}`}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block h-2.5 w-2.5 rounded-full",
          status === "live" ? "bg-ink" : status === "reconnecting" ? "bg-paper shadow-[inset_0_0_0_2px_var(--aos-ink)]" : "bg-control",
        )}
      />
      <span className="text-sm font-semibold text-ink">{LIVE_LABEL[status]}</span>
      <span className="aos-mono text-xs tabular-nums text-muted" suppressHydrationWarning>
        {now ?? "--:--:--"}
      </span>
    </div>
  );
}

export function TwinTopBar({
  snapshot,
  sites,
  status,
  canEdit,
  editing,
  onToggleEdit,
  onPick,
  hrefBase = "/dashboard/ops/twin/",
}: {
  snapshot: TwinSnapshot;
  sites: TwinSiteSummary[];
  status: TwinLiveStatus;
  canEdit: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  onPick: (hit: TwinSearchHit) => void;
  hrefBase?: string;
}) {
  const hrefFor = (id: string) => `${hrefBase}${encodeURIComponent(id)}`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link href="/dashboard/ops/twin" aria-label="All sites" className="inline-flex h-11 w-11 items-center justify-center rounded-full text-ink hover:bg-hover">
        <ChevronLeft size={18} aria-hidden />
      </Link>
      <SiteSwitcher current={snapshot.site} sites={sites} hrefFor={hrefFor} />
      {snapshot.site.status === "draft" ? (
        <span className="inline-flex h-7 items-center rounded-full bg-paper px-3 text-xs font-semibold text-muted shadow-control">Draft</span>
      ) : null}
      <TwinSearch snapshot={snapshot} onPick={onPick} />
      <div className="ml-auto flex items-center gap-2">
        <LiveIndicator status={status} generatedAt={snapshot.generatedAt} />
        {canEdit ? (
          <button type="button" aria-pressed={editing} onClick={onToggleEdit} className={aosButton({ variant: editing ? "primary" : "secondary", size: "md" })}>
            <PencilRuler size={16} aria-hidden />
            {editing ? "Done editing" : "Edit layout"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
