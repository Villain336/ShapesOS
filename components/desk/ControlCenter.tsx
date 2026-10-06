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

function clock(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

async function call<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status}).`);
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
        const body = await call<ControlState["focus"] & { released?: number }>("/api/desk/focus", {
          method: "PUT",
          body: JSON.stringify(on ? { minutes: mins } : { on: false }),
        });
        setState((s) => (s ? { ...s, focus: { on: body.on, until: body.until, startedAt: body.startedAt, queued: body.queued } } : s));
        toast(
          on
            ? { title: `Focus on until ${clock(body.until)}`, description: "Notifications wait until then. Proposals wait in Needs you." }
            : { title: "Focus off", description: body.released ? `${body.released} notification${body.released === 1 ? "" : "s"} delivered.` : undefined },
        );
        notifyControlChanged();
      } catch (err) {
        toastError("Focus did not change", err instanceof Error ? err.message : undefined);
      } finally {
        setBusy(null);
      }
    },
    [minutes, setState],
  );

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      void refresh();
    };
    const onToggleFocus = () => void setFocus(!stateRef.current?.focus.on, 60);
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
      title: "Pause all agents?",
      description: `Every agent in this workspace stops now${state?.liveRuns ? ` (${state.liveRuns} live)` : ""}, and none can start until someone resumes them. Work waiting for approval is dropped. This is recorded in the audit trail.`,
      confirmLabel: "Pause all agents",
      destructive: true,
    });
    if (!ok) return;
    setBusy("pause");
    try {
      const body = await call<{ stopped: string[] }>("/api/desk/agents", { method: "POST", body: JSON.stringify({ action: "pause" }) });
      toast({ title: "Agents paused", description: `${body.stopped.length} run${body.stopped.length === 1 ? "" : "s"} asked to stop.` });
      notifyControlChanged();
      router.refresh();
    } catch (err) {
      toastError("Agents were not paused", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  async function resume() {
    setBusy("pause");
    try {
      await call("/api/desk/agents", { method: "POST", body: JSON.stringify({ action: "resume" }) });
      toast({ title: "Agents resumed" });
      notifyControlChanged();
      router.refresh();
    } catch (err) {
      toastError("Agents were not resumed", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  async function setVoice(enabled: boolean) {
    setBusy("voice");
    try {
      const body = await call<{ voice: { enabled: boolean } }>("/api/desk/prefs", { method: "PATCH", body: JSON.stringify({ voice: { enabled } }) });
      setState((s) => (s ? { ...s, voice: body.voice } : s));
    } catch (err) {
      toastError("Voice setting not saved", err instanceof Error ? err.message : undefined);
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
        aria-label={`Control Center${paused ? ", agents paused" : ""}${focusOn ? ", focus on" : ""}`}
        title="Control Center (⌥⇧C)"
        data-testid="control-center-trigger"
        className={cn(
          "relative inline-flex h-10 items-center gap-2 rounded-full px-3 text-sm font-semibold text-ink transition-[background-color] duration-150 ease-aos hover:bg-hover",
          open && "bg-hover",
        )}
      >
        {paused ? <StatusShape status="paused" size={12} label="Agents paused" /> : <SlidersHorizontal className="size-4" aria-hidden />}
        {focusOn ? (
          <span className="inline-flex items-center gap-1">
            <BellOff className="size-4" aria-hidden />
            <span className="hidden lg:inline">Focus</span>
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Control Center"
          tabIndex={-1}
          data-testid="control-center"
          className="absolute top-full right-0 z-50 mt-2 w-[380px] max-w-[calc(100vw-32px)] overflow-hidden rounded-lg bg-paper text-ink shadow-raised outline-none"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="text-base font-bold stretch-heading">Control Center</span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close Control Center" className="flex size-8 items-center justify-center rounded-full hover:bg-hover">
              <X className="size-4" aria-hidden />
            </button>
          </div>
          {!state ? (
            <p className="px-4 py-6 text-sm text-muted">Loading…</p>
          ) : (
            <div className="max-h-[70vh] overflow-y-auto">
              {/* Agents */}
              <section className={row} aria-labelledby="cc-agents">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="cc-agents" className="flex items-center gap-2 text-sm font-semibold">
                    {paused || state.liveRuns > 0 ? <StatusShape status={paused ? "paused" : "running"} size={10} label={paused ? "Paused" : "Running"} /> : null}
                    {paused ? "Agents paused" : state.liveRuns > 0 ? `${state.liveRuns} agent run${state.liveRuns === 1 ? "" : "s"} live` : "No agents running"}
                  </h3>
                  {state.canPause ? (
                    paused ? (
                      <button type="button" onClick={() => void resume()} disabled={busy === "pause"} className={aosButton({ variant: "run", size: "xs" })}>
                        {busy === "pause" ? "Resuming" : "Resume"}
                      </button>
                    ) : (
                      <button type="button" onClick={() => void pauseAll()} disabled={busy === "pause"} className={aosButton({ variant: "stop", size: "xs" })} data-testid="pause-all">
                        {busy === "pause" ? "Pausing" : "Pause all agents"}
                      </button>
                    )
                  ) : null}
                </div>
                <p className="text-xs text-muted">
                  {paused
                    ? `Since ${clock(state.paused!.at)}. Nothing new starts until ${state.canPause ? "you resume" : "an admin resumes"}.`
                    : state.canPause
                      ? "Stops every run now and blocks new ones until you resume."
                      : "Only admins can pause every agent."}
                </p>
              </section>

              {/* Focus */}
              <section className={row} aria-labelledby="cc-focus">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="cc-focus" className="flex items-center gap-2 text-sm font-semibold">
                    <BellOff className="size-4 text-muted" aria-hidden />
                    Do not disturb
                  </h3>
                  <Switch checked={focusOn} onChange={(v) => void setFocus(v)} disabled={busy === "focus"} label="Do not disturb" />
                </div>
                {focusOn ? (
                  <p className="text-xs text-muted">
                    On until {clock(state.focus.until)}. {state.focus.queued > 0 ? `${state.focus.queued} notification${state.focus.queued === 1 ? "" : "s"} waiting. ` : ""}Agent proposals wait in Needs you.
                  </p>
                ) : (
                  <label className="flex items-center gap-2 text-xs text-muted">
                    For
                    <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="h-8 rounded-md border-[1.5px] border-control bg-paper px-2 text-sm text-ink focus:border-focus focus:outline-none">
                      {FOCUS_PRESETS.map((p) => (
                        <option key={p.minutes} value={p.minutes}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    — notifications wait, nothing is lost.
                  </label>
                )}
              </section>

              {/* Auto-approve (read-only) */}
              <section className={row} aria-labelledby="cc-auto">
                <h3 id="cc-auto" className="flex items-center gap-2 text-sm font-semibold">
                  <ShieldCheck className="size-4 text-muted" aria-hidden />
                  Auto-approve
                </h3>
                <p className="text-sm text-ink">
                  {state.autoApprove.auto} run on their own · {state.autoApprove.ask} ask first · {state.autoApprove.never} never
                </p>
                <p className="text-xs text-muted">
                  Money and irreversible actions always ask.{" "}
                  <Link href="/dashboard/settings/automation" className="font-semibold text-ink hover:underline" onClick={() => setOpen(false)}>
                    Automation settings
                  </Link>
                </p>
              </section>

              {/* Voice */}
              <section className={row} aria-labelledby="cc-voice">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="cc-voice" className="flex items-center gap-2 text-sm font-semibold">
                    <Mic className="size-4 text-muted" aria-hidden />
                    Voice
                  </h3>
                  <Switch checked={state.voice.enabled} onChange={(v) => void setVoice(v)} disabled={busy === "voice"} label="Voice" />
                </div>
                <p className="text-xs text-muted">Saved for voice mode. Nothing listens until voice mode ships.</p>
              </section>

              {/* Spend today */}
              <section className={row} aria-labelledby="cc-spend">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="cc-spend" className="flex items-center gap-2 text-sm font-semibold">
                    <Wallet className="size-4 text-muted" aria-hidden />
                    Spend today
                  </h3>
                  <span className="text-base font-bold tabular-nums">
                    {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(state.spendToday.usd)}
                  </span>
                </div>
                <p className="text-xs text-muted">
                  {state.spendToday.credits.toLocaleString()} credit{state.spendToday.credits === 1 ? "" : "s"} since midnight UTC.{" "}
                  <Link href="/dashboard/settings/usage" className="font-semibold text-ink hover:underline" onClick={() => setOpen(false)}>
                    Usage
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
