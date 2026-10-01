// Marketr — Phase 14 slice 10: Composio usage card for Settings → Usage.
// Per-workspace tool-call usage + the shared hosted free-tier budget with
// cost warnings at 80%/100%. Dense table for the per-app breakdown.

"use client";

import { useEffect, useState } from "react";
import { PlugZap } from "lucide-react";

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const cardCls = "rounded-xl border border-line bg-paper p-5";

interface UsagePayload {
  usage: {
    calls: number;
    byApp: Record<string, number>;
    byStatus: Record<string, number>;
    credits: number;
    periodStart: string;
  };
  budget: {
    calls: number;
    allowance: number;
    pct: number;
    warn: boolean;
    over: boolean;
    periodStart: string;
  };
}

export default function ComposioUsageCard({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<UsagePayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/integrations/actions/usage?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        if (live) setData(j);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [workspaceId]);

  if (failed) return null;
  if (!data) {
    return (
      <div className={cardCls}>
        <p className="text-sm text-muted">Loading Composio usage…</p>
      </div>
    );
  }

  const { usage, budget } = data;
  const apps = Object.entries(usage.byApp).sort((a, b) => b[1] - a[1]);

  return (
    <div className={cardCls}>
      <div className="mb-3 flex items-center gap-2">
        <PlugZap className="h-4 w-4 text-ink" />
        <h3 className="text-sm font-semibold text-ink">Composio actions</h3>
        <span className="text-xs text-muted">hosted key · metered to your credit ledger</span>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <div className="text-xs text-muted">Tool calls this month</div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-ink">{usage.calls.toLocaleString()}</div>
          <div className="text-xs text-muted">
            {usage.byStatus.success?.toLocaleString() ?? 0} succeeded
            {usage.byStatus.failed ? ` · ${usage.byStatus.failed.toLocaleString()} failed` : ""}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted">Credits metered</div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-ink">{usage.credits.toLocaleString()}</div>
          <div className="text-xs text-muted">1 credit per call, in the pool above</div>
        </div>
        <div>
          <div className="text-xs text-muted">Hosted free tier</div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-ink">
            {budget.calls.toLocaleString()}
            <span className="text-sm font-normal text-muted"> / {budget.allowance.toLocaleString()}</span>
          </div>
          <div className="text-xs text-muted">platform-wide this month</div>
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-sm font-medium text-ink">Free-tier usage</span>
          <span className="text-sm tabular-nums text-muted">{budget.pct}%</span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-canvas">
          <div
            className="h-full rounded-full bg-ink"
            style={{ width: `${Math.min(100, budget.pct)}%` }}
          />
        </div>
        {budget.warn && (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-line bg-needs-tint px-3 py-2 text-sm text-ink">
            <span className="aos-shape aos-shape--needs aos-shape--edged mt-1" role="img" aria-label="Needs attention" />
            <p>
              {budget.over
                ? "Free tier exceeded: further calls bill to Marketr's hosted Composio key until the month resets. Consider throttling automations."
                : "Past 80% of the hosted free tier: calls keep working, but overage bills to Marketr's hosted Composio key. New executions carry a warning in the audit log."}
            </p>
          </div>
        )}
      </div>

      {apps.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-2 text-sm font-semibold text-ink">By app</h4>
          <table className="w-full text-sm">
            <tbody>
              {apps.map(([app, calls]) => (
                <tr key={app} className="border-t border-line hover:bg-hover-paper">
                  <td className="py-2 pr-2 font-medium text-ink">{app}</td>
                  <td className="py-2 text-right font-medium tabular-nums text-ink">{calls.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
