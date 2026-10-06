// Marketr — usage dashboard (Phase C, W4).
// Settings → Usage: credits used vs pool, by action, by project (agency
// chargeback), spend-cap status, CSV export. Admin-only (server-gated).

"use client";

import { useCallback, useEffect, useState } from "react";
import ComposioUsageCard from "./ComposioUsageCard";
import RecordingStorageCard from "./RecordingStorageCard";

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const cardCls = "rounded-xl border border-line bg-paper p-5";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-40";
const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

type NoticeKind = "ok" | "error" | "info";
interface NoticeState {
  kind: NoticeKind;
  message: string;
}

function Notice({ notice }: { notice: NoticeState | null }) {
  if (!notice) return null;
  if (notice.kind === "error") {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text"
      >
        <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
        <span>{notice.message}</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-line bg-paper px-3 py-2 text-sm text-muted">
      <span>{notice.message}</span>
    </div>
  );
}

interface SummaryData {
  used: number;
  included: number;
  purchased: number;
  remaining: number;
  byAction: Record<string, number>;
  byProject: Record<string, number>;
  periodStart: string;
  cap: { allowed: boolean; remaining: number; capCredits: number; poolWorkspaceId?: string };
  /** Phase 15.2 */
  byCategory?: Partial<Record<"ai" | "data" | "messaging" | "compute" | "other" | "cursor", number>>;
  byokSavedCredits?: number;
  pool?: { ownerWorkspaceId: string; role: "owner" | "member"; used: number; byWorkspace?: Record<string, number> };
}

const CATEGORY_LABELS: Record<"ai" | "data" | "messaging" | "compute" | "other" | "cursor", string> = {
  ai: "AI",
  data: "Data",
  messaging: "Messaging",
  compute: "Compute",
  // Phase 19A (WS=server): the agentic cursor's talk minutes and spoken answers.
  cursor: "Cursor",
  other: "Other",
};

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
  composio_tool_call: "Composio tool calls",
  // Phase 15.2
  llm_tokens: "AI model calls (tokens)",
  image_generation: "AI images",
  sandbox_minute: "Code sandbox minutes",
  call_minute: "Voice call minutes",
  call_transcription_minute: "Call transcription minutes",
  phone_number_month: "Tracking numbers",
  intelligence_vendor_call: "Data vendor calls",
  geo_prompt_run: "AI visibility prompt runs",
  contextdev_call: "Context.dev (platform key)",
  mail_piece: "Direct mail pieces",
  mail_verification: "Address verifications",
  sms_send: "SMS segments",
  email_send: "Emails",
  enrichment_lookup: "Enrichment lookups",
  prospect_research: "Prospect research (AI)",
  penpot_import: "Penpot imports",
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
          <h2 className="text-lg font-semibold text-ink">Credit usage</h2>
          <p className="text-sm text-muted">
            1 credit = $0.01. The ledger below is the source of truth for billing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Filter by project"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className={inputCls}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.domain}
              </option>
            ))}
          </select>
          <a href={`/api/usage/export?${q}`} className={btnGhost} download>
            Export CSV
          </a>
        </div>
      </div>

      {loading || !data ? (
        <div className={cardCls}>
          <p className="text-sm text-muted">{loading ? "Loading usage…" : "No usage data."}</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className={cardCls}>
              <div className="text-xs text-muted">Used this period</div>
              <div className="mt-1 text-2xl font-bold tabular-nums text-ink">{fmt(data.used)}</div>
              <div className="text-xs text-muted">of {fmt(pool)} credits</div>
            </div>
            <div className={cardCls}>
              <div className="text-xs text-muted">Remaining</div>
              <div className="mt-1 text-2xl font-bold tabular-nums text-ink">{fmt(data.remaining)}</div>
              <div className="text-xs text-muted">
                {fmt(data.included)} included + {fmt(data.purchased)} purchased
              </div>
            </div>
            <div className={cardCls}>
              <div className="text-xs text-muted">Spend cap</div>
              <div className="mt-1 text-2xl font-bold tabular-nums text-ink">{fmt(data.cap.capCredits)}</div>
              <div className="text-xs text-muted">{data.cap.allowed ? "Charges allowed" : "Cap reached — charges blocked"}</div>
            </div>
            <div className={cardCls}>
              <div className="text-xs text-muted">Period started</div>
              <div className="mt-1 text-2xl font-bold tabular-nums text-ink">
                {new Date(data.periodStart).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </div>
              <div className="text-xs text-muted">pools reset monthly</div>
            </div>
          </div>

          <div className={cardCls}>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-ink">Pool usage</span>
              <span className="text-sm text-muted">{pct}%</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-canvas">
              <div
                className="h-full rounded-full bg-ink"
                style={{ width: `${pct}%` }}
              />
            </div>
            {pct >= 80 && (
              <div className="mt-2 flex items-start gap-2 rounded-md border border-line bg-needs-tint px-3 py-2 text-sm text-ink">
                <span className="aos-shape aos-shape--needs aos-shape--edged mt-1" role="img" aria-label="Needs attention" />
                <p>
                  {pct >= 100
                    ? "Cap reached: new charges are blocked with a plain-language notice until the cap is raised or credits are added."
                    : "Past 80%: the usage warning alert fired once for this period. Add credits or raise the cap to avoid blocked actions."}
                </p>
              </div>
            )}
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div className={cardCls}>
              <h3 className="mb-3 text-sm font-semibold text-ink">By category</h3>
              <table className="w-full text-sm">
                <tbody>
                  {(Object.keys(CATEGORY_LABELS) as Array<keyof typeof CATEGORY_LABELS>).map((c) => (
                    <tr key={c} className="border-t border-line">
                      <td className="py-2 pr-2 text-ink">{CATEGORY_LABELS[c]}</td>
                      <td className="py-2 text-right font-medium tabular-nums text-ink">{fmt(data.byCategory?.[c] ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-muted">
                AI model calls are charged at 1.5× the provider&apos;s token cost; data vendors at 4× their cost.
              </p>
            </div>
            <div className={cardCls}>
              <h3 className="mb-1 text-sm font-semibold text-ink">Your own model keys</h3>
              {(data.byokSavedCredits ?? 0) > 0 ? (
                <>
                  <div className="mt-1 text-2xl font-bold tabular-nums text-ink">{fmt(data.byokSavedCredits ?? 0)}</div>
                  <p className="text-sm text-muted">
                    credits your own key saved this period — those model calls used no AI credits.
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted">
                  Bring your own Anthropic or OpenAI key in Settings → Providers and model calls on it use no AI
                  credits, on the same plan.
                </p>
              )}
              <a href="/dashboard/settings/providers#providers-your-keys" className={`${btnGhost} mt-3`}>
                Manage keys
              </a>
            </div>
          </div>

          <PoolCard data={data} />

          <div className="grid gap-6 md:grid-cols-2">
            <div className={cardCls}>
              <h3 className="mb-3 text-sm font-semibold text-ink">By action</h3>
              {Object.keys(data.byAction).length === 0 ? (
                <p className="text-sm text-muted">No metered actions this period yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {Object.entries(data.byAction)
                      .sort((a, b) => b[1] - a[1])
                      .map(([action, credits]) => (
                        <tr key={action} className="border-t border-line">
                          <td className="py-2 pr-2 text-ink">{actionLabel(action)}</td>
                          <td className="py-2 text-right font-medium tabular-nums text-ink">{fmt(credits)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className={cardCls}>
              <h3 className="mb-3 text-sm font-semibold text-ink">By project (chargeback)</h3>
              {Object.keys(data.byProject).length === 0 ? (
                <p className="text-sm text-muted">No project-attributed usage this period yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {Object.entries(data.byProject)
                      .sort((a, b) => b[1] - a[1])
                      .map(([pid, credits]) => (
                        <tr key={pid} className="border-t border-line">
                          <td className="py-2 pr-2 text-ink">{projectName(pid)}</td>
                          <td className="py-2 text-right font-medium tabular-nums text-ink">{fmt(credits)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
              <p className="mt-3 text-xs text-muted">
                Export the CSV above for client invoices — every row links back to the immutable ledger.
              </p>
            </div>
          </div>

          <div className={cardCls}>
            <h3 className="mb-1 text-sm font-semibold text-ink">Spend cap</h3>
            <p className="mb-3 text-sm text-muted">
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

          <ComposioUsageCard workspaceId={workspaceId} />
          <RecordingStorageCard workspaceId={workspaceId} />
        </>
      )}
    </div>
  );
}

interface PoolPayload {
  plan: string | null;
  role: "owner" | "member" | "none";
  owner: { id: string; name: string } | null;
  members: Array<{ workspaceId: string; name: string; plan: string }>;
  candidates: Array<{ workspaceId: string; name: string; plan: string }>;
}

/** Phase 15.2: agency credit pooling — one pool for the agency's client workspaces. */
function PoolCard({ data }: { data: SummaryData }) {
  const [pool, setPool] = useState<PoolPayload | null>(null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/usage/pool");
      if (r.ok) setPool(await r.json());
    } catch {
      /* the card stays hidden */
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (!pool || pool.role === "none") return null;

  async function change(method: "POST" | "DELETE", clientWorkspaceId: string) {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fetch(
        method === "POST" ? "/api/usage/pool" : `/api/usage/pool?clientWorkspaceId=${encodeURIComponent(clientWorkspaceId)}`,
        { method, headers: { "Content-Type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify({ clientWorkspaceId }) } : {}) },
      );
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not update the pool.");
      setPick("");
      await load();
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "Could not update the pool." });
    } finally {
      setBusy(false);
    }
  }

  if (pool.role === "member") {
    return (
      <div className={cardCls}>
        <h3 className="mb-1 text-sm font-semibold text-ink">Pooled credits</h3>
        <p className="text-sm text-muted">
          This workspace spends the pooled credits of <span className="font-semibold text-ink">{pool.owner?.name}</span>. The
          agency workspace manages the cap. {fmt(data.pool?.used ?? 0)} credits used across the pool this period.
        </p>
      </div>
    );
  }

  const byWs = data.pool?.byWorkspace ?? {};
  return (
    <div className={cardCls}>
      <h3 className="mb-1 text-sm font-semibold text-ink">Pooled client workspaces</h3>
      <p className="mb-3 text-sm text-muted">
        Your Agency plan&apos;s credits are one pool: client workspaces added here spend it, and the cap and the 80% alert
        apply to the pool as a whole.
      </p>
      {notice && <Notice notice={notice} />}
      {pool.members.length === 0 ? (
        <p className="text-sm text-muted">No client workspaces in the pool yet.</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {pool.members.map((m) => (
              <tr key={m.workspaceId} className="border-t border-line">
                <td className="py-2 pr-2 text-ink">{m.name}</td>
                <td className="py-2 pr-2 text-right font-medium tabular-nums text-ink">{fmt(byWs[m.workspaceId] ?? 0)}</td>
                <td className="py-2 text-right">
                  <button type="button" disabled={busy} onClick={() => change("DELETE", m.workspaceId)} className={btnGhost}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pool.candidates.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select aria-label="Workspace to add to the pool" value={pick} onChange={(e) => setPick(e.target.value)} className={inputCls}>
            <option value="">Add a client workspace…</option>
            {pool.candidates.map((c) => (
              <option key={c.workspaceId} value={c.workspaceId}>
                {c.name}
              </option>
            ))}
          </select>
          <button type="button" disabled={busy || !pick} onClick={() => change("POST", pick)} className={btnPrimary}>
            Add to pool
          </button>
        </div>
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
      <label htmlFor="cap-credits" className="text-sm text-muted">
        Cap (credits)
      </label>
      <input
        id="cap-credits"
        type="number"
        min={0}
        step={1}
        value={capCredits}
        onChange={(e) => setCapCredits(e.target.value)}
        className={`${inputCls} w-32`}
      />
      <button type="submit" disabled={saving} className={btnPrimary}>
        {saving ? "Saving…" : "Save cap"}
      </button>
    </form>
  );
}
