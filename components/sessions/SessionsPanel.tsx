"use client";

// ShapesOS — Phase 21A round 2 (WS=agentweb): the Agent sessions panel.
//
// Every browsing session (an AgentRun that used the governed browser): the agent state shape,
// who is in control, step and credit use, the channel and the sites touched. Agent states only
// carry colour and shape (DESIGN.md); who is in control is a neutral badge.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Globe } from "lucide-react";
import { aosButton, NeutralBadge, StatusBadge } from "@/components/aos";
import { Segmented } from "@/components/aos/Controls";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n";
import type { SessionView } from "@/lib/agentweb/sessions/store";

export function statusLabelKey(s: Pick<SessionView, "status" | "control" | "needsReason" | "runStatus">): string {
  if (s.runStatus === "cancelled") return "cancelled";
  if (s.status === "failed") return "failed";
  if (s.status === "done") return "done";
  if (s.status === "queued") return "queued";
  if (s.needsReason) return s.needsReason;
  if (s.control === "paused") return "paused";
  return "running";
}

export function SessionsPanel({ initial }: { initial: SessionView[] }) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState(initial);
  const [show, setShow] = useState<"live" | "all">("live");

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/agentweb/sessions", { cache: "no-store" });
      if (res.ok) setSessions(((await res.json()) as { sessions: SessionView[] }).sessions);
    } catch {
      /* the next tick tries again */
    }
  }, []);
  useEffect(() => {
    const h = window.setInterval(() => void poll(), 5000);
    return () => window.clearInterval(h);
  }, [poll]);

  const rows = useMemo(() => (show === "live" ? sessions.filter((s) => s.live) : sessions), [sessions, show]);
  const channel = (c: string | null) => (c ? t(`sessionsApp.channels.${c}` as MessageKey) : t("sessionsApp.noChannel"));

  return (
    <div className="flex flex-col gap-6">
      <div className="min-w-0">
        <Link href="/dashboard/runs" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden />
          {t("sessionsApp.back")}
        </Link>
        <h1 className="aos-heading mt-1">{t("sessionsApp.title")}</h1>
        <p className="mt-1 max-w-[72ch] text-md text-muted">{t("sessionsApp.subtitle")}</p>
      </div>

      <section aria-label={t("sessionsApp.title")} className="flex min-w-0 flex-col gap-3 rounded-lg bg-paper p-3 shadow-hairline sm:p-4">
        <Segmented<"live" | "all"> value={show} onChange={setShow} label={t("sessionsApp.title")} options={[{ value: "live", label: t("sessionsApp.live") }, { value: "all", label: t("sessionsApp.all") }]} />
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-14 text-center">
            <Globe className="size-6 text-subtle" aria-hidden />
            <p className="text-md font-semibold text-ink">{show === "live" ? t("sessionsApp.emptyLive") : t("sessionsApp.emptyAll")}</p>
            <p className="max-w-[44ch] text-sm text-muted">{t("sessionsApp.emptyBody")}</p>
          </div>
        ) : (
          <div className="-mx-3 overflow-x-auto sm:-mx-4">
            <table className="w-full min-w-[52rem] border-collapse text-left text-sm">
              <caption className="sr-only">{t("sessionsApp.title")}</caption>
              <thead>
                <tr className="border-b border-line text-xs font-semibold text-muted">
                  <th scope="col" className="px-3 py-2 sm:pl-4">{t("sessionsApp.columns.session")}</th>
                  <th scope="col" className="px-3 py-2">{t("sessionsApp.columns.status")}</th>
                  <th scope="col" className="px-3 py-2">{t("sessionsApp.columns.control")}</th>
                  <th scope="col" className="px-3 py-2 text-right">{t("sessionsApp.columns.steps")}</th>
                  <th scope="col" className="px-3 py-2">{t("sessionsApp.columns.channel")}</th>
                  <th scope="col" className="px-3 py-2 text-right">{t("sessionsApp.columns.cost")}</th>
                  <th scope="col" className="px-3 py-2 sm:pr-4">
                    <span className="sr-only">{t("sessionsApp.columns.open")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => {
                  const key = statusLabelKey(s);
                  return (
                    <tr key={s.runId} className="border-b border-line last:border-b-0 hover:bg-hover-paper">
                      <td className="max-w-[24rem] px-3 py-2 align-top sm:pl-4">
                        <Link href={`/dashboard/runs/sessions/${s.runId}`} className="block truncate font-semibold text-ink underline-offset-2 hover:underline">
                          {s.agent ?? t("sessionsApp.unknownAgent")}
                          {s.currentUrl ? ` · ${s.currentUrl.replace(/^https?:\/\//, "")}` : ""}
                        </Link>
                        <span className="block truncate text-xs text-muted">{s.origins.length ? `${s.origins.length} · ${s.origins.map((o) => o.replace(/^https?:\/\//, "")).join(", ")}` : "—"}</span>
                      </td>
                      <td className="px-3 py-2 align-top">
                        {s.status ? <StatusBadge status={s.status} label={t(`sessionsApp.status.${key}` as MessageKey)} size="sm" /> : <NeutralBadge label={t(`sessionsApp.status.${key}` as MessageKey)} size="sm" />}
                      </td>
                      <td className="px-3 py-2 align-top"><NeutralBadge label={t(`sessionsApp.control.${s.control}` as MessageKey)} size="sm" /></td>
                      <td className="px-3 py-2 text-right align-top whitespace-nowrap tabular-nums text-ink">{s.steps} / {s.maxSteps}</td>
                      <td className="px-3 py-2 align-top text-muted">{channel(s.channel)}</td>
                      <td className="px-3 py-2 text-right align-top whitespace-nowrap tabular-nums text-ink">{s.credits} / {s.maxCredits}</td>
                      <td className="px-3 py-2 text-right align-top sm:pr-4">
                        <Link href={`/dashboard/runs/sessions/${s.runId}`} className={aosButton({ variant: "secondary", size: "xs" })}>
                          {t("sessionsApp.columns.open")}
                        </Link>
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
