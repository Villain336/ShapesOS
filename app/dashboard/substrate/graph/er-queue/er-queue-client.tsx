// Marketr — Phase 8 G1: ER review queue (client component).
// Human decisions only: approve → reversible SAME_AS merge; reject → NOT_SAME
// negative signal. v1 has no auto-merge anywhere — this queue IS the gate.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, X, UserCheck, Scale } from "lucide-react";

// Agentic OS idioms: merge = approve (done), not-the-same = deny idiom,
// matcher signals and match scores are analytic -> neutral chips.
const chipNeutral =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-1.5 py-0.5 text-[10px] font-medium leading-tight text-muted shadow-control";
const btnApprove =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-done px-4 text-sm font-semibold text-white aos-press hover:bg-done/90 disabled:opacity-40";
const btnDeny =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint disabled:opacity-40";

interface QueueItem {
  id: string;
  confidence: number;
  matcherSignals: Array<{ matcher: string; field: string; weight: number; detail?: string }>;
  createdAt: string;
  nodeA: { id: string; displayName: string; entityType: string; asOfSource: string };
  nodeB: { id: string; displayName: string; entityType: string; asOfSource: string };
}

export default function ErQueueClient({ workspaceId }: { workspaceId: string }) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/substrate/graph/er-queue?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to load queue");
      setItems(data.items);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(id: string, decision: "approved" | "rejected") {
    setActing(id);
    try {
      const res = await fetch(`/api/substrate/graph/er-queue/${id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, decision }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "decision failed");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="aos-heading">ER review queue</h1>
          <p className="text-sm text-muted">
            Ambiguous entity matches awaiting a human decision. Approvals merge reversibly
            (SAME_AS provenance); rejections record a NOT_SAME negative signal. Nothing
            auto-merges in v1.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <span
            className={
              items.length > 0
                ? "inline-flex items-center rounded-full bg-needs px-2 py-0.5 text-xs font-medium text-ink"
                : chipNeutral
            }
          >
            {items.length} pending
          </span>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">
          {error}
        </div>
      )}
      {loading && <div className="text-sm text-subtle">Loading queue…</div>}

      {!loading && items.length === 0 && !error && (
        <div className="rounded-lg border border-line bg-paper p-5 text-sm text-muted">
          <UserCheck className="mb-2 h-5 w-5" />
          Queue is empty — no ambiguous duplicates waiting for review.
        </div>
      )}

      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.id} className="rounded-lg border border-line bg-paper p-5 shadow-hairline">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-3">
                <div className="rounded-md bg-hover-paper px-3 py-2 text-sm font-medium">
                  {item.nodeA.displayName}
                  <div className="text-xs font-normal text-muted">
                    {item.nodeA.entityType} · {item.nodeA.asOfSource}
                  </div>
                </div>
                <Scale className="h-4 w-4 shrink-0 text-muted" />
                <div className="rounded-md bg-hover-paper px-3 py-2 text-sm font-medium">
                  {item.nodeB.displayName}
                  <div className="text-xs font-normal text-muted">
                    {item.nodeB.entityType} · {item.nodeB.asOfSource}
                  </div>
                </div>
              </div>
              <span className={`${chipNeutral} shrink-0`}>
                {(item.confidence * 100).toFixed(0)}% match
              </span>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {item.matcherSignals.map((s, i) => (
                <span key={i} className={chipNeutral} title={s.detail ?? s.matcher}>
                  {s.matcher}: {s.field}
                </span>
              ))}
            </div>

            <div className="mt-4 flex gap-2">
              <button
                className={btnApprove}
                disabled={acting === item.id}
                onClick={() => decide(item.id, "approved")}
              >
                <Check className="h-3.5 w-3.5" /> Merge (reversible)
              </button>
              <button
                className={btnDeny}
                disabled={acting === item.id}
                onClick={() => decide(item.id, "rejected")}
              >
                <X className="h-3.5 w-3.5" /> Not the same
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
