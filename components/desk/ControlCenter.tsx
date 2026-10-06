"use client";

// ShapesOS — Phase 18.1 (WS=desk): Control Center (top-bar panel).
//
//   Agents        Pause all agents (admin+): the kill switch + every live run
//                 stopped; confirm first; audited. Resume when paused.
//   Focus         Do not disturb until an end time: notifications wait (they
//                 are queued, not dropped) and agent proposals wait in Needs
//                 you instead of interrupting.
//   Auto-approve  What runs on its own / asks / never — read-only, with the
//                 link to Settings → Automation. Money always asks.
//   Voice         On / off (stored for voice mode).
//   Spend today   Credits metered today, from the usage ledger.
// State: GET /api/desk/control (lib/desktop/control.server.ts).

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BellOff, Mic, ShieldCheck, SlidersHorizontal, Wallet, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { aosButton } from "@/components/aos/button";
import { Switch } from "@/components/aos/Controls";
import { StatusShape } from "@/components/aos/StatusShape";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import { FOCUS_PRESETS } from "@/lib/desktop/focus";
import type { ControlState } from "@/lib/desktop/control.server";
import { CONTROL_CHANGED_EVENT, OPEN_CONTROL_CENTER_EVENT, TOGGLE_FOCUS_EVENT, notifyControlChanged } from "./events";
// Phase 18.1 (integration): Control Center in the person's language and time zone.
import { useI18n } from "@/components/i18n/I18nProvider";
import type { Translator } from "@/lib/i18n";

async function call<T>(url: string, init: RequestInit, t: Translator): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? t("desk.control.requestFailed", { status: res.status }));
  return body;
}

function fetchControl(): Promise<ControlState | null> {
  return fetch("/api/desk/control", { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<ControlState>) : null))
    .catch(() => null); // keep the last good state
}

export function useControlState() {
  const [state, setState] = useState<ControlState | null>(null);
  const refresh = useCallback(() => fetchControl().then((s) => s && setState(s)), []);
  useEffect(() => {
    let live = true;
    const load = () => void fetchControl().then((s) => live && s && setState(s));
    load();
    window.addEventListener(CONTROL_CHANGED_EVENT, load);
    return () => {
      live = false;
      window.removeEventListener(CONTROL_CHANGED_EVENT, load);
    };
  }, []);
  return { state, setState, refresh };
}

export function ControlCenter() {
  const router = useRouter();
  const { t, format, ctx } = useI18n();
  const clock = (iso: string | null) => (iso ? format.date(iso, "time") || iso : "");
  const { state, setState, refresh } = useControlState();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(60);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const setFocus = useCallback(
    async (on: boolean, mins = minutes) => {
      setBusy("focus");
      try {
        const body = await call<ControlState["focus"] & { released?: number }>(
          "/api/desk/focus",
          { method: "PUT", body: JSON.stringify(on ? { minutes: mins } : { on: false }) },
          t,
        );
        setState((s) => (s ? { ...s, focus: { on: body.on, until: body.until, startedAt: body.startedAt, queued: body.queued } } : s));
        toast(
          on
            ? { title: t("desk.control.focusOnToast", { time: clock(body.until) }), description: t("desk.control.focusOnToastBody") }
            : { title: t("desk.control.focusOffToast"), description: body.released ? t("desk.control.delivered", { count: body.released }) : undefined },
        );
        notifyControlChanged();
      } catch (err) {
        toastError(t("desk.control.focusNotChanged"), err instanceof Error ? err.message : undefined);
      } finally {
        setBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [minutes, setState, t],
  );

  useEffect(() => {
    // Mounted twice (desktop top bar + mobile header): only the visible one answers the shortcuts.
    const visible = () => (triggerRef.current?.getClientRects().length ?? 0) > 0;
    const onOpen = () => {
      if (!visible()) return;
      setOpen(true);
      void refresh();
    };
    const onToggleFocus = () => {
      if (visible()) void setFocus(!stateRef.current?.focus.on, 60);
    };
    window.addEventListener(OPEN_CONTROL_CENTER_EVENT, onOpen);
    window.addEventListener(TOGGLE_FOCUS_EVENT, onToggleFocus);
    return () => {
      window.removeEventListener(OPEN_CONTROL_CENTER_EVENT, onOpen);
      window.removeEventListener(TOGGLE_FOCUS_EVENT, onToggleFocus);
    };
  }, [refresh, setFocus]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => panelRef.current?.focus());
    const onDown = (e: MouseEvent) => {
      // The confirm dialog renders outside; only close on clicks in the page.
      const t = e.target as Node;
      if (rootRef.current && !rootRef.current.contains(t) && !(t as HTMLElement).closest?.("[role=alertdialog],[role=dialog]")) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[role=alertdialog]")) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function pauseAll() {
    const ok = await confirmAction({
      title: t("desk.control.confirmTitle"),
      description: t("desk.control.confirmBody", { count: state?.liveRuns ?? 0 }),
      confirmLabel: t("desk.control.pauseAll"),
      destructive: true,
    });
    if (!ok) return;
    setBusy("pause");
    try {
      const body = await call<{ stopped: string[] }>("/api/desk/agents", { method: "POST", body: JSON.stringify({ action: "pause" }) }, t);
      toast({ title: t("desk.control.pausedToast"), description: t("desk.control.pausedToastBody", { count: body.stopped.length }) });
      notifyControlChanged();
      router.refresh();
    } catch (err) {
      toastError(t("desk.control.notPaused"), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  async function resume() {
    setBusy("pause");
    try {
      await call("/api/desk/agents", { method: "POST", body: JSON.stringify({ action: "resume" }) }, t);
      toast({ title: t("desk.control.resumedToast") });
      notifyControlChanged();
      router.refresh();
    } catch (err) {
      toastError(t("desk.control.notResumed"), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  async function setVoice(enabled: boolean) {
    setBusy("voice");
    try {
      const body = await call<{ voice: { enabled: boolean } }>("/api/desk/prefs", { method: "PATCH", body: JSON.stringify({ voice: { enabled } }) }, t);
      setState((s) => (s ? { ...s, voice: body.voice } : s));
    } catch (err) {
      toastError(t("desk.control.voiceNotSaved"), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  const paused = !!state?.paused;
  const focusOn = !!state?.focus.on;
  const row = "flex flex-col gap-2 border-b border-line px-4 py-3.5 last:border-b-0";

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void refresh();
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("desk.control.triggerLabel", { paused: paused ? "yes" : "no", focus: focusOn ? "yes" : "no" })}
        title={t("desk.control.hint")}
        data-testid="control-center-trigger"
        className={cn(
          "relative inline-flex h-10 items-center gap-2 rounded-full px-3 text-sm font-semibold text-ink transition-[background-color] duration-150 ease-aos hover:bg-hover",
          open && "bg-hover",
        )}
      >
        {paused ? <StatusShape status="paused" size={12} label={t("desk.control.agentsPaused")} /> : <SlidersHorizontal className="size-4" aria-hidden />}
        {focusOn ? (
          <span className="inline-flex items-center gap-1">
            <BellOff className="size-4" aria-hidden />
            <span className="hidden lg:inline">{t("desk.control.focus")}</span>
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label={t("desk.control.title")}
          tabIndex={-1}
          data-testid="control-center"
          className="absolute top-full right-0 z-50 mt-2 w-[380px] max-w-[calc(100vw-32px)] overflow-hidden rounded-lg bg-paper text-ink shadow-raised outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="text-base font-bold stretch-heading">{t("desk.control.title")}</span>
            <button type="button" onClick={() => setOpen(false)} aria-label={t("desk.control.close")} className="flex size-8 items-center justify-center rounded-full hover:bg-hover">
              <X className="size-4" aria-hidden />
            </button>
          </div>
          {!state ? (
            <p className="px-4 py-6 text-sm text-muted">{t("desk.control.loading")}</p>
          ) : (
            <div className="max-h-[70vh] overflow-y-auto">
              {/* Agents */}
              <section className={row} aria-labelledby="cc-agents">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="cc-agents" className="flex items-center gap-2 text-sm font-semibold">
                    {paused || state.liveRuns > 0 ? (
                      <StatusShape status={paused ? "paused" : "running"} size={10} label={paused ? t("desk.control.paused") : t("desk.control.running")} />
                    ) : null}
                    {paused
                      ? t("desk.control.agentsPaused")
                      : state.liveRuns > 0
                        ? t("desk.control.liveRuns", { count: state.liveRuns })
                        : t("desk.control.noAgents")}
                  </h3>
                  {state.canPause ? (
                    paused ? (
                      <button type="button" onClick={() => void resume()} disabled={busy === "pause"} className={aosButton({ variant: "run", size: "xs" })}>
                        {busy === "pause" ? t("desk.control.resuming") : t("desk.control.resume")}
                      </button>
                    ) : (
                      <button type="button" onClick={() => void pauseAll()} disabled={busy === "pause"} className={aosButton({ variant: "stop", size: "xs" })} data-testid="pause-all">
                        {busy === "pause" ? t("desk.control.pausing") : t("desk.control.pauseAll")}
                      </button>
                    )
                  ) : null}
                </div>
                <p className="text-xs text-muted">
                  {paused
                    ? t(state.canPause ? "desk.control.pausedSince" : "desk.control.pausedSinceAdmin", { time: clock(state.paused!.at) })
                    : state.canPause
                      ? t("desk.control.pauseHelp")
                      : t("desk.control.pauseAdminsOnly")}
                </p>
              </section>

              {/* Focus */}
              <section className={row} aria-labelledby="cc-focus">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="cc-focus" className="flex items-center gap-2 text-sm font-semibold">
                    <BellOff className="size-4 text-muted" aria-hidden />
                    {t("desk.control.dnd")}
                  </h3>
                  <Switch checked={focusOn} onChange={(v) => void setFocus(v)} disabled={busy === "focus"} label={t("desk.control.dnd")} />
                </div>
                {focusOn ? (
                  <p className="text-xs text-muted">
                    {t("desk.control.onUntil", { time: clock(state.focus.until) })}{" "}
                    {state.focus.queued > 0 ? `${t("desk.control.waiting", { count: state.focus.queued })} ` : ""}
                    {t("desk.control.proposalsWait")}
                  </p>
                ) : (
                  <label className="flex items-center gap-2 text-xs text-muted">
                    {t("desk.control.for")}
                    <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="h-8 rounded-md border-[1.5px] border-control bg-paper px-2 text-sm text-ink focus:border-focus focus:outline-none">
                      {FOCUS_PRESETS.map((p) => (
                        <option key={p.minutes} value={p.minutes}>
                          {p.minutes < 60 ? t("desk.control.minutes", { count: p.minutes }) : t("desk.control.hours", { count: p.minutes / 60 })}
                        </option>
                      ))}
                    </select>
                    {t("desk.control.nothingLost")}
                  </label>
                )}
              </section>

              {/* Auto-approve (read-only) */}
              <section className={row} aria-labelledby="cc-auto">
                <h3 id="cc-auto" className="flex items-center gap-2 text-sm font-semibold">
                  <ShieldCheck className="size-4 text-muted" aria-hidden />
                  {t("desk.control.autoApprove")}
                </h3>
                <p className="text-sm text-ink">
                  {t("desk.control.autoSummary", { auto: state.autoApprove.auto, ask: state.autoApprove.ask, never: state.autoApprove.never })}
                </p>
                <p className="text-xs text-muted">
                  {t("desk.control.moneyAsks")}{" "}
                  <Link href="/dashboard/settings/automation" className="font-semibold text-ink hover:underline" onClick={() => setOpen(false)}>
                    {t("desk.control.automationSettings")}
                  </Link>
                </p>
              </section>

              {/* Voice */}
              <section className={row} aria-labelledby="cc-voice">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="cc-voice" className="flex items-center gap-2 text-sm font-semibold">
                    <Mic className="size-4 text-muted" aria-hidden />
                    {t("desk.control.voice")}
                  </h3>
                  <Switch checked={state.voice.enabled} onChange={(v) => void setVoice(v)} disabled={busy === "voice"} label={t("desk.control.voice")} />
                </div>
                <p className="text-xs text-muted">{t("desk.control.voiceHelp")}</p>
              </section>

              {/* Spend today */}
              <section className={row} aria-labelledby="cc-spend">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="cc-spend" className="flex items-center gap-2 text-sm font-semibold">
                    <Wallet className="size-4 text-muted" aria-hidden />
                    {t("desk.control.spendToday")}
                  </h3>
                  <span className="text-base font-bold tabular-nums">{format.number(state.spendToday.usd, { style: "currency", currency: "USD" })}</span>
                </div>
                <p className="text-xs text-muted">
                  {t("desk.control.creditsToday", { count: state.spendToday.credits, zone: ctx.timeZone || "UTC" })}{" "}
                  <Link href="/dashboard/settings/usage" className="font-semibold text-ink hover:underline" onClick={() => setOpen(false)}>
                    {t("desk.control.usage")}
                  </Link>
                </p>
              </section>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
