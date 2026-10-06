"use client";

// ShapesOS — Phase 18.1 (WS=desk): split view.
//
// Two dashboard pages side by side — a record next to the Assistant, or two
// records — each in a same-origin pane (the dashboard layout drops its chrome
// inside a pane). The state is in the URL (lib/desktop/split.ts), so it
// survives a reload; navigating inside a pane updates the URL too.
// Keyboard (registry shortcuts, rebindable): ⌃⌥S swap, ⌃⌥W close the focused
// pane, ⌃⌥← / ⌃⌥→ focus a pane, ⌃⌥[ / ⌃⌥] move the divider; the divider is
// also a focusable separator (arrow keys). Inside a pane the same keys reach
// here through the pane bridge.

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, ExternalLink, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { aosButton } from "@/components/aos/button";
import { allNavItems, navItemVisible } from "@/lib/nav/config";
import { RATIO_MAX, RATIO_MIN, RATIO_STEP, clampRatio, nudgeRatio, sanitizePaneHref, splitUrl, swapPanes, type SplitState } from "@/lib/desktop/split";
import { recentTitle, type RecentItem } from "@/lib/desktop/recents";
// Phase 18.1 (integration): split view in the person's language.
import { useI18n } from "@/components/i18n/I18nProvider";

export const SPLIT_COMMAND_EVENT = "shapes:split-command";
export type SplitCommand = "swap" | "close" | "focus-left" | "focus-right" | "shrink-left" | "grow-left";

type Side = "left" | "right";

function PaneChooser({ side, value, recents, role, onChange }: { side: Side; value: string; recents: RecentItem[]; role: string; onChange: (href: string) => void }) {
  const { t, nav } = useI18n();
  const apps = allNavItems().filter((i) => navItemVisible(i, role));
  const known = new Set([...recents.map((r) => r.href), ...apps.map((a) => a.href)]);
  return (
    <label className="flex min-w-0 items-center gap-2">
      <span className="sr-only">{t("desk.split.paneShows", { pane: side === "left" ? t("desk.split.leftPane") : t("desk.split.rightPane") })}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 min-w-0 max-w-[16rem] truncate rounded-md border-[1.5px] border-control bg-paper px-2 text-sm font-semibold text-ink focus:border-focus focus:outline-none"
      >
        {!known.has(value) ? <option value={value}>{value}</option> : null}
        {recents.length ? (
          <optgroup label={t("desk.split.recent")}>
            {recents.map((r) => (
              <option key={`r:${r.href}`} value={r.href}>
                {r.kind === "app" ? nav(r.href, { label: r.title, description: "" }).label : r.title}
              </option>
            ))}
          </optgroup>
        ) : null}
        <optgroup label={t("desk.split.apps")}>
          {apps.map((a) => (
            <option key={`a:${a.href}`} value={a.href}>
              {nav(a.href, a).label}
            </option>
          ))}
        </optgroup>
      </select>
    </label>
  );
}

export function SplitView({ initial, recents, role }: { initial: SplitState; recents: RecentItem[]; role: string }) {
  const router = useRouter();
  const { t } = useI18n();
  const paneName = (side: Side) => (side === "left" ? t("desk.split.leftPane") : t("desk.split.rightPane"));
  const [state, setState] = useState(initial);
  // What each pane was told to load (state.left/right track where it is now:
  // a link inside a pane changes the URL, not the iframe's src — no reload).
  const [srcs, setSrcs] = useState({ left: initial.left, right: initial.right });
  const [focused, setFocused] = useState<Side>("left");
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const frames = { left: useRef<HTMLIFrameElement>(null), right: useRef<HTMLIFrameElement>(null) };
  const [titles, setTitles] = useState<Record<Side, string>>({ left: "", right: "" });
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Keep the URL in step (reload restores exactly this view).
  const sync = useCallback((next: SplitState) => {
    setState(next);
    window.history.replaceState(null, "", splitUrl(next));
  }, []);

  const closePane = useCallback(
    (side: Side) => {
      const other = side === "left" ? stateRef.current.right : stateRef.current.left;
      router.push(other);
    },
    [router],
  );

  const focusPane = useCallback((side: Side) => {
    setFocused(side);
    frames[side].current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(
    (cmd: SplitCommand) => {
      const s = stateRef.current;
      if (cmd === "swap") {
        setSrcs({ left: s.right, right: s.left });
        sync(swapPanes(s));
        setFocused((f) => (f === "left" ? "right" : "left"));
      } else if (cmd === "close") closePane(focused);
      else if (cmd === "focus-left") focusPane("left");
      else if (cmd === "focus-right") focusPane("right");
      else if (cmd === "shrink-left") sync(nudgeRatio(s, -RATIO_STEP));
      else if (cmd === "grow-left") sync(nudgeRatio(s, RATIO_STEP));
    },
    [sync, closePane, focusPane, focused],
  );

  useEffect(() => {
    const onCmd = (e: Event) => run((e as CustomEvent<SplitCommand>).detail);
    window.addEventListener(SPLIT_COMMAND_EVENT, onCmd);
    // Which pane has focus: a pane's iframe becomes document.activeElement.
    const onBlur = () =>
      window.setTimeout(() => {
        if (document.activeElement === frames.left.current) setFocused("left");
        else if (document.activeElement === frames.right.current) setFocused("right");
      }, 0);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener(SPLIT_COMMAND_EVENT, onCmd);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  // A pane navigated (a link inside it): remember where it is now.
  function onPaneLoad(side: Side) {
    const frame = frames[side].current;
    try {
      const loc = frame?.contentWindow?.location;
      const doc = frame?.contentDocument;
      if (!loc) return;
      // The same naming rule as recents: an app by its nav label, a record by its own title.
      if (doc) setTitles((t) => ({ ...t, [side]: recentTitle(loc.pathname, doc.title) }));
      const href = sanitizePaneHref(`${loc.pathname}${loc.search}`);
      if (href && href !== stateRef.current[side]) sync({ ...stateRef.current, [side]: href });
    } catch {
      // cross-origin (should not happen: panes are same-origin) — keep the URL as is
    }
  }

  function startDrag(e: ReactPointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    setDragging(true);
    const onMove = (ev: PointerEvent) => {
      const r = containerRef.current?.getBoundingClientRect();
      if (!r) return;
      const ratio = clampRatio(((ev.clientX - r.left) / r.width) * 100);
      setState((s) => ({ ...s, ratio }));
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      sync(stateRef.current);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const pane = (side: Side) => {
    const href = state[side];
    return (
      <section
        aria-label={paneName(side)}
        data-testid={`split-pane-${side}`}
        className={cn("flex min-h-[50dvh] min-w-0 flex-col overflow-hidden rounded-lg bg-paper shadow-hairline md:min-h-0", focused === side && "ring-2 ring-ink")}
        style={{ flexBasis: `${side === "left" ? state.ratio : 100 - state.ratio}%` }}
        onPointerDown={() => setFocused(side)}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
          <PaneChooser side={side} value={href} recents={recents} role={role} onChange={(h) => {
            const clean = sanitizePaneHref(h);
            if (!clean) return;
            setSrcs((x) => ({ ...x, [side]: clean }));
            sync({ ...state, [side]: clean });
          }} />
          <span className="min-w-0 flex-1 truncate text-sm text-muted">{titles[side]}</span>
          <a href={href} target="_top" className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink hover:bg-hover" aria-label={t("desk.split.openFull", { title: titles[side] || href })} title={t("desk.split.openFullHint")}>
            <ExternalLink className="size-4" aria-hidden />
          </a>
          <button type="button" onClick={() => closePane(side)} className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink hover:bg-hover" aria-label={side === "left" ? t("desk.split.closeLeft") : t("desk.split.closeRight")} title={t("desk.split.closeHint")}>
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <iframe
          ref={frames[side]}
          src={srcs[side]}
          title={titles[side] || paneName(side)}
          onLoad={() => onPaneLoad(side)}
          onFocus={() => setFocused(side)}
          className={cn("min-h-0 w-full flex-1 border-0 bg-canvas", dragging && "pointer-events-none")}
        />
      </section>
    );
  };

  return (
    <div className="flex h-full flex-col gap-3 p-3 md:p-4">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <h1 className="aos-subheading">{t("desk.split.title")}</h1>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => run("swap")} className={aosButton({ variant: "secondary", size: "sm" })} title={t("desk.split.swapHint")}>
            <ArrowLeftRight className="size-4" aria-hidden />
            {t("desk.split.swap")}
          </button>
        </div>
      </div>
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row md:gap-0">
        {pane("left")}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("desk.split.resize")}
          aria-valuenow={state.ratio}
          aria-valuemin={RATIO_MIN}
          aria-valuemax={RATIO_MAX}
          tabIndex={0}
          onPointerDown={startDrag}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              sync(nudgeRatio(state, -RATIO_STEP));
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              sync(nudgeRatio(state, RATIO_STEP));
            } else if (e.key === "Home") {
              e.preventDefault();
              sync({ ...state, ratio: RATIO_MIN });
            } else if (e.key === "End") {
              e.preventDefault();
              sync({ ...state, ratio: RATIO_MAX });
            }
          }}
          className="group hidden w-4 shrink-0 cursor-col-resize touch-none items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus md:flex"
        >
          <span aria-hidden className={cn("h-12 w-1 rounded-full bg-line-strong transition-colors duration-150 group-hover:bg-ink", dragging && "bg-ink")} />
        </div>
        {pane("right")}
      </div>
    </div>
  );
}
