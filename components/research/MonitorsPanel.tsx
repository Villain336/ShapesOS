"use client";

// ShapesOS — Phase 21A round 2 (WS=agentweb): page monitors that start workflows.
// The monitors are Context.dev's. Linking one to a workflow means: when the page changes, the
// workflow starts with what changed. It runs as the person who linked it and has to be switched on.

import { useState } from "react";
import { Link2, Loader2, X } from "lucide-react";
import { aosButton, NeutralBadge } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toast, toastError } from "@/lib/ui/feedback";
import type { MessageKey } from "@/lib/i18n";

export interface MonitorRow {
  id: string;
  name: string;
  url: string;
  cadence: string;
  status: string;
  lastChangeAt: string | null;
}
export interface WorkflowRow {
  id: string;
  name: string;
  enabled: boolean;
  status: string;
}
export interface LinkRow {
  id: string;
  monitorId: string;
  workflowId: string;
  workflowName: string;
  enabled: boolean;
  firedCount: number;
  lastFiredAt: string | null;
  lastError: string | null;
}

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const res = await fetch("/api/agentweb/monitors", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export function MonitorsPanel({ monitors, workflows, links: initialLinks, canEdit }: { monitors: MonitorRow[]; workflows: WorkflowRow[]; links: LinkRow[]; canEdit: boolean }) {
  const { t, format } = useI18n();
  const [links, setLinks] = useState(initialLinks);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function link(monitorId: string) {
    const workflowId = pick[monitorId];
    if (!workflowId) return;
    setBusy(`link:${monitorId}`);
    try {
      const { ok, json } = await post({ op: "link", monitorId, workflowId });
      if (!ok) return toastError(t("monitorsApp.failed"), String(json.error ?? ""));
      const l = json.link as LinkRow;
      setLinks((all) => [...all.filter((x) => x.id !== l.id), l]);
      setPick((p) => ({ ...p, [monitorId]: "" }));
      toast({ title: t("monitorsApp.linked"), status: "done" });
    } finally {
      setBusy(null);
    }
  }

  async function unlink(l: LinkRow) {
    setBusy(`unlink:${l.id}`);
    try {
      const { ok, json } = await post({ op: "unlink", monitorId: l.monitorId, workflowId: l.workflowId });
      if (!ok) return toastError(t("monitorsApp.failed"), String(json.error ?? ""));
      setLinks((all) => all.filter((x) => x.id !== l.id));
      toast({ title: t("monitorsApp.unlinked"), status: "done" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="mon-title" className="flex min-w-0 flex-col gap-3 rounded-lg bg-paper p-3 shadow-hairline sm:p-4">
      <div>
        <h2 id="mon-title" className="aos-subheading">{t("monitorsApp.title")}</h2>
        <p className="mt-1 max-w-[72ch] text-sm text-muted">{t("monitorsApp.help")}</p>
        {!canEdit ? <p className="mt-2 text-sm text-muted" role="note">{t("monitorsApp.viewerOnly")}</p> : null}
      </div>
      {monitors.length === 0 ? (
        <div className="flex flex-col items-center gap-1 px-3 py-10 text-center">
          <p className="text-md font-semibold text-ink">{t("monitorsApp.empty")}</p>
          <p className="max-w-[52ch] text-sm text-muted">{t("monitorsApp.emptyBody")}</p>
        </div>
      ) : (
        <div className="-mx-3 overflow-x-auto sm:-mx-4">
          <table className="w-full min-w-[52rem] border-collapse text-left text-sm">
            <caption className="sr-only">{t("monitorsApp.title")}</caption>
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th scope="col" className="px-3 py-2 sm:pl-4">{t("monitorsApp.columns.monitor")}</th>
                <th scope="col" className="px-3 py-2">{t("monitorsApp.columns.cadence")}</th>
                <th scope="col" className="px-3 py-2">{t("monitorsApp.columns.lastChange")}</th>
                <th scope="col" className="px-3 py-2">{t("monitorsApp.columns.workflows")}</th>
                <th scope="col" className="px-3 py-2 sm:pr-4">{t("monitorsApp.columns.add")}</th>
              </tr>
            </thead>
            <tbody>
              {monitors.map((m) => {
                const mine = links.filter((l) => l.monitorId === m.id);
                return (
                  <tr key={m.id} className="border-b border-line align-top last:border-b-0 hover:bg-hover-paper">
                    <td className="max-w-[22rem] px-3 py-2 sm:pl-4">
                      <span className="block truncate font-semibold text-ink">{m.name}</span>
                      <span className="block truncate font-mono text-xs text-muted">{m.url.replace(/^https?:\/\//, "")}</span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        <NeutralBadge label={t(`monitorsApp.cadence.${m.cadence}` as MessageKey)} size="sm" />
                        <NeutralBadge label={t(`monitorsApp.status.${m.status === "active" ? "active" : "paused"}` as MessageKey)} size="sm" />
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-muted">{m.lastChangeAt ? format.date(m.lastChangeAt, "date") : t("monitorsApp.never")}</td>
                    <td className="px-3 py-2">
                      {mine.length === 0 ? (
                        <span className="text-muted">{t("monitorsApp.none")}</span>
                      ) : (
                        <ul className="flex flex-col gap-1.5">
                          {mine.map((l) => {
                            const wf = workflows.find((w) => w.id === l.workflowId);
                            return (
                              <li key={l.id} className="flex flex-col gap-0.5">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  <span className="font-semibold text-ink">{l.workflowName}</span>
                                  {wf && !(wf.enabled && wf.status === "active") ? <NeutralBadge label={t("monitorsApp.off")} size="sm" /> : null}
                                  <button type="button" disabled={!canEdit || busy !== null} aria-label={t("monitorsApp.unlink", { name: l.workflowName })} onClick={() => void unlink(l)} className="inline-flex size-6 items-center justify-center rounded-full hover:bg-hover disabled:opacity-60">
                                    {busy === `unlink:${l.id}` ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <X className="size-3.5" aria-hidden />}
                                  </button>
                                </span>
                                {l.firedCount > 0 ? <span className="text-xs text-muted">{t("monitorsApp.firedTimes", { n: l.firedCount })}</span> : null}
                                {l.lastError ? <span className="text-xs text-failed-text">{t("monitorsApp.lastError", { error: l.lastError })}</span> : null}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </td>
                    <td className="px-3 py-2 sm:pr-4">
                      {workflows.length === 0 ? (
                        <span className="text-xs text-muted">{t("monitorsApp.noWorkflows")}</span>
                      ) : (
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="sr-only" htmlFor={`mon-pick-${m.id}`}>{t("monitorsApp.pick")}</label>
                          <select id={`mon-pick-${m.id}`} value={pick[m.id] ?? ""} disabled={!canEdit || busy !== null} onChange={(e) => setPick((p) => ({ ...p, [m.id]: e.target.value }))} className="h-9 max-w-[14rem] rounded-md border-[1.5px] border-control bg-paper px-2 text-sm text-ink outline-none focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]">
                            <option value="">{t("monitorsApp.pick")}</option>
                            {workflows.map((w) => (
                              <option key={w.id} value={w.id}>{w.name}</option>
                            ))}
                          </select>
                          <button type="button" disabled={!canEdit || busy !== null || !pick[m.id]} onClick={() => void link(m.id)} className={aosButton({ variant: "secondary", size: "xs" })}>
                            {busy === `link:${m.id}` ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Link2 className="size-3.5" aria-hidden />}
                            {t("monitorsApp.link")}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
