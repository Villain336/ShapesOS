"use client";

// ShapesOS — Phase 18.3 (WS=flow): "Undo this agent run" on a run page (and
// from the Activity Monitor). Lists what the run changed — from its own
// timeline — split into what can be undone and what can't (money moved,
// messages sent, external publishes, records it created), with the reason.
// Undo asks first (Tier 1 for a person), then reverts through each app's own
// path (POST /api/agent-runs/[runId]/undo). Only the starter or an admin.

import { useCallback, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { aosButton, NeutralBadge } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import type { UndoPlan } from "@/lib/timemachine/undo";
import type { MessageKey } from "@/lib/i18n";

type Plan = UndoPlan & { canUndo: boolean; running: boolean };

export function UndoRunPanel({ runId }: { runId: string }) {
  const { t, format } = useI18n();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/undo`, { cache: "no-store" }).catch(() => null);
    setLoading(false);
    const j = (await res?.json().catch(() => null)) as { plan?: Plan; error?: string } | null;
    if (!res?.ok || !j?.plan) {
      toastError(t("flow.undo.loadFailed"), j?.error);
      return;
    }
    setPlan(j.plan);
  }, [runId, t]);

  async function undo() {
    if (!plan) return;
    const ok = await confirmAction({
      title: t("flow.undo.confirmTitle", { count: plan.revertible }),
      description: t("flow.undo.confirmBody", { kept: plan.notRevertible }),
      confirmLabel: t("flow.undo.confirm"),
      cancelLabel: t("common.cancel"),
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    const res = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}/undo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    }).catch(() => null);
    setBusy(false);
    const j = (await res?.json().catch(() => null)) as { outcomes?: Array<{ result: string }>; error?: string } | null;
    if (!res?.ok || !j?.outcomes) {
      toastError(t("flow.undo.failed"), j?.error);
      return;
    }
    const reverted = j.outcomes.filter((o) => o.result === "reverted").length;
    const failed = j.outcomes.filter((o) => o.result === "failed").length;
    toast({ title: t("flow.undo.done", { count: reverted }), description: failed ? t("flow.undo.someFailed", { count: failed }) : undefined, status: failed ? "failed" : "done" });
    await load();
  }

  const can = plan?.items.filter((i) => i.revertible) ?? [];
  const cannot = plan?.items.filter((i) => !i.revertible) ?? [];

  return (
    <section id="undo" aria-labelledby="undo-title" className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline">
      <div className="flex items-center gap-2">
        <History className="size-4 text-muted" aria-hidden />
        <h2 id="undo-title" className="aos-subheading">
          {t("flow.undo.title")}
        </h2>
      </div>
      {!plan ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted">{t("flow.undo.intro")}</p>
          <button type="button" onClick={() => void load()} disabled={loading} className={aosButton({ variant: "secondary", size: "sm" })}>
            {loading ? t("common.loading") : t("flow.undo.review")}
          </button>
        </div>
      ) : (
        <>
          {plan.undoneAt ? <p className="text-sm text-muted">{t("flow.undo.undoneAt", { when: format.relative(plan.undoneAt) })}</p> : null}
          {plan.items.length === 0 ? <p className="text-sm text-muted">{t("flow.undo.nothing")}</p> : null}
          {can.length ? (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-sm font-semibold text-ink">{t("flow.undo.canTitle", { count: can.length })}</h3>
              <ul className="flex flex-col divide-y divide-line">
                {can.map((i) => (
                  <li key={i.id} className="flex items-center gap-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 text-ink">{t(`flow.undo.kinds.${i.kind}` as MessageKey)}</span>
                    {i.tool ? <span className="shrink-0 font-mono text-xs text-muted">{i.tool}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {cannot.length ? (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-sm font-semibold text-ink">{t("flow.undo.cannotTitle", { count: cannot.length })}</h3>
              <ul className="flex flex-col divide-y divide-line">
                {cannot.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                    <span className="min-w-0 flex-1 text-ink">{t(`flow.undo.kinds.${i.kind}` as MessageKey)}</span>
                    <NeutralBadge size="sm" label={t(`flow.undo.reasons.${i.reason ?? "unknown"}` as MessageKey)} />
                    {i.tool ? <span className="w-full font-mono text-xs text-muted">{i.tool}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {plan.running ? <p className="text-sm text-muted">{t("flow.undo.stopFirst")}</p> : null}
          {!plan.canUndo ? <p className="text-sm text-muted">{t("flow.undo.notAllowed")}</p> : null}
          <div>
            <button type="button" disabled={busy || !plan.canUndo || plan.running || can.length === 0} onClick={() => void undo()} className={aosButton({ variant: "secondary", size: "sm" })}>
              <RotateCcw className="size-4" aria-hidden />
              {busy ? t("flow.undo.undoing") : t("flow.undo.button", { count: can.length })}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export default UndoRunPanel;
