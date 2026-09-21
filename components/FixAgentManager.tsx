// Marketr — fix-agent manager (milestone 10).
//
// The visible trust ladder, rung 2 (scheduled):
//   1. Run an audit → findings land in the inbox with file + line.
//   2. Approve issues (per-issue, or a whole severity at once).
//   3. Configure the agent: enabled, which categories it may fix without
//      asking, max fixes per run, dry-run mode (default ON — previews only).
//   4. "Run fixes now" or the cron applies approved fixes on schedule;
//      every change is audit-logged and one click reverts a whole run.

"use client";

import { useCallback, useEffect, useState } from "react";

interface SiteRow {
  id: string;
  name: string;
  sourceType: string;
}

interface Settings {
  enabled: boolean;
  allowedCategories: string[];
  maxFixesPerRun: number;
  dryRun: boolean;
}

interface CategoryInfo {
  key: string;
  label: string;
  description: string;
  defaultSeverity: string;
  fixStrategy: string;
  destructive: boolean;
  guidance: string;
}

interface Issue {
  id: string;
  category: string;
  severity: string;
  filePath: string;
  line: number | null;
  detail: string;
  fixHint: string | null;
  autoFixable: boolean;
  destructive: boolean;
  status: string;
  proposedDiff: string | null;
  approvedBy: string | null;
  fixedAt: string | null;
}

interface Audit {
  id: string;
  status: string;
  mock: boolean;
  totalIssues: number;
  openIssues: number;
  errorIssues: number;
  finishedAt: string | null;
  createdAt: string;
}

interface FixRun {
  id: string;
  mode: string;
  status: string;
  fixesApplied: number;
  reportSummary: string | null;
  snapshotRef: string | null;
  startedAt: string;
}

const SEVERITY_ORDER = ["critical", "error", "warning", "info"];
const SEVERITY_COLOR: Record<string, string> = {
  critical: "text-red-400 border-red-800",
  error: "text-red-400 border-red-800",
  warning: "text-amber-400 border-amber-800",
  info: "text-sky-400 border-sky-800",
};

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  approved: "Approved",
  fixing: "Fixing…",
  fixed: "Fixed",
  verified: "Verified ✓",
};

export default function FixAgentManager({ projectId }: { projectId: string }) {
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [siteId, setSiteId] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [categories, setCategories] = useState<CategoryInfo[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [audit, setAudit] = useState<Audit | null>(null);
  const [runs, setRuns] = useState<FixRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState<string | null>(null);

  const loadSites = useCallback(async () => {
    const res = await fetch(`/api/websites?projectId=${projectId}`);
    const data = await res.json();
    const rows: SiteRow[] = (data.sites ?? []).filter(
      (s: SiteRow) => s.sourceType !== "wordpress" && s.sourceType !== "webflow",
    );
    setSites(rows);
    setSiteId((prev) => prev || rows[0]?.id || "");
    setLoading(false);
  }, [projectId]);

  const loadInbox = useCallback(async () => {
    if (!siteId) return;
    setError(null);
    const res = await fetch(`/api/websites/${siteId}/audit?projectId=${projectId}`);
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Failed to load fix-agent data");
      return;
    }
    setSettings(data.settings);
    setAudit(data.latestAudit);
    setIssues(data.issues ?? []);
    setRuns(data.fixRuns ?? []);
  }, [siteId, projectId]);

  const loadCategories = useCallback(async () => {
    // Categories come from the settings route's known list; hardcode the
    // registry here for checkbox labels (server validates on save).
    setCategories([
      { key: "missing-title", label: "Missing <title>", description: "Generate a title from the page content.", defaultSeverity: "error", fixStrategy: "llm", destructive: false, guidance: "" },
      { key: "missing-meta-description", label: "Missing meta description", description: "Generate a ~150 char description.", defaultSeverity: "warning", fixStrategy: "llm", destructive: false, guidance: "" },
      { key: "missing-og-tags", label: "Missing Open Graph tags", description: "Build og: tags from title/description.", defaultSeverity: "warning", fixStrategy: "deterministic", destructive: false, guidance: "" },
      { key: "missing-alt", label: "Image missing alt text", description: "Generate alt text per image.", defaultSeverity: "warning", fixStrategy: "llm", destructive: false, guidance: "" },
      { key: "mixed-content", label: "Mixed content (http://)", description: "Rewrite http:// URLs to https://.", defaultSeverity: "error", fixStrategy: "deterministic", destructive: false, guidance: "" },
      { key: "missing-robots-sitemap", label: "Missing robots.txt / sitemap.xml", description: "Create both files.", defaultSeverity: "info", fixStrategy: "deterministic", destructive: false, guidance: "" },
    ]);
  }, []);

  useEffect(() => {
    loadSites();
    loadCategories();
  }, [loadSites, loadCategories]);
  useEffect(() => {
    loadInbox();
  }, [loadInbox]);

  async function saveSettings(next: Partial<Settings>) {
    if (!settings || !siteId) return;
    setBusy(true);
    setError(null);
    const merged = { ...settings, ...next };
    const res = await fetch(`/api/websites/${siteId}/fix-agent`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, ...merged }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) setError(data.error ?? "Failed to save settings");
    else {
      setSettings(data.settings);
      setNotice("Settings saved.");
    }
  }

  async function runAudit() {
    if (!siteId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/websites/${siteId}/audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) setError(data.error ?? "Audit failed");
    else {
      setNotice(`Audit complete — ${data.issueCount} issue${data.issueCount === 1 ? "" : "s"} found${data.mock ? " (mock data)" : ""}.`);
      loadInbox();
    }
  }

  async function setIssueStatus(issueId: string, status: "approved" | "ignored") {
    const res = await fetch(`/api/websites/${siteId}/issues/${issueId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, status }),
    });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? "Failed to update issue");
    else loadInbox();
  }

  async function approveAll(severity: string) {
    setBusy(true);
    const res = await fetch(`/api/websites/${siteId}/issues/approve-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, severity }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) setError(data.error ?? "Bulk approve failed");
    else {
      setNotice(`Approved ${data.approved} ${severity} issue${data.approved === 1 ? "" : "s"}.`);
      loadInbox();
    }
  }

  async function runFixes() {
    if (!siteId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/websites/${siteId}/fix-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) setError(data.error ?? "Fix run failed");
    else {
      setNotice(data.summary + (data.mock ? " (mock site)" : ""));
      loadInbox();
    }
  }

  async function revertRun(runId: string) {
    if (!confirm("Revert this fix run? Every file it touched will be restored to its pre-run content.")) return;
    setBusy(true);
    const res = await fetch(`/api/websites/${siteId}/fix-runs/${runId}/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) setError(data.error ?? "Revert failed");
    else {
      setNotice(`Reverted — restored ${data.restored.length} file${data.restored.length === 1 ? "" : "s"}.`);
      loadInbox();
    }
  }

  const grouped = SEVERITY_ORDER.map((sev) => ({
    severity: sev,
    items: issues.filter((i) => i.severity === sev),
  })).filter((g) => g.items.length > 0);

  if (loading) return <div className="text-sm text-zinc-500">Loading fix agent…</div>;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Fix agent <span className="text-xs font-normal text-zinc-500">— scheduled rung</span></h2>
          <p className="mt-1 text-sm text-zinc-400">
            Audit a site, approve the fixes you want, and the agent applies them on schedule.
            Nothing is auto-fixed without your approval — dry-run mode is on by default.
          </p>
        </div>
        <select
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
        >
          {sites.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      {error && <div className="mt-3 rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300">{error}</div>}
      {notice && <div className="mt-3 rounded-lg border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">{notice}</div>}

      {!sites.length && (
        <p className="mt-3 text-sm text-zinc-500">
          No file-based sites yet (GitHub, SFTP, or uploaded files). Connect one above to audit it.
          WordPress and Webflow are content-level sources with no file tree to audit.
        </p>
      )}

      {siteId && settings && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[320px_1fr]">
          {/* Settings */}
          <div className="rounded-lg border border-zinc-800 p-4">
            <h3 className="text-sm font-semibold">Agent settings</h3>
            <label className="mt-3 flex items-center justify-between text-sm">
              <span>Enabled</span>
              <input type="checkbox" checked={settings.enabled} disabled={busy}
                onChange={(e) => saveSettings({ enabled: e.target.checked })} className="h-4 w-4" />
            </label>
            <label className="mt-2 flex items-center justify-between text-sm">
              <span>Dry-run <span className="text-zinc-500">(previews only)</span></span>
              <input type="checkbox" checked={settings.dryRun} disabled={busy}
                onChange={(e) => saveSettings({ dryRun: e.target.checked })} className="h-4 w-4" />
            </label>
            <label className="mt-2 flex items-center justify-between text-sm">
              <span>Max fixes per run</span>
              <input type="number" min={1} max={50} value={settings.maxFixesPerRun} disabled={busy}
                onChange={(e) => saveSettings({ maxFixesPerRun: parseInt(e.target.value || "10", 10) })}
                className="w-16 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm" />
            </label>
            <div className="mt-3">
              <p className="text-sm font-medium">Auto-fixable without asking</p>
              <p className="text-xs text-zinc-500">Per-issue approval always overrides this.</p>
              <div className="mt-2 space-y-1">
                {categories.map((c) => (
                  <label key={c.key} className="flex items-start gap-2 text-xs">
                    <input type="checkbox" className="mt-0.5 h-3.5 w-3.5"
                      checked={settings.allowedCategories.includes(c.key)} disabled={busy}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...settings.allowedCategories, c.key]
                          : settings.allowedCategories.filter((k) => k !== c.key);
                        saveSettings({ allowedCategories: next });
                      }} />
                    <span><span className="font-medium text-zinc-200">{c.label}</span>
                      <span className="text-zinc-500"> — {c.description}</span></span>
                  </label>
                ))}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={runAudit} disabled={busy}
                className="rounded-lg bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 disabled:opacity-50">
                {busy ? "Working…" : "Run audit"}
              </button>
              <button onClick={runFixes} disabled={busy || !settings.enabled}
                title={settings.enabled ? "Apply eligible fixes now" : "Enable the agent first"}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm disabled:opacity-50">
                {busy ? "Working…" : settings.dryRun ? "Preview fixes (dry-run)" : "Apply fixes now"}
              </button>
            </div>
            {audit && (
              <p className="mt-3 text-xs text-zinc-500">
                Last audit: {audit.totalIssues} issues ({audit.errorIssues} errors)
                {audit.mock ? " — mock data" : ""} · {new Date(audit.createdAt).toLocaleString()}
              </p>
            )}
          </div>

          {/* Inbox */}
          <div>
            {grouped.length === 0 && (
              <p className="rounded-lg border border-zinc-800 p-4 text-sm text-zinc-500">
                No open issues. Run an audit to scan this site.
              </p>
            )}
            {grouped.map((g) => (
              <div key={g.severity} className="mb-4">
                <div className="mb-2 flex items-center justify-between">
                  <h4 className={`text-sm font-semibold capitalize ${SEVERITY_COLOR[g.severity].split(" ")[0]}`}>
                    {g.severity} ({g.items.length})
                  </h4>
                  <button onClick={() => approveAll(g.severity)} disabled={busy}
                    className="text-xs text-zinc-400 underline hover:text-zinc-200 disabled:opacity-50">
                    Approve all {g.severity}
                  </button>
                </div>
                <div className="space-y-2">
                  {g.items.map((issue) => (
                    <div key={issue.id} className={`rounded-lg border bg-zinc-900/60 p-3 ${SEVERITY_COLOR[issue.severity]}`}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-zinc-100">{issue.detail}</p>
                          <p className="mt-0.5 font-mono text-xs text-zinc-500">
                            {issue.filePath}{issue.line ? `:${issue.line}` : ""} · {issue.category}
                            {!issue.autoFixable && <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">manual only</span>}
                            {issue.destructive && <span className="ml-2 rounded bg-red-900/60 px-1.5 py-0.5 text-[10px] text-red-300">destructive</span>}
                          </p>
                          {issue.fixHint && <p className="mt-1 text-xs text-zinc-400">{issue.fixHint}</p>}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-xs text-zinc-500">{STATUS_LABEL[issue.status] ?? issue.status}</span>
                          {(issue.status === "open" || issue.status === "approved") && (
                            <>
                              {issue.proposedDiff && (
                                <button onClick={() => setShowPreview(showPreview === issue.id ? null : issue.id)}
                                  className="rounded border border-zinc-700 px-2 py-1 text-xs">Preview</button>
                              )}
                              {issue.status === "open" && (
                                <button onClick={() => setIssueStatus(issue.id, "approved")} disabled={busy}
                                  className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50">
                                  Approve fix
                                </button>
                              )}
                              <button onClick={() => setIssueStatus(issue.id, "ignored")} disabled={busy}
                                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 disabled:opacity-50">
                                Ignore
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {showPreview === issue.id && issue.proposedDiff && (
                        <pre className="mt-2 max-h-64 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[11px] text-zinc-300">
                          {issue.proposedDiff}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* Run history */}
            {runs.length > 0 && (
              <div className="mt-4">
                <h4 className="mb-2 text-sm font-semibold">Fix runs</h4>
                <div className="space-y-2">
                  {runs.map((r) => (
                    <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 p-3 text-sm">
                      <div>
                        <p className="text-zinc-200">
                          <span className="font-medium">{r.fixesApplied} fix{r.fixesApplied === 1 ? "" : "es"}</span>
                          <span className="ml-2 text-xs text-zinc-500">{r.status} · {new Date(r.startedAt).toLocaleString()}</span>
                        </p>
                        {r.reportSummary && <p className="mt-0.5 text-xs text-zinc-500">{r.reportSummary}</p>}
                      </div>
                      {r.snapshotRef && r.status === "completed" && (
                        <button onClick={() => revertRun(r.id)} disabled={busy}
                          className="rounded border border-red-800 px-2 py-1 text-xs text-red-300 disabled:opacity-50">
                          Revert run
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
