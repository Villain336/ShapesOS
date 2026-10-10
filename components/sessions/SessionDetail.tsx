"use client";

// ShapesOS — Phase 21A round 2 (WS=agentweb): one browsing session: controls, the step the agent is
// waiting on, a console to send a step while you are in control, and the replay from its receipts.
// Pause, take over, review each step and caps are editor+ (the API enforces it). Nothing here can
// pay, remove or sign in for you: your steps go through the same page-aware checks as the agent's.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, GraduationCap, Hand, Loader2, Pause, Play, RotateCcw, Send, ShieldCheck } from "lucide-react";
import { aosButton, NeutralBadge, StatusBadge } from "@/components/aos";
import { SwitchRow } from "@/components/aos/Controls";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toast, toastError } from "@/lib/ui/feedback";
import type { MessageKey } from "@/lib/i18n";
import type { SessionView } from "@/lib/agentweb/sessions/store";
import type { ReplayStep } from "@/lib/agentweb/sessions/replay";
import { statusLabelKey } from "./SessionsPanel";

interface Receipt {
  excerpt: string;
  url: string;
  domHash: string;
  verified: boolean;
  screenshotRef: string | null;
}

const TOOLS = ["browser_navigate", "browser_click", "browser_type", "browser_snapshot"] as const;

export function SessionDetail({ initial, replay: initialReplay, canSupervise }: { initial: SessionView; replay: ReplayStep[]; canSupervise: boolean }) {
  const { t, format } = useI18n();
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [replay, setReplay] = useState(initialReplay);
  const [busy, setBusy] = useState<string | null>(null);
  const [tool, setTool] = useState<(typeof TOOLS)[number]>("browser_snapshot");
  const [target, setTarget] = useState("");
  const [text, setText] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [caps, setCaps] = useState({ maxSteps: initial.maxSteps, maxSeconds: Math.round(initial.maxSeconds / 60), maxCredits: initial.maxCredits });
  const [open, setOpen] = useState<Record<string, Receipt | "loading" | "gone">>({});

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/agentweb/sessions/${s.runId}`, { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { session: SessionView; replay: ReplayStep[] };
      setS(body.session);
      setReplay(body.replay);
    } catch {
      /* next tick */
    }
  }, [s.runId]);
  useEffect(() => {
    if (!s.live) return;
    const h = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(h);
  }, [s.live, refresh]);

  async function op(label: string, body: Record<string, unknown>): Promise<{ result?: { ok: boolean; summary: string } } | null> {
    setBusy(label);
    try {
      const res = await fetch(`/api/agentweb/sessions/${s.runId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as { error?: string; session?: SessionView; result?: { ok: boolean; summary: string } };
      if (!res.ok) {
        toastError(t("sessionsApp.detail.failed"), json.error);
        return null;
      }
      if (json.session) setS(json.session);
      void refresh();
      return json;
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    const args: Record<string, unknown> = tool === "browser_navigate" ? { url: target } : tool === "browser_click" ? { ref: target } : tool === "browser_type" ? { ref: target, text } : {};
    const out = await op("step", { op: "step", tool, args });
    if (out?.result) {
      setResult(out.result.summary);
      setText("");
    }
  }

  async function toggleReceipt(captureId: string | null) {
    if (!captureId) return;
    if (open[captureId]) {
      setOpen((o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== captureId)));
      return;
    }
    setOpen((o) => ({ ...o, [captureId]: "loading" }));
    const res = await fetch(`/api/answer/captures/${captureId}`, { cache: "no-store" });
    if (!res.ok) return setOpen((o) => ({ ...o, [captureId]: "gone" }));
    const d = (await res.json()) as Receipt;
    setOpen((o) => ({ ...o, [captureId]: d }));
  }

  async function teach() {
    setBusy("teach");
    try {
      const res = await fetch("/api/agentweb/flows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "teach", runId: s.runId }) });
      const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string; flow?: { name: string } };
      if (!res.ok || !json.flow) {
        toastError(json.code === "nothing_to_teach" ? t("sessionsApp.detail.teachNone") : t("sessionsApp.detail.failed"), json.code === "nothing_to_teach" ? undefined : json.error);
        return;
      }
      toast({ title: t("sessionsApp.detail.teachDone", { name: json.flow.name }), status: "done", action: { label: t("flowsApp.title"), onClick: () => router.push("/dashboard/runs/sessions#flows") } });
    } finally {
      setBusy(null);
    }
  }

  const key = statusLabelKey(s);
  const human = s.control === "human";
  const disabled = !canSupervise || !s.live || busy !== null;

  return (
    <div className="flex flex-col gap-6">
      <div className="min-w-0">
        <Link href="/dashboard/runs/sessions" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden />
          {t("sessionsApp.title")}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="aos-heading">{t("sessionsApp.detail.title")}</h1>
          {s.status ? <StatusBadge status={s.status} label={t(`sessionsApp.status.${key}` as MessageKey)} /> : <NeutralBadge label={t(`sessionsApp.status.${key}` as MessageKey)} />}
          <NeutralBadge label={t(`sessionsApp.control.${s.control}` as MessageKey)} />
        </div>
        <p className="mt-1 break-all font-mono text-xs text-muted">{s.currentUrl ?? "—"}</p>
        <p className="mt-1 text-sm text-muted">
          {s.steps} / {s.maxSteps} · {s.credits} / {s.maxCredits} · {s.origins.length ? s.origins.join(", ") : "—"}
        </p>
      </div>

      {!s.live ? <p className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted" role="note">{t("sessionsApp.detail.finished")}</p> : null}
      {!canSupervise ? <p className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted" role="note">{t("sessionsApp.detail.readOnly")}</p> : null}

      {s.live ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div className="flex min-w-0 flex-col gap-4">
            {s.pending ? (
              <section aria-labelledby="ss-proposal" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline">
                <h2 id="ss-proposal" className="aos-subheading">{t("sessionsApp.detail.proposed")}</h2>
                <p className="text-md text-ink">{s.pending.summary}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={disabled} onClick={() => void op("approve", { op: "approve", proposalId: s.pending!.id }).then((o) => o?.result && setResult(o.result.summary))} className={aosButton({ variant: "primary", size: "md" })}>
                    {busy === "approve" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                    {t("sessionsApp.detail.approve")}
                  </button>
                  <button type="button" disabled={disabled} onClick={() => void op("reject", { op: "reject", proposalId: s.pending!.id })} className={aosButton({ variant: "secondary", size: "md" })}>
                    {t("sessionsApp.detail.reject")}
                  </button>
                </div>
              </section>
            ) : null}

            {human ? (
              <section aria-labelledby="ss-send" className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline">
                <h2 id="ss-send" className="aos-subheading">{t("sessionsApp.detail.sendStep")}</h2>
                <p className="text-sm text-muted">{t("sessionsApp.detail.humanHelp")}</p>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
                    {t("sessionsApp.detail.tool")}
                    <select value={tool} onChange={(e) => setTool(e.target.value as (typeof TOOLS)[number])} className="h-control rounded-md border-[1.5px] border-control bg-paper px-3 text-md font-normal text-ink outline-none focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]">
                      {TOOLS.map((x) => (
                        <option key={x} value={x}>{t(`sessionsApp.detail.tools.${x}` as MessageKey)}</option>
                      ))}
                    </select>
                  </label>
                  {tool !== "browser_snapshot" ? (
                    <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-sm font-semibold text-ink">
                      {t("sessionsApp.detail.urlOrRef")}
                      <input value={target} onChange={(e) => setTarget(e.target.value)} className="h-control rounded-md border-[1.5px] border-control bg-paper px-3 font-mono text-sm font-normal text-ink outline-none focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]" />
                    </label>
                  ) : null}
                  {tool === "browser_type" ? (
                    <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-sm font-semibold text-ink">
                      {t("sessionsApp.detail.text")}
                      <input value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" className="h-control rounded-md border-[1.5px] border-control bg-paper px-3 text-md font-normal text-ink outline-none focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]" />
                    </label>
                  ) : null}
                  <button type="button" disabled={disabled} onClick={() => void send()} className={aosButton({ variant: "primary", size: "md" })}>
                    {busy === "step" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
                    {busy === "step" ? t("sessionsApp.detail.sending") : t("sessionsApp.detail.send")}
                  </button>
                </div>
                {result ? (
                  <div>
                    <h3 className="text-sm font-semibold text-ink">{t("sessionsApp.detail.result")}</h3>
                    <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-canvas p-3 font-mono text-xs whitespace-pre-wrap text-ink">{result}</pre>
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>

          <aside className="flex min-w-0 flex-col gap-4 self-start">
            <section aria-labelledby="ss-controls" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline">
              <h2 id="ss-controls" className="aos-subheading">{t("sessionsApp.detail.controls")}</h2>
              {s.control === "paused" ? <p className="text-sm text-muted">{t("sessionsApp.detail.pausedHelp")}</p> : null}
              <div className="flex flex-wrap gap-2">
                {s.control === "paused" ? (
                  <button type="button" disabled={disabled} onClick={() => void op("resume", { op: "resume" })} className={aosButton({ variant: "primary", size: "md" })}>
                    <Play className="size-4" aria-hidden />
                    {t("sessionsApp.detail.resume")}
                  </button>
                ) : s.control === "agent" ? (
                  <button type="button" disabled={disabled} onClick={() => void op("pause", { op: "pause" })} className={aosButton({ variant: "secondary", size: "md" })}>
                    <Pause className="size-4" aria-hidden />
                    {t("sessionsApp.detail.pause")}
                  </button>
                ) : null}
                {s.control === "human" ? (
                  <button type="button" disabled={disabled} onClick={() => void op("handback", { op: "handback" })} className={aosButton({ variant: "primary", size: "md" })}>
                    <RotateCcw className="size-4" aria-hidden />
                    {t("sessionsApp.detail.handBack")}
                  </button>
                ) : (
                  <button type="button" disabled={disabled} onClick={() => void op("takeover", { op: "takeover" })} className={aosButton({ variant: "secondary", size: "md" })}>
                    <Hand className="size-4" aria-hidden />
                    {t("sessionsApp.detail.takeOver")}
                  </button>
                )}
              </div>
              <div className="-mx-4 border-y border-line">
                <SwitchRow title={t("sessionsApp.detail.reviewEach")} description={t("sessionsApp.detail.reviewEachHelp")} checked={s.stepMode === "approve_each"} disabled={disabled} onChange={(v) => void op("mode", { op: "step_mode", mode: v ? "approve_each" : "auto" })} />
              </div>
              <h3 className="mt-1 text-sm font-semibold text-ink">{t("sessionsApp.detail.caps")}</h3>
              <div className="grid grid-cols-3 gap-2">
                {(["maxSteps", "maxSeconds", "maxCredits"] as const).map((k) => (
                  <label key={k} className="flex flex-col gap-1 text-xs font-semibold text-muted">
                    {t(`sessionsApp.detail.${k === "maxSteps" ? "capSteps" : k === "maxSeconds" ? "capSeconds" : "capCredits"}` as MessageKey)}
                    <input type="number" min={1} value={caps[k]} disabled={disabled} onChange={(e) => setCaps((c) => ({ ...c, [k]: Number(e.target.value) }))} className="h-control rounded-md border-[1.5px] border-control bg-paper px-2 text-md font-normal text-ink tabular-nums outline-none focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]" />
                  </label>
                ))}
              </div>
              <button type="button" disabled={disabled} onClick={() => void op("caps", { op: "caps", maxSteps: caps.maxSteps, maxSeconds: caps.maxSeconds * 60, maxCredits: caps.maxCredits }).then((o) => o && toast({ title: t("sessionsApp.detail.capsSaved"), status: "done" }))} className={aosButton({ variant: "secondary", size: "sm" })}>
                {t("sessionsApp.detail.saveCaps")}
              </button>
            </section>
          </aside>
        </div>
      ) : null}

      <section aria-labelledby="ss-teach" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline sm:p-5">
        <h2 id="ss-teach" className="aos-subheading">{t("sessionsApp.detail.teach")}</h2>
        <p className="max-w-[72ch] text-sm text-muted">{t("sessionsApp.detail.teachHelp")}</p>
        <div>
          <button type="button" disabled={!canSupervise || busy !== null || s.steps === 0} onClick={() => void teach()} className={aosButton({ variant: "secondary", size: "sm" })}>
            {busy === "teach" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <GraduationCap className="size-4" aria-hidden />}
            {busy === "teach" ? t("sessionsApp.detail.teaching") : t("sessionsApp.detail.teachButton")}
          </button>
        </div>
      </section>

      <section aria-labelledby="ss-replay" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline sm:p-5">
        <h2 id="ss-replay" className="aos-subheading">{t("sessionsApp.detail.replay")}</h2>
        <p className="text-sm text-muted">{t("sessionsApp.detail.replayHelp")}</p>
        {replay.length === 0 ? (
          <p className="py-3 text-md text-muted">{t("sessionsApp.detail.noSteps")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <caption className="sr-only">{t("sessionsApp.detail.replay")}</caption>
              <thead>
                <tr className="text-xs text-muted">
                  <th scope="col" className="w-10 py-2 pr-2 font-semibold">#</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">{t("sessionsApp.detail.action")}</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">{t("sessionsApp.detail.where")}</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">{t("sessionsApp.detail.decision")}</th>
                  <th scope="col" className="py-2 font-semibold">{t("sessionsApp.detail.receipt")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {replay.map((r) => {
                  const o = r.captureId ? open[r.captureId] : undefined;
                  return (
                    <tr key={r.n} className="align-top hover:bg-hover-paper">
                      <td className="py-2 pr-2 tabular-nums text-muted">{r.n}</td>
                      <td className="py-2 pr-3 font-semibold text-ink">
                        {r.action}
                        <span className="block text-xs font-normal text-muted">{format.date(r.at, "time")}</span>
                      </td>
                      <td className="max-w-[22rem] py-2 pr-3 font-mono text-xs break-all text-muted">{r.url}</td>
                      <td className="py-2 pr-3">
                        <NeutralBadge label={`${t("sessionsApp.detail.tier", { n: r.tier })} · ${r.decision}`} size="sm" />
                      </td>
                      <td className="py-2">
                        {r.receipt ? (
                          <button type="button" onClick={() => void toggleReceipt(r.captureId)} className={aosButton({ variant: "quiet", size: "xs" })} aria-expanded={!!o}>
                            <ShieldCheck className="size-3.5" aria-hidden />
                            {r.receipt.verified ? t("sessionsApp.detail.verified") : t("sessionsApp.detail.unsigned")} · {t("sessionsApp.detail.openReceipt")}
                          </button>
                        ) : (
                          <span className="text-xs text-subtle">{t("sessionsApp.detail.expired")}</span>
                        )}
                        {o && o !== "loading" && o !== "gone" ? (
                          <div className="mt-2 flex flex-col gap-1.5 text-xs text-muted">
                            <p className="whitespace-pre-wrap text-ink">{o.excerpt}</p>
                            <p className="font-mono break-all">{o.domHash}</p>
                            {r.receipt?.hasScreenshot && r.captureId ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={`/api/agentweb/captures/${r.captureId}/screenshot`} alt={t("sessionsApp.detail.screenshot")} className="max-h-64 w-auto rounded-md border border-line" loading="lazy" />
                            ) : null}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
