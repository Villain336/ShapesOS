"use client";

// ShapesOS — Phase 21A round 2 (WS=agentweb): taught flows. A flow is a draft until a person
// publishes it (a click here; the API refuses any other channel). "Make a workflow draft" sends the
// validated draft through the Automations app's own routes, so it lands there switched off.
// Flow state (draft / published) is not an agent state: neutral badges only, no status shapes.

import { useState } from "react";
import { Loader2, Rocket, Workflow } from "lucide-react";
import { aosButton, NeutralBadge } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toast, toastError } from "@/lib/ui/feedback";
import type { MessageKey } from "@/lib/i18n";
import type { FlowView } from "@/lib/agentweb/flows/store";
import { workflowGraphBody } from "@/lib/automations/model";
import type { AutomationDraft } from "@/lib/automations/describe";

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const res = await fetch("/api/agentweb/flows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: res.ok, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export function FlowsPanel({ initial, canEdit }: { initial: FlowView[]; canEdit: boolean }) {
  const { t, format } = useI18n();
  const [flows, setFlows] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);

  const swap = (f: FlowView) => setFlows((all) => all.map((x) => (x.id === f.id ? f : x)));

  async function change(f: FlowView, op: "publish" | "unpublish") {
    setBusy(`${op}:${f.id}`);
    try {
      const { ok, json } = await post({ op, id: f.id, channel: "ui_click" });
      if (!ok) return toastError(t("flowsApp.failed"), String(json.error ?? ""));
      const next = json.flow as FlowView;
      swap(next);
      toast({ title: t(op === "publish" ? "flowsApp.published" : "flowsApp.unpublished", { name: next.name }), status: "done" });
    } finally {
      setBusy(null);
    }
  }

  async function makeWorkflow(f: FlowView) {
    setBusy(`workflow:${f.id}`);
    try {
      const { ok, json } = await post({ op: "workflow", id: f.id });
      if (!ok) return toastError(t("flowsApp.failed"), String(json.error ?? ""));
      const d = json.draft as AutomationDraft;
      if (d.format !== "workflow") return;
      const created = await fetch("/api/workflows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: d.workflow.projectId, name: d.name, description: d.why.slice(0, 500) }) });
      const made = (await created.json().catch(() => ({}))) as { workflow?: { id?: string }; error?: string };
      if (!created.ok || !made.workflow?.id) return toastError(t("flowsApp.failed"), made.error);
      const graph = await fetch(`/api/workflows/${encodeURIComponent(made.workflow.id)}/nodes`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(workflowGraphBody(d.workflow)) });
      if (!graph.ok) return toastError(t("flowsApp.failed"), ((await graph.json().catch(() => ({}))) as { error?: string }).error);
      toast({ title: t("flowsApp.workflowDone", { name: d.name }), status: "done" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section id="flows" aria-labelledby="flows-title" className="flex min-w-0 flex-col gap-3 rounded-lg bg-paper p-3 shadow-hairline sm:p-4">
      <div>
        <h2 id="flows-title" className="aos-subheading">{t("flowsApp.title")}</h2>
        <p className="mt-1 max-w-[72ch] text-sm text-muted">{t("flowsApp.help")}</p>
        {!canEdit ? <p className="mt-2 text-sm text-muted" role="note">{t("flowsApp.viewerOnly")}</p> : null}
      </div>
      {flows.length === 0 ? (
        <div className="flex flex-col items-center gap-1 px-3 py-10 text-center">
          <p className="text-md font-semibold text-ink">{t("flowsApp.empty")}</p>
          <p className="max-w-[44ch] text-sm text-muted">{t("flowsApp.emptyBody")}</p>
        </div>
      ) : (
        <div className="-mx-3 overflow-x-auto sm:-mx-4">
          <table className="w-full min-w-[52rem] border-collapse text-left text-sm">
            <caption className="sr-only">{t("flowsApp.title")}</caption>
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th scope="col" className="px-3 py-2 sm:pl-4">{t("flowsApp.columns.name")}</th>
                <th scope="col" className="px-3 py-2">{t("flowsApp.columns.site")}</th>
                <th scope="col" className="px-3 py-2 text-right">{t("flowsApp.columns.steps")}</th>
                <th scope="col" className="px-3 py-2">{t("flowsApp.columns.values")}</th>
                <th scope="col" className="px-3 py-2">{t("flowsApp.columns.status")}</th>
                <th scope="col" className="px-3 py-2">{t("flowsApp.columns.lastRun")}</th>
                <th scope="col" className="px-3 py-2 sm:pr-4"><span className="sr-only">{t("flowsApp.columns.actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {flows.map((f) => (
                <tr key={f.id} className="border-b border-line align-top last:border-b-0 hover:bg-hover-paper">
                  <td className="max-w-[18rem] px-3 py-2 sm:pl-4">
                    <span className="block truncate font-semibold text-ink">{f.name}</span>
                    {f.truncated ? <span className="block text-xs text-muted">{t("flowsApp.truncated", { why: f.truncated })}</span> : null}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs break-all text-muted">{f.origin.replace(/^https?:\/\//, "")}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink">{f.steps}</td>
                  <td className="px-3 py-2 text-muted">{f.params.length ? f.params.map((p) => (p.sensitive ? t("flowsApp.sensitive", { label: p.label }) : p.label)).join(", ") : "—"}</td>
                  <td className="px-3 py-2"><NeutralBadge label={t(`flowsApp.state.${f.status}` as MessageKey)} size="sm" /></td>
                  <td className="px-3 py-2 text-muted">
                    {f.lastRunAt ? `${t(`flowsApp.run.${f.lastRunStatus === "done" ? "done" : "stopped"}` as MessageKey)} · ${format.date(f.lastRunAt, "time")}` : t("flowsApp.run.never")}
                  </td>
                  <td className="px-3 py-2 sm:pr-4">
                    <div className="flex flex-wrap justify-end gap-2">
                      {f.status === "draft" ? (
                        <button type="button" disabled={!canEdit || busy !== null} onClick={() => void change(f, "publish")} className={aosButton({ variant: "primary", size: "xs" })}>
                          {busy === `publish:${f.id}` ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Rocket className="size-3.5" aria-hidden />}
                          {busy === `publish:${f.id}` ? t("flowsApp.publishing") : t("flowsApp.publish")}
                        </button>
                      ) : (
                        <button type="button" disabled={!canEdit || busy !== null} onClick={() => void change(f, "unpublish")} className={aosButton({ variant: "secondary", size: "xs" })}>
                          {t("flowsApp.unpublish")}
                        </button>
                      )}
                      <button type="button" disabled={!canEdit || busy !== null} onClick={() => void makeWorkflow(f)} className={aosButton({ variant: "secondary", size: "xs" })}>
                        {busy === `workflow:${f.id}` ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Workflow className="size-3.5" aria-hidden />}
                        {busy === `workflow:${f.id}` ? t("flowsApp.workflowing") : t("flowsApp.workflow")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
