"use client";

// ShapesOS — Phase 18.1 (WS=desk): Home as a desktop.
//
// A 12-column grid of widgets the member arranges (layout per member per
// workspace, lib/desktop/layout.ts). The server renders each placed widget's
// content (components/desktop/widgets/views.tsx) and hands it in as
// `contents`; this component only places them and runs edit mode:
//   - add a widget (menu of the ones the role may place), remove one;
//   - move / resize by dragging the grip or the corner — or, equally, with
//     the keyboard: focus a widget, arrow keys move it, Shift + arrows
//     resize it, Delete removes it (and every action has a button too), so
//     nothing is drag-only;
//   - reset to the role's default.
// Every change is validated by the same engine the server uses and saved
// (PUT /api/desk/layout, debounced). On small screens widgets stack in
// reading order.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  GripVertical,
  LayoutGrid,
  Maximize2,
  Minimize2,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { aosButton } from "@/components/aos/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/vault/shadcn/dropdown-menu";
import { GRID_COLS, GRID_ROW_PX, WIDGETS, widgetsForRole, type WidgetId } from "@/lib/desktop/widgets";
import {
  addWidget,
  byReadingOrder,
  layoutRows,
  moveBy,
  placeWidget,
  removeWidget,
  resizeBy,
  validateLayout,
  type DesktopLayout,
  type Placement,
} from "@/lib/desktop/layout";
// Phase 18.1 (integration): the desktop's chrome in the person's language.
import { useI18n } from "@/components/i18n/I18nProvider";
import { widgetText, type Translator } from "@/lib/i18n";

export const DESKTOP_EDIT_EVENT = "shapes:desktop-edit";
const GAP_PX = 16;
const SAVE_DEBOUNCE_MS = 500;

type SaveState = "idle" | "saving" | "saved" | "error";

export function Desktop({
  initialLayout,
  customized,
  role,
  contents,
}: {
  initialLayout: DesktopLayout;
  customized: boolean;
  role: string;
  /** Server-rendered content per placed widget id. */
  contents: Partial<Record<WidgetId, ReactNode>>;
}) {
  const router = useRouter();
  const { t, messages } = useI18n();
  const titleOf = (id: WidgetId) => widgetText(messages, id).title ?? WIDGETS[id].title;
  const [layout, setLayout] = useState(initialLayout);
  const [isCustom, setIsCustom] = useState(customized);
  const [editing, setEditing] = useState(false);
  const [save, setSave] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [drag, setDrag] = useState<{ id: string; mode: "move" | "resize"; preview: DesktopLayout } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | null>(null);
  const loadedIds = useRef(new Set(Object.keys(contents)));
  // The server re-rendered (router.refresh after adding a widget): take its layout.
  const [prevInitial, setPrevInitial] = useState(initialLayout);
  if (prevInitial !== initialLayout) {
    setPrevInitial(initialLayout);
    setLayout(initialLayout);
  }
  useEffect(() => {
    loadedIds.current = new Set(Object.keys(contents));
  }, [contents]);

  // ⌥⇧E (lib/keyboard/shortcuts.ts "desktop.edit") toggles edit mode.
  useEffect(() => {
    const onEdit = () => setEditing((e) => !e);
    window.addEventListener(DESKTOP_EDIT_EVENT, onEdit);
    return () => window.removeEventListener(DESKTOP_EDIT_EVENT, onEdit);
  }, []);

  const persist = useCallback(
    (next: DesktopLayout) => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      setSave("saving");
      saveTimer.current = window.setTimeout(async () => {
        try {
          const res = await fetch("/api/desk/layout", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ layout: next }),
          });
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok) throw new Error(body.error ?? t("desk.desktop.notSaved"));
          setSave("saved");
          setSaveError(null);
          setIsCustom(true);
          // A widget added in edit mode has no content yet: load it.
          if (next.widgets.some((w) => !loadedIds.current.has(w.widget))) router.refresh();
        } catch (err) {
          setSave("error");
          setSaveError(err instanceof Error ? err.message : t("desk.desktop.notSaved"));
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [router, t],
  );

  const commit = useCallback(
    (next: DesktopLayout, message: string) => {
      const v = validateLayout(next, role);
      if (!v.ok) {
        // The engine's reasons are English; the live region says it in the person's language.
        setAnnounce(t("desk.desktop.doesntFit"));
        return;
      }
      setLayout(v.layout);
      setAnnounce(message);
      persist(v.layout);
    },
    [persist, role, t],
  );

  const describe = (p: Placement | undefined) =>
    p ? t("desk.desktop.position", { title: titleOf(p.widget), x: p.x + 1, y: p.y + 1, w: p.w, h: p.h }) : "";

  const move = (id: string, dx: number, dy: number) => {
    const next = moveBy(layout, id, dx, dy);
    commit(next, t("desk.desktop.moved", { position: describe(next.widgets.find((w) => w.id === id)) }));
  };
  const resize = (id: string, dw: number, dh: number) => {
    const next = resizeBy(layout, id, dw, dh);
    commit(next, t("desk.desktop.resized", { position: describe(next.widgets.find((w) => w.id === id)) }));
  };
  const remove = (id: string) => {
    const p = layout.widgets.find((w) => w.id === id);
    commit(removeWidget(layout, id), p ? t("desk.desktop.removed", { title: titleOf(p.widget) }) : t("desk.desktop.removedWidget"));
  };
  const add = (id: WidgetId) => {
    const next = addWidget(layout, id);
    commit(next, t("desk.desktop.added", { title: titleOf(id), position: describe(next.widgets.find((w) => w.widget === id)) }));
  };

  async function reset() {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    setSave("saving");
    try {
      const res = await fetch("/api/desk/layout", { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { layout?: DesktopLayout; error?: string };
      if (!res.ok || !body.layout) throw new Error(body.error ?? t("desk.desktop.notReset"));
      setLayout(body.layout);
      setIsCustom(false);
      setSave("saved");
      setAnnounce(t("desk.desktop.resetDone"));
      router.refresh();
    } catch (err) {
      setSave("error");
      setSaveError(err instanceof Error ? err.message : t("desk.desktop.notReset"));
    }
  }

  // ---- pointer drag (move with the grip, resize with the corner) ----------

  function cellFromPointer(clientX: number, clientY: number) {
    const el = gridRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const colW = (r.width - GAP_PX * (GRID_COLS - 1)) / GRID_COLS;
    return {
      col: Math.floor((clientX - r.left + GAP_PX / 2) / (colW + GAP_PX)),
      row: Math.floor((clientY - r.top + GAP_PX / 2) / (GRID_ROW_PX + GAP_PX)),
    };
  }

  function startDrag(e: ReactPointerEvent, id: string, mode: "move" | "resize") {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = layout.widgets.find((w) => w.id === id);
    const origin = cellFromPointer(e.clientX, e.clientY);
    if (!start || !origin) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const base = layout;
    const onMove = (ev: PointerEvent) => {
      const c = cellFromPointer(ev.clientX, ev.clientY);
      if (!c) return;
      const dc = c.col - origin.col;
      const dr = c.row - origin.row;
      const preview =
        mode === "move"
          ? placeWidget(base, { ...start, x: start.x + dc, y: start.y + dr })
          : placeWidget(base, { ...start, w: start.w + dc, h: start.h + dr });
      latest = preview;
      setDrag({ id, mode, preview });
    };
    let latest: DesktopLayout | null = null;
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrag(null);
      if (latest) {
        const p = latest.widgets.find((w) => w.id === id);
        commit(latest, t(mode === "move" ? "desk.desktop.moved" : "desk.desktop.resized", { position: describe(p) }));
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ---- keyboard on a focused widget (edit mode) --------------------------

  function onWidgetKey(e: ReactKeyboardEvent, id: string) {
    if (!editing || e.target !== e.currentTarget) return;
    const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const v = d[e.key];
    if (v) {
      e.preventDefault();
      if (e.shiftKey) resize(id, v[0], v[1]);
      else move(id, v[0], v[1]);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove(id);
    }
  }

  const shown = drag?.preview ?? layout;
  const rows = Math.max(layoutRows(shown), 1);
  const placed = new Set(layout.widgets.map((w) => w.widget));
  const addable = widgetsForRole(role).filter((w) => !placed.has(w.id));
  const ordered = useMemo(() => [...shown.widgets].sort(byReadingOrder), [shown]);

  return (
    <section aria-label={t("desk.desktop.region")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted" aria-live="polite">
          {editing ? t("desk.desktop.editHelp") : isCustom ? t("desk.desktop.yours") : t("desk.desktop.roleDefault")}
          {save === "saving" ? t("desk.desktop.savingSuffix") : save === "saved" && editing ? t("desk.desktop.savedSuffix") : ""}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger className={aosButton({ variant: "secondary", size: "sm" })} disabled={addable.length === 0}>
                  <Plus className="size-4" aria-hidden />
                  {t("desk.desktop.addWidget")}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={6} className="w-80 rounded-lg bg-paper p-1.5 text-ink shadow-raised ring-0">
                  <DropdownMenuLabel className="px-3 pt-2 pb-1 text-xs font-semibold text-muted">{t("desk.desktop.addTo")}</DropdownMenuLabel>
                  {addable.map((w) => {
                    const Icon = w.icon;
                    const text = widgetText(messages, w.id);
                    return (
                      <DropdownMenuItem key={w.id} className="min-h-12 gap-3 rounded-sm px-3" onClick={() => add(w.id)}>
                        <Icon className="size-4 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block text-base font-semibold">{text.title ?? w.title}</span>
                          <span className="block truncate text-xs text-muted">{text.description ?? w.description}</span>
                        </span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
              <button type="button" onClick={() => void reset()} className={aosButton({ variant: "quiet", size: "sm" })} disabled={!isCustom}>
                <RotateCcw className="size-4" aria-hidden />
                {t("desk.desktop.reset")}
              </button>
              <button type="button" onClick={() => setEditing(false)} className={aosButton({ variant: "primary", size: "sm" })}>
                <Check className="size-4" aria-hidden />
                {t("desk.desktop.done")}
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setEditing(true)} className={aosButton({ variant: "secondary", size: "sm" })} title={t("desk.desktop.editHint")}>
              <LayoutGrid className="size-4" aria-hidden />
              {t("desk.desktop.edit")}
            </button>
          )}
        </div>
      </div>

      {saveError ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-failed-text">
          <span aria-hidden className="mt-1.5 size-2 shrink-0 bg-failed" />
          {saveError}
        </p>
      ) : null}
      <p className="sr-only" aria-live="assertive">
        {announce}
      </p>

      {layout.widgets.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-lg bg-paper p-6 shadow-hairline">
          <p className="aos-subheading">{t("desk.desktop.emptyTitle")}</p>
          <p className="text-sm text-muted">{t("desk.desktop.emptyBody")}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setEditing(true)} className={aosButton({ variant: "primary", size: "sm" })}>
              <Plus className="size-4" aria-hidden /> {t("desk.desktop.addWidgets")}
            </button>
            <button type="button" onClick={() => void reset()} className={aosButton({ variant: "secondary", size: "sm" })}>
              {t("desk.desktop.reset")}
            </button>
          </div>
        </div>
      ) : null}

      <div
        ref={gridRef}
        data-testid="desktop-grid"
        className={cn("flex flex-col gap-4 md:grid md:grid-cols-12", editing && "md:rounded-lg md:bg-hover md:p-2 md:-m-2")}
        style={{ gridAutoRows: `${GRID_ROW_PX}px`, gridTemplateRows: `repeat(${rows}, ${GRID_ROW_PX}px)` }}
      >
        {ordered.map((p) => {
          const def = WIDGETS[p.widget];
          const title = titleOf(p.widget);
          const Icon = def.icon;
          const content = contents[p.widget];
          const active = drag?.id === p.id;
          return (
            <article
              key={p.id}
              data-widget={p.widget}
              data-pos={`${p.x},${p.y},${p.w},${p.h}`}
              aria-label={t("desk.desktop.widgetLabel", { title })}
              aria-roledescription={editing ? t("desk.desktop.movable") : undefined}
              aria-describedby={editing ? `desk-help` : undefined}
              tabIndex={editing ? 0 : undefined}
              onKeyDown={(e) => onWidgetKey(e, p.id)}
              className={cn(
                "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg bg-paper shadow-hairline",
                editing && "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2",
                active && "ring-2 ring-ink",
              )}
              style={{ gridColumn: `${p.x + 1} / span ${p.w}`, gridRow: `${p.y + 1} / span ${p.h}` }}
            >
              <header className="flex shrink-0 items-center gap-2 px-4 pt-3 pb-2">
                {editing ? (
                  <button
                    type="button"
                    aria-label={t("desk.desktop.drag", { title })}
                    title={t("desk.desktop.dragToMove")}
                    onPointerDown={(e) => startDrag(e, p.id, "move")}
                    className="-ml-1.5 flex size-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-full text-muted hover:bg-hover active:cursor-grabbing"
                  >
                    <GripVertical className="size-4" aria-hidden />
                  </button>
                ) : (
                  <Icon className="size-4 shrink-0 text-muted" aria-hidden />
                )}
                <h2 className="min-w-0 flex-1 truncate text-base font-bold stretch-heading tracking-heading text-ink">{title}</h2>
                {editing ? null : (
                  <Link href={def.href} className="shrink-0 rounded-full px-2 py-1 text-sm font-semibold text-ink hover:bg-hover">
                    {t("desk.desktop.open")}
                  </Link>
                )}
              </header>
              {editing ? (
                <div className="shrink-0 border-b border-line px-3 pb-2">
                  <WidgetEditButtons
                    t={t}
                    title={title}
                    onMove={(dx, dy) => move(p.id, dx, dy)}
                    onResize={(dw, dh) => resize(p.id, dw, dh)}
                    onRemove={() => remove(p.id)}
                  />
                </div>
              ) : null}
              <div className={cn("min-h-0 flex-1 overflow-auto px-4 pb-4", editing && "pointer-events-none select-none opacity-70")} aria-hidden={editing || undefined}>
                {content ?? <p className="text-sm text-muted">{editing ? t("desk.desktop.loadsAfterEdit") : t("desk.desktop.loading")}</p>}
              </div>
              {editing ? (
                <button
                  type="button"
                  aria-label={t("desk.desktop.resize", { title })}
                  title={t("desk.desktop.dragToResize")}
                  onPointerDown={(e) => startDrag(e, p.id, "resize")}
                  className="hidden size-6 shrink-0 cursor-nwse-resize touch-none self-end text-muted md:flex md:items-center md:justify-center"
                >
                  <svg viewBox="0 0 10 10" className="size-3" aria-hidden>
                    <path d="M9 1 1 9M9 5 5 9" stroke="currentColor" strokeWidth="1.5" fill="none" />
                  </svg>
                </button>
              ) : null}
            </article>
          );
        })}
      </div>
      <p id="desk-help" className="sr-only">
        {t("desk.desktop.keyboardHelp")}
      </p>
    </section>
  );
}

function WidgetEditButtons({
  t,
  title,
  onMove,
  onResize,
  onRemove,
}: {
  t: Translator;
  title: string;
  onMove: (dx: number, dy: number) => void;
  onResize: (dw: number, dh: number) => void;
  onRemove: () => void;
}) {
  const btn = "flex size-8 shrink-0 items-center justify-center rounded-full text-ink hover:bg-hover";
  return (
    <div className="flex flex-wrap items-center gap-0.5" role="group" aria-label={t("desk.desktop.arrange", { title })}>
      <button type="button" className={btn} aria-label={t("desk.desktop.moveLeft", { title })} onClick={() => onMove(-1, 0)}>
        <ArrowLeft className="size-3.5" aria-hidden />
      </button>
      <button type="button" className={btn} aria-label={t("desk.desktop.moveUp", { title })} onClick={() => onMove(0, -1)}>
        <ArrowUp className="size-3.5" aria-hidden />
      </button>
      <button type="button" className={btn} aria-label={t("desk.desktop.moveDown", { title })} onClick={() => onMove(0, 1)}>
        <ArrowDown className="size-3.5" aria-hidden />
      </button>
      <button type="button" className={btn} aria-label={t("desk.desktop.moveRight", { title })} onClick={() => onMove(1, 0)}>
        <ArrowRight className="size-3.5" aria-hidden />
      </button>
      <button type="button" className={btn} aria-label={t("desk.desktop.smaller", { title })} onClick={() => onResize(-1, -1)}>
        <Minimize2 className="size-3.5" aria-hidden />
      </button>
      <button type="button" className={btn} aria-label={t("desk.desktop.bigger", { title })} onClick={() => onResize(1, 1)}>
        <Maximize2 className="size-3.5" aria-hidden />
      </button>
      <button type="button" className={cn(btn, "text-failed-text hover:bg-failed-tint")} aria-label={t("desk.desktop.remove", { title })} onClick={onRemove}>
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
