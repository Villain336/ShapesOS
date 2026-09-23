// Marketr — usage dashboard (Phase C, W4).
// Settings → Usage: credits used vs pool, by action, by project (agency
// chargeback), spend-cap status, CSV export. Admin-only (server-gated).

"use client";

import { useCallback, useEffect, useState } from "react";
import { Notice, btnCls, cardCls, primaryBtnCls, type NoticeState } from "./ui";

interface SummaryData {
  used: number;
  included: number;
  purchased: number;
  remaining: number;
  byAction: Record<string, number>;
  byProject: Record<string, number>;
  periodStart: string;
  cap: { allowed: boolean; remaining: number; capCredits: number };
}

interface ProjectInfo {
  id: string;
  domain: string;
}

const ACTION_LABELS: Record<string, string> = {
  rank_check: "Rank checks",
  serp_analysis: "SERP analyses",
  keyword_research: "Keyword research runs",
  keyword_ideas: "Keyword ideas expansions",
  keyword_gap: "Competitor keyword gaps",
  site_audit: "Site audits",
  backlink_summary: "Backlink summaries",
  content_brief: "Content briefs (AI)",
  ai_article: "AI articles",
  content_refresh: "Content refreshes (AI)",
  skill_run_base: "Scheduled skill runs",
  subagent_spawn: "Subagent spawns",
  mcp_tool_call: "MCP tool calls",
  publish: "Publishes",
  connector_sync: "Connector syncs",
  storage_over_quota: "Storage over quota",
};

function actionLabel(a: string): string {
  return ACTION_LABELS[a] ?? a;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

export default function UsageDashboard({ workspaceId }: { workspaceId: string }) {
  const [data, setData] = useState<SummaryData | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [loading, setLoading] = useState(true);

  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sumRes, projRes] = await Promise.all([
        fetch(`/api/usage/summary?${q}${projectFilter ? `&projectId=${encodeURIComponent(projectFilter)}` : ""}`),
        fetch(`/api/projects`),
      ]);
      if (!sumRes.ok) throw new Error("Failed to load usage");
      setData(await sumRes.json());
      if (projRes.ok) {
        const pj = await projRes.json();
        setProjects((pj.projects ?? []).map((p: { id: string; domain: string }) => ({ id: p.id, domain: p.domain })));
      }
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "Failed to load usage" });
    } finally {
      setLoading(false);
    }
  }, [q, projectFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const projectName = (id: string) => {
    if (id === "workspace") return "Workspace (unattributed)";
    const p = projects.find((x) => x.id === id);
    return p ? p.domain : `${id.slice(0, 8)}…`;
  };

  const pool = data ? data.included + data.purchased : 0;
  const pct = pool > 0 && data ? Math.min(100, Math.round((data.used / pool) * 100)) : 0;

  return (
    <div className="flex flex-col gap-6">
      {notice && <Notice notice={notice} />}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Credit usage</h2>
          <p className="text-sm text-zinc-500">
            1 credit = $0.01. The ledger below is the source of truth for billing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Filter by project"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm"
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.domain}
              </option>
            ))}
          </select>
          <a href={`/api/usage/export?${q}`} className={btnCls} download>
            Export CSV
          </a>
        </div>
      </div>

      {loading || !data ? (
        <div className={cardCls}>
          <p className="text-sm text-zinc-500">{loading ? "Loading usage…" : "No usage data."}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className={cardCls}>
              <div className="text-xs uppercase tracking-wide text-zinc-500">Used this period</div>
              <div className="mt-1 text-2xl font-bold">{fmt(data.used)}</div>
              <div className="text-xs text-zinc-500">of {fmt(pool)} credits</div>
            </div>
            <div className={cardCls}>
              <div className="text-xs uppercase tracking-wide text-zinc-500">Remaining</div>
              <div className="mt-1 text-2xl font-bold">{fmt(data.remaining)}</div>
              <div className="text-xs text-zinc-500">
                {fmt(data.included)} included + {fmt(data.purchased)} purchased
              </div>
            </div>
            <div className={cardCls}>
              <div className="text-xs uppercase tracking-wide text-zinc-500">Spend cap</div>
              <div className="mt-1 text-2xl font-bold">{fmt(data.cap.capCredits)}</div>
              <div className="text-xs text-zinc-500">{data.cap.allowed ? "Charges allowed" : "Cap reached — charges blocked"}</div>
            </div>
            <div className={cardCls}>
              <div className="text-xs uppercase tracking-wide text-zinc-500">Period started</div>
              <div className="mt-1 text-2xl font-bold">
                {new Date(data.periodStart).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </div>
              <div className="text-xs text-zinc-500">pools reset monthly</div>
            </div>
          </div>

          <div className={cardCls}>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium">Pool usage</span>
              <span className="text-sm text-zinc-500">{pct}%</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-zinc-100">
              <div
                className={`h-full rounded-full ${pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-emerald-600"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            {pct >= 80 && (
              <p className="mt-2 text-sm text-amber-700">
                {pct >= 100
                  ? "Cap reached: new charges are blocked with a plain-language notice until the cap is raised or credits are added."
                  : "Past 80%: the usage warning alert fired once for this period. Add credits or raise the cap to avoid blocked actions."}
              </p>
            )}
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div className={cardCls}>
              <h3 className="mb-3 text-sm font-semibold">By action</h3>
              {Object.keys(data.byAction).length === 0 ? (
                <p className="text-sm text-zinc-500">No metered actions this period yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {Object.entries(data.byAction)
                      .sort((a, b) => b[1] - a[1])
                      .map(([action, credits]) => (
                        <tr key={action} className="border-t border-zinc-100">
                          <td className="py-2 pr-2 text-zinc-700">{actionLabel(action)}</td>
                          <td className="py-2 text-right font-medium tabular-nums">{fmt(credits)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className={cardCls}>
              <h3 className="mb-3 text-sm font-semibold">By project (chargeback)</h3>
              {Object.keys(data.byProject).length === 0 ? (
                <p className="text-sm text-zinc-500">No project-attributed usage this period yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {Object.entries(data.byProject)
                      .sort((a, b) => b[1] - a[1])
                      .map(([pid, credits]) => (
                        <tr key={pid} className="border-t border-zinc-100">
                          <td className="py-2 pr-2 text-zinc-700">{projectName(pid)}</td>
                          <td className="py-2 text-right font-medium tabular-nums">{fmt(credits)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
              <p className="mt-3 text-xs text-zinc-500">
                Export the CSV above for client invoices — every row links back to the immutable ledger.
              </p>
            </div>
          </div>

          <div className={cardCls}>
            <h3 className="mb-1 text-sm font-semibold">Spend cap</h3>
            <p className="mb-3 text-sm text-zinc-500">
              The hard cap blocks new charges at 100% of the pool. Turning it off is the
              auto-overage opt-in — usage keeps accruing and is billed per credit.
            </p>
            <CapForm
              workspaceId={workspaceId}
              current={{ capCredits: data.cap.capCredits }}
              onSaved={load}
              setNotice={setNotice}
            />
          </div>
        </>
      )}
    </div>
  );
}

function CapForm({
  workspaceId,
  current,
  onSaved,
  setNotice,
}: {
  workspaceId: string;
  current: { capCredits: number };
  onSaved: () => void;
  setNotice: (n: NoticeState | null) => void;
}) {
  const [capCredits, setCapCredits] = useState(String(current.capCredits));
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(capCredits);
    if (!Number.isInteger(n) || n < 0) {
      setNotice({ kind: "error", message: "Cap must be a non-negative integer." });
      return;
    }
    setSaving(true);
    try {
      const r = await fetch(`/api/usage/cap?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capCredits: n }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Failed to update cap");
      setNotice({ kind: "ok", message: `Spend cap set to ${n.toLocaleString()} credits.` });
      onSaved();
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "Failed to update cap" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="flex items-center gap-2">
      <label htmlFor="cap-credits" className="text-sm text-zinc-600">
        Cap (credits)
      </label>
      <input
        id="cap-credits"
        type="number"
        min={0}
        step={1}
        value={capCredits}
        onChange={(e) => setCapCredits(e.target.value)}
        className="w-32 rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
      />
      <button type="submit" disabled={saving} className={primaryBtnCls}>
        {saving ? "Saving…" : "Save cap"}
      </button>
    </form>
  );
}
