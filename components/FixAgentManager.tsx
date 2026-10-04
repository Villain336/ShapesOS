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
import { confirmAction } from "@/lib/ui/feedback";

interface SiteRow {
  id: string;
  name: string;
  sourceType: string;
}

// Phase 11 (seotools): live-URL crawl summary (lib/audit/live.ts).
interface LiveCrawl {
  startUrl: string;
  rendering: "static" | "js";
  renderingNote: string;
  pagesCrawled: number;
  pagesBlockedByRobots: number;
  truncated: boolean;
  statusCounts: Record<string, number>;
  robots: { found: boolean };
  sitemap: { found: boolean; urlCount: number };
  externalChecked: number;
}

// Phase 11 (seotools): Core Web Vitals (lib/seo/pagespeed.ts). Ratings are
// measurement data, not agent states — shown as text, never status colours.
interface VitalsMetric {
  value: number;
  rating: "good" | "needs-improvement" | "poor";
}
interface StrategyVitals {
  strategy: "mobile" | "desktop";
  field: { scope: "url" | "origin"; lcp: VitalsMetric | null; inp: VitalsMetric | null; cls: VitalsMetric | null } | null;
  lab: { performanceScore: number | null; lcp: VitalsMetric | null; cls: VitalsMetric | null; tbt: VitalsMetric | null };
}
type Vitals =
  | { unavailable: true; reason: string; url: string; measuredAt: string }
  | { unavailable?: false; url: string; measuredAt: string; keyed: boolean; strategies: StrategyVitals[]; errors: { strategy: string; reason: string }[] };

const RATING_LABEL: Record<VitalsMetric["rating"], string> = { good: "good", "needs-improvement": "needs work", poor: "poor" };

function metricText(m: VitalsMetric | null, kind: "ms" | "cls"): string {
  if (!m) return "—";
  return `${kind === "cls" ? m.value.toFixed(2) : `${Math.round(m.value)} ms`} (${RATING_LABEL[m.rating]})`;
}

function VitalsSummary({ vitals }: { vitals: Vitals }) {
  if (vitals.unavailable) {
    return <p className="mt-2 text-xs text-muted">Core Web Vitals not measured: {vitals.reason}</p>;
  }
  return (
    <div className="mt-3 space-y-3">
      {vitals.strategies.map((s) => (
        <div key={s.strategy} className="text-xs">
          <p className="font-semibold text-ink">
            {s.strategy === "mobile" ? "Mobile" : "Desktop"} · performance {s.lab.performanceScore ?? "—"}
          </p>
          <dl className="mt-1 grid grid-cols-[auto_1fr_1fr] gap-x-2 gap-y-0.5 text-muted">
            <dt />
            <dd>{s.field ? `Real users (${s.field.scope === "origin" ? "site-wide" : "this page"})` : "Real users"}</dd>
            <dd>Lab</dd>
            <dt>LCP</dt>
            <dd className="text-ink">{s.field ? metricText(s.field.lcp, "ms") : "no data"}</dd>
            <dd className="text-ink">{metricText(s.lab.lcp, "ms")}</dd>
            <dt>INP / TBT</dt>
            <dd className="text-ink">{s.field ? metricText(s.field.inp, "ms") : "no data"}</dd>
            <dd className="text-ink">{metricText(s.lab.tbt, "ms")}</dd>
            <dt>CLS</dt>
            <dd className="text-ink">{s.field ? metricText(s.field.cls, "cls") : "no data"}</dd>
            <dd className="text-ink">{metricText(s.lab.cls, "cls")}</dd>
          </dl>
        </div>
      ))}
      {vitals.errors.map((e) => (
        <p key={e.strategy} className="text-xs text-muted">{e.strategy}: {e.reason}</p>
      ))}
      <p className="text-[11px] text-muted">
        PageSpeed Insights · {new Date(vitals.measuredAt).toLocaleString()}{vitals.keyed ? "" : " · keyless quota"}
      </p>
    </div>
  );
}

// Phase 11 (seotools): sitemap submissions (lib/seo/sitemap-submit.ts).
interface SitemapSubmission {
  id: string;
  target: "gsc" | "indexnow";
  status: "submitted" | "not_connected" | "needs_reconnect" | "failed";
  urlCount: number;
  detail: string | null;
  createdAt: string;
}

const SUBMIT_TARGET_LABEL: Record<SitemapSubmission["target"], string> = { gsc: "Search Console", indexnow: "IndexNow" };
const SUBMIT_STATUS_LABEL: Record<SitemapSubmission["status"], string> = {
  submitted: "Submitted",
  not_connected: "Not connected",
  needs_reconnect: "Needs reconnect",
  failed: "Failed",
};

interface LiveAudit {
  id: string;
  status: string;
  targetUrl: string | null;
  totalIssues: number;
  errorIssues: number;
  createdAt: string;
  crawl: LiveCrawl | null;
  vitals: Vitals | null;
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
// Audit severity is finding data, not an agent state: neutral weights only.
const SEVERITY_COLOR: Record<string, string> = {
  critical: "text-ink border-ink",
  error: "text-ink border-control",
  warning: "text-ink border-line",
  info: "text-muted border-line",
};

// Fix runs ARE agent runs: they take the status shape.
const RUN_SHAPE: Record<string, string> = {
  running: "aos-shape aos-shape--running aos-is-live",
  completed: "aos-shape aos-shape--done",
  failed: "aos-shape aos-shape--failed",
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
  const [liveAudit, setLiveAudit] = useState<LiveAudit | null>(null);
  const [liveUrl, setLiveUrl] = useState("");
  const [submissions, setSubmissions] = useState<SitemapSubmission[]>([]);

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
    setLiveAudit(data.latestLiveAudit ?? null);
    fetch(`/api/websites/${siteId}/sitemap?projectId=${projectId}`)
      .then((r) => (r.ok ? r.json() : { submissions: [] }))
      .then((d) => setSubmissions(d.submissions ?? []))
      .catch(() => setSubmissions([]));
    setLiveUrl((prev) => prev || data.latestLiveAudit?.targetUrl || data.site?.liveUrl || "");
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

  async function runLiveAudit() {
    if (!siteId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/websites/${siteId}/audit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, mode: "live", url: liveUrl.trim() || undefined }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) setError(data.error ?? "Live audit failed");
    else {
      setNotice(`Live crawl complete — ${data.issueCount} issue${data.issueCount === 1 ? "" : "s"} found.`);
      loadInbox();
    }
  }

  async function draftStructuredData() {
    if (!siteId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/websites/${siteId}/structured-data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) setError(data.error ?? "Couldn't draft structured data");
    else if (!data.saved) setNotice("Every page already carries this structured data — nothing to draft.");
    else setNotice(`Saved draft #${data.revision.number} with structured data on ${data.pages.filter((p: { changed: boolean }) => p.changed).length} pages. Review and apply it in Site drafts — nothing is live yet.`);
  }

  async function sitemapAction(action: "rebuild" | "submit") {
    if (!siteId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/websites/${siteId}/sitemap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, action }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Sitemap action failed");
      return;
    }
    if (action === "rebuild") {
      setNotice(
        data.skipped === "user_managed"
          ? `Your hand-written sitemap.xml was kept; robots.txt points at ${data.sitemapUrl}.`
          : `Sitemap rebuilt with ${data.urlCount} pages${data.written.length ? "" : " (no changes)"}. It goes live with the next deploy.`,
      );
    } else {
      setNotice(
        (data.results as { target: SitemapSubmission["target"]; status: SitemapSubmission["status"] }[])
          .map((r) => `${SUBMIT_TARGET_LABEL[r.target]}: ${SUBMIT_STATUS_LABEL[r.status].toLowerCase()}`)
          .join(" · "),
      );
    }
    loadInbox();
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
    if (!await confirmAction("Revert this fix run? Every file it touched will be restored to its pre-run content.")) return;
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

  if (loading) return <div className="text-sm text-muted">Loading fix agent…</div>;

  return (
    <div className="rounded-lg bg-paper shadow-hairline p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-heading tracking-heading stretch-heading">Fix agent <span className="text-xs font-normal text-muted">— scheduled rung</span></h2>
          <p className="mt-1 text-sm text-muted">
            Audit a site, approve the fixes you want, and the agent applies them on schedule.
            Nothing is auto-fixed without your approval — dry-run mode is on by default.
          </p>
        </div>
        <select
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          className="rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-sm"
        >
          {sites.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>

      {error && <div className="mt-3 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">{error}</div>}
      {notice && <div className="mt-3 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink">{notice}</div>}

      {!sites.length && (
        <p className="mt-3 text-sm text-muted">
          No file-based sites yet (GitHub, SFTP, or uploaded files). Connect one above to audit it.
          WordPress and Webflow are content-level sources with no file tree to audit.
        </p>
      )}

      {siteId && settings && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[320px_1fr]">
          {/* Settings */}
          <div className="rounded-md border border-line p-4">
            <h3 className="text-sm font-semibold">Agent settings</h3>
            <label className="mt-3 flex items-center justify-between text-sm">
              <span>Enabled</span>
              <input type="checkbox" checked={settings.enabled} disabled={busy}
                onChange={(e) => saveSettings({ enabled: e.target.checked })} className="h-4 w-4" />
            </label>
            <label className="mt-2 flex items-center justify-between text-sm">
              <span>Dry-run <span className="text-muted">(previews only)</span></span>
              <input type="checkbox" checked={settings.dryRun} disabled={busy}
                onChange={(e) => saveSettings({ dryRun: e.target.checked })} className="h-4 w-4" />
            </label>
            <label className="mt-2 flex items-center justify-between text-sm">
              <span>Max fixes per run</span>
              <input type="number" min={1} max={50} value={settings.maxFixesPerRun} disabled={busy}
                onChange={(e) => saveSettings({ maxFixesPerRun: parseInt(e.target.value || "10", 10) })}
                className="w-16 rounded-md border-[1.5px] border-control bg-paper px-2 py-1 text-sm" />
            </label>
            <div className="mt-3">
              <p className="text-sm font-medium">Auto-fixable without asking</p>
              <p className="text-xs text-muted">Per-issue approval always overrides this.</p>
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
                    <span><span className="font-medium text-ink">{c.label}</span>
                      <span className="text-muted"> — {c.description}</span></span>
                  </label>
                ))}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={runAudit} disabled={busy}
                className="rounded-full bg-ink px-3 py-1.5 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-50">
                {busy ? "Working…" : "Run audit"}
              </button>
              <button onClick={runFixes} disabled={busy || !settings.enabled}
                title={settings.enabled ? "Apply eligible fixes now" : "Enable the agent first"}
                className="rounded-full bg-paper px-3 py-1.5 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-50">
                {busy ? "Working…" : settings.dryRun ? "Preview fixes (dry-run)" : "Apply fixes now"}
              </button>
            </div>
            {audit && (
              <p className="mt-3 text-xs text-muted">
                Last audit: {audit.totalIssues} issues ({audit.errorIssues} errors)
                {audit.mock ? " — mock data" : ""} · {new Date(audit.createdAt).toLocaleString()}
              </p>
            )}

            {/* Phase 11 (seotools): crawl the live site */}
            <div className="mt-4 border-t border-line pt-4">
              <h3 className="text-sm font-semibold">Live site</h3>
              <p className="mt-1 text-xs text-muted">
                Crawls the published pages: status codes, redirects, canonical, hreflang, noindex, structured data, robots.txt and sitemap — and measures Core Web Vitals for the start page.
              </p>
              <input
                type="url"
                value={liveUrl}
                onChange={(e) => setLiveUrl(e.target.value)}
                placeholder="https://example.com"
                aria-label="Live site URL"
                className="mt-2 w-full rounded-md border-[1.5px] border-control bg-paper px-3 py-1.5 font-mono text-xs"
              />
              <button onClick={runLiveAudit} disabled={busy}
                className="mt-2 rounded-full bg-paper px-3 py-1.5 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-50">
                {busy ? "Working…" : "Crawl live site"}
              </button>
              {liveAudit?.crawl && (
                <dl className="mt-3 space-y-1 text-xs text-muted">
                  <div className="flex justify-between gap-2"><dt>Pages crawled</dt><dd className="text-ink">{liveAudit.crawl.pagesCrawled}{liveAudit.crawl.truncated ? " (budget reached)" : ""}</dd></div>
                  <div className="flex justify-between gap-2"><dt>Status codes</dt><dd className="font-mono text-ink">{Object.entries(liveAudit.crawl.statusCounts).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}</dd></div>
                  <div className="flex justify-between gap-2"><dt>robots.txt / sitemap</dt><dd className="text-ink">{liveAudit.crawl.robots.found ? "found" : "missing"} / {liveAudit.crawl.sitemap.found ? `${liveAudit.crawl.sitemap.urlCount} URLs` : "missing"}</dd></div>
                  {liveAudit.crawl.pagesBlockedByRobots > 0 && <div className="flex justify-between gap-2"><dt>Skipped (robots.txt)</dt><dd className="text-ink">{liveAudit.crawl.pagesBlockedByRobots}</dd></div>}
                  <div className="flex justify-between gap-2"><dt>Outbound links checked</dt><dd className="text-ink">{liveAudit.crawl.externalChecked}</dd></div>
                  <div><dt className="sr-only">Rendering</dt><dd>{liveAudit.crawl.rendering === "js" ? "JavaScript-rendered" : "Static HTML"} — {liveAudit.crawl.renderingNote}</dd></div>
                  <div><dd>{liveAudit.totalIssues} issues · {new Date(liveAudit.createdAt).toLocaleString()}</dd></div>
                </dl>
              )}
              {liveAudit?.vitals && (
                <div className="mt-3 border-t border-line pt-3">
                  <h4 className="text-xs font-semibold text-ink">Core Web Vitals</h4>
                  <VitalsSummary vitals={liveAudit.vitals} />
                </div>
              )}
            </div>

            {/* Phase 11 (seotools): sitemap rebuild + submission */}
            <div className="mt-4 border-t border-line pt-4">
              <h3 className="text-sm font-semibold">Sitemap</h3>
              <p className="mt-1 text-xs text-muted">
                sitemap.xml and the robots.txt Sitemap line are rebuilt when a draft is applied and before each deploy. Submit them once the site is live.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={() => sitemapAction("rebuild")} disabled={busy}
                  className="rounded-full bg-paper px-3 py-1.5 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-50">
                  Rebuild sitemap
                </button>
                <button onClick={() => sitemapAction("submit")} disabled={busy}
                  className="rounded-full bg-paper px-3 py-1.5 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-50">
                  Submit to search engines
                </button>
              </div>
              {submissions.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs text-muted">
                  {submissions.slice(0, 4).map((sub) => (
                    <li key={sub.id}>
                      <span className="font-medium text-ink">{SUBMIT_TARGET_LABEL[sub.target]}</span> · {SUBMIT_STATUS_LABEL[sub.status]} · {new Date(sub.createdAt).toLocaleString()}
                      {sub.detail && <span className="block">{sub.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Phase 11 (seotools): JSON-LD as a site draft */}
            <div className="mt-4 border-t border-line pt-4">
              <h3 className="text-sm font-semibold">Structured data</h3>
              <p className="mt-1 text-xs text-muted">
                Adds schema.org JSON-LD (organisation, website, breadcrumbs, FAQs) to every page as a draft you review before it goes live.
              </p>
              <button onClick={draftStructuredData} disabled={busy}
                className="mt-2 rounded-full bg-paper px-3 py-1.5 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-50">
                {busy ? "Working…" : "Draft structured data"}
              </button>
            </div>
          </div>

          {/* Inbox */}
          <div>
            {grouped.length === 0 && (
              <p className="rounded-md border border-line p-4 text-sm text-muted">
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
                    className="text-xs text-muted underline hover:text-ink disabled:opacity-50">
                    Approve all {g.severity}
                  </button>
                </div>
                <div className="space-y-2">
                  {g.items.map((issue) => (
                    <div key={issue.id} className={`rounded-md border bg-paper p-3 ${SEVERITY_COLOR[issue.severity]}`}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-ink">{issue.detail}</p>
                          <p className="mt-0.5 font-mono text-xs text-muted">
                            {issue.filePath}{issue.line ? `:${issue.line}` : ""} · {issue.category}
                            {!issue.autoFixable && <span className="ml-2 rounded-full bg-canvas px-1.5 py-0.5 text-[10px] font-semibold text-muted">manual only</span>}
                            {issue.destructive && <span className="ml-2 rounded-full bg-failed-tint px-1.5 py-0.5 text-[10px] font-semibold text-failed-text">destructive</span>}
                          </p>
                          {issue.fixHint && <p className="mt-1 text-xs text-muted">{issue.fixHint}</p>}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-xs text-muted">{STATUS_LABEL[issue.status] ?? issue.status}</span>
                          {(issue.status === "open" || issue.status === "approved") && (
                            <>
                              {issue.proposedDiff && (
                                <button onClick={() => setShowPreview(showPreview === issue.id ? null : issue.id)}
                                  className="rounded-full bg-paper px-2.5 py-1 text-xs font-semibold text-ink shadow-control hover:shadow-outline disabled:opacity-50">Preview</button>
                              )}
                              {issue.status === "open" && (
                                <button onClick={() => setIssueStatus(issue.id, "approved")} disabled={busy}
                                  className="rounded-full bg-done px-2.5 py-1 text-xs font-semibold text-white aos-press disabled:opacity-50">
                                  Approve fix
                                </button>
                              )}
                              <button onClick={() => setIssueStatus(issue.id, "ignored")} disabled={busy}
                                className="rounded-full bg-paper px-2.5 py-1 text-xs font-semibold text-ink shadow-control hover:shadow-outline disabled:opacity-50">
                                Ignore
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {showPreview === issue.id && issue.proposedDiff && (
                        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-canvas p-2 font-mono text-[11px] text-muted">
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
                    <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-3 text-sm">
                      <div>
                        <p className="text-ink">
                          <span className="font-medium">{r.fixesApplied} fix{r.fixesApplied === 1 ? "" : "es"}</span>
                          <span className="ml-2 inline-flex items-center gap-1.5 text-xs text-muted">{RUN_SHAPE[r.status] && <span className={RUN_SHAPE[r.status]} aria-hidden />}{r.status} · {new Date(r.startedAt).toLocaleString()}</span>
                        </p>
                        {r.reportSummary && <p className="mt-0.5 text-xs text-muted">{r.reportSummary}</p>}
                      </div>
                      {r.snapshotRef && r.status === "completed" && (
                        <button onClick={() => revertRun(r.id)} disabled={busy}
                          className="rounded-full bg-paper px-2.5 py-1 text-xs font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] hover:bg-failed-tint disabled:opacity-50">
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
