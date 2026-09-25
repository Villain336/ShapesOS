// Marketr — Phase 8 G1: ER review queue (client component).
// Human decisions only: approve → reversible SAME_AS merge; reject → NOT_SAME
// negative signal. v1 has no auto-merge anywhere — this queue IS the gate.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/vault/shadcn/badge";
import { Button } from "@/components/vault/shadcn/button";
import { Check, X, UserCheck, Scale } from "lucide-react";

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
          <h1 className="text-2xl font-semibold tracking-tight">ER review queue</h1>
          <p className="text-sm text-muted-foreground">
            Ambiguous entity matches awaiting a human decision. Approvals merge reversibly
            (SAME_AS provenance); rejections record a NOT_SAME negative signal. Nothing
            auto-merges in v1.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Badge variant={items.length > 0 ? "destructive" : "secondary"}>
            {items.length} pending
          </Badge>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive bg-card p-4 text-sm text-destructive">
          {error}
        </div>
      )}
      {loading && <div className="text-sm text-muted-foreground">Loading queue…</div>}

      {!loading && items.length === 0 && !error && (
        <div className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">
          <UserCheck className="mb-2 h-5 w-5" />
          Queue is empty — no ambiguous duplicates waiting for review.
        </div>
      )}

      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.id} className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-3">
                <div className="rounded-md bg-muted px-3 py-2 text-sm font-medium">
                  {item.nodeA.displayName}
                  <div className="text-xs font-normal text-muted-foreground">
                    {item.nodeA.entityType} · {item.nodeA.asOfSource}
                  </div>
                </div>
                <Scale className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="rounded-md bg-muted px-3 py-2 text-sm font-medium">
                  {item.nodeB.displayName}
                  <div className="text-xs font-normal text-muted-foreground">
                    {item.nodeB.entityType} · {item.nodeB.asOfSource}
                  </div>
                </div>
              </div>
              <Badge variant="outline" className="shrink-0">
                {(item.confidence * 100).toFixed(0)}% match
              </Badge>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {item.matcherSignals.map((s, i) => (
                <Badge
                  key={i}
                  variant={s.weight > 0 ? "secondary" : "destructive"}
                  title={s.detail ?? s.matcher}
                >
                  {s.matcher}: {s.field}
                </Badge>
              ))}
            </div>

            <div className="mt-4 flex gap-2">
              <Button
                size="sm"
                disabled={acting === item.id}
                onClick={() => decide(item.id, "approved")}
              >
                <Check className="mr-1 h-3.5 w-3.5" /> Merge (reversible)
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={acting === item.id}
                onClick={() => decide(item.id, "rejected")}
              >
                <X className="mr-1 h-3.5 w-3.5" /> Not the same
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
