// ShapesOS — the cron schedule table (Phase 6 runtime).
//
// Every scheduled sweep the app has, with its cadence. lib/cron/runner.ts
// drives this table when CRON_RUNNER=internal; operators who keep an external
// scheduler (host crontab, Kubernetes CronJob, a PaaS cron) can generate their
// entries from it too (DEPLOY.md §3.8 mirrors it).
//
// Cadences are 5-field cron expressions read in UTC (lib/scheduler/cron.ts —
// the app's one cron parser). Where DEPLOY.md §3.8 documents a cadence, the
// expression is copied from it verbatim (source: "deploy"). Where nothing was
// documented, the cadence is a conservative pick from the route's own header
// comment and is marked source: "picked" with the reasoning in `note`.
//
// A unit test (lib/cron/__tests__/jobs.test.ts) fails when a route is added
// under app/api/cron/ without an entry here.

import { parseCron, type CronSchedule } from "@/lib/scheduler/cron";

export interface CronJob {
  /** Stable key, recorded on cron_runs.job. */
  key: string;
  /** Route path the runner POSTs to (same origin). */
  path: string;
  /** 5-field cron expression, UTC. */
  cron: string;
  /** Where the cadence came from. */
  source: "deploy" | "picked";
  /** Why this cadence (required when source is "picked"). */
  note?: string;
  /** Hard cap on one run before the runner records a timeout. */
  timeoutMs: number;
  /**
   * Env var holding the bearer this route accepts. Default CRON_SECRET (the
   * shared cron gate). A job whose secret is unset is skipped, logged once.
   */
  secretEnv?: string;
}

const MIN = 60_000;
/** Short sweeps and queue drains. */
const SHORT = 10 * MIN;
/** Crawls, LLM passes, report rendering, provider-heavy sweeps. */
const LONG = 30 * MIN;

export const CRON_JOBS: readonly CronJob[] = [
  // --- Every minute -------------------------------------------------------
  { key: "webhooks", path: "/api/cron/webhooks", cron: "* * * * *", source: "deploy", timeoutMs: SHORT },
  {
    key: "workflows",
    path: "/api/cron/workflows",
    cron: "* * * * *",
    source: "picked",
    note: "Schedule triggers match the current minute (cronDue), so the sweep must run every minute or slots are missed.",
    timeoutMs: SHORT,
  },
  {
    key: "scheduler-tick",
    path: "/api/scheduler/tick",
    cron: "* * * * *",
    source: "picked",
    note: "Scheduled skills fire on the next tick after nextRunAt; every minute keeps them on time (the tick catches up missed slots once).",
    timeoutMs: SHORT,
  },

  // --- Every 5–15 minutes -------------------------------------------------
  { key: "newsletter", path: "/api/cron/newsletter", cron: "*/5 * * * *", source: "deploy", timeoutMs: SHORT },
  { key: "social", path: "/api/cron/social", cron: "*/5 * * * *", source: "deploy", timeoutMs: SHORT },
  { key: "ads", path: "/api/cron/ads", cron: "*/5 * * * *", source: "deploy", timeoutMs: SHORT },
  {
    key: "messaging",
    path: "/api/cron/messaging",
    cron: "*/5 * * * *",
    source: "picked",
    note: "Undocumented; same cadence as the newsletter and social send sweeps. Per-row consent, quiet hours and caps are re-checked at dispatch.",
    timeoutMs: SHORT,
  },
  {
    key: "nurture",
    path: "/api/cron/nurture",
    cron: "*/5 * * * *",
    source: "picked",
    note: 'Route header: "schedule every few minutes so sequence steps land on time".',
    timeoutMs: SHORT,
  },
  {
    key: "connector-refresh",
    path: "/api/cron/connector-refresh",
    cron: "*/10 * * * *",
    source: "picked",
    note: "Route header: every 5–15 minutes. Tokens are refreshed 15 minutes before expiry, so 10 minutes always lands inside that window.",
    timeoutMs: SHORT,
  },
  {
    key: "call-reminders",
    path: "/api/calls/reminders/run",
    cron: "*/10 * * * *",
    source: "picked",
    note: 'Route header: "intended for a scheduler cron". 10 minutes keeps the 1-hour reminder within ~10 minutes of its target. Uses its own bearer.',
    timeoutMs: SHORT,
    secretEnv: "REMINDERS_CRON_SECRET",
  },
  {
    // Phase 9 (repos): webhook fallback for agent PR feedback; a no-op unless GITHUB_PR_POLL=on.
    key: "github-prs",
    path: "/api/cron/github-prs",
    cron: "*/5 * * * *",
    source: "picked",
    note: "Phase 9 webhook fallback (opt-in, GITHUB_PR_POLL=on): review feedback is picked up within ~5 minutes; each pass reads at most 50 PRs, 4 GitHub calls each.",
    timeoutMs: SHORT,
  },
  { key: "alerts", path: "/api/cron/alerts", cron: "*/15 * * * *", source: "deploy", timeoutMs: SHORT },
  { key: "gsc-inspection", path: "/api/cron/gsc-inspection", cron: "*/15 * * * *", source: "deploy", timeoutMs: SHORT },
  { key: "social-engagement", path: "/api/cron/social-engagement", cron: "*/15 * * * *", source: "deploy", timeoutMs: SHORT },
  {
    key: "actions",
    path: "/api/cron/actions",
    cron: "*/15 * * * *",
    source: "picked",
    note: "Undocumented; expiring pending approvals past their TTL. 15 minutes matches the alerts flush and is well inside any approval TTL.",
    timeoutMs: SHORT,
  },
  {
    key: "contextdev-monitors",
    path: "/api/cron/contextdev-monitors",
    cron: "*/15 * * * *",
    source: "picked",
    note: "New in Phase 6. The shortest monitor cadence is hourly; a 15-minute sweep checks each due monitor within 15 minutes of its slot. Each check is budget-gated before the vendor is hit.",
    timeoutMs: LONG,
  },

  // --- Hourly -------------------------------------------------------------
  { key: "gsc-pull", path: "/api/cron/gsc-pull", cron: "5 * * * *", source: "deploy", timeoutMs: LONG },
  // Phase 10 (ops-core): helpdesk SLA breaches → notify once per ticket.
  {
    key: "ops-helpdesk-sla",
    path: "/api/cron/ops-helpdesk-sla",
    cron: "*/10 * * * *",
    source: "picked",
    note: "New in Phase 10. The tightest default SLA is a 60-minute first response; a 10-minute sweep flags a breach within 10 minutes and notifies once.",
    timeoutMs: SHORT,
  },
  // Phase 13 (twincore): digital twin conditions → alerts + editor notifications.
  {
    key: "twin-alerts",
    path: "/api/cron/twin-alerts",
    cron: "*/5 * * * *",
    source: "picked",
    note: "New in Phase 13. The tightest twin threshold is a truck 30 minutes past its ETA; a 5-minute sweep flags it within 5 minutes, and each condition alerts once (dedup keys), so the cadence never repeats an alert.",
    timeoutMs: SHORT,
  },
  // Phase 10 (ops-core): min/max reorder rules → draft purchase orders.
  {
    key: "ops-reorder",
    path: "/api/cron/ops-reorder",
    cron: "20 * * * *",
    source: "picked",
    note: "New in Phase 10. Drafts only (sending stays gated) and one draft per breach, so hourly is safe and keeps reorders same-day.",
    timeoutMs: SHORT,
  },

  // --- Daily --------------------------------------------------------------
  {
    key: "learning-consolidate",
    path: "/api/cron/learning-consolidate",
    cron: "0 2 * * *",
    source: "picked",
    note: 'Route header: "schedule nightly". 02:00 UTC, before the morning report and autopilot sweeps.',
    timeoutMs: LONG,
  },
  { key: "recording-retention", path: "/api/cron/recording-retention", cron: "0 3 * * *", source: "deploy", timeoutMs: LONG },
  {
    key: "connector-intro-expiry",
    path: "/api/cron/connector-intro-expiry",
    cron: "15 4 * * *",
    source: "picked",
    note: 'Route header: "schedule daily". Off-peak, staggered from the other daily sweeps.',
    timeoutMs: SHORT,
  },
  {
    key: "connector-paths",
    path: "/api/cron/connector-paths",
    cron: "30 4 * * *",
    source: "picked",
    note: 'Route header: "daily is plenty". Off-peak, staggered.',
    timeoutMs: LONG,
  },
  {
    key: "dataset-health",
    path: "/api/cron/dataset-health",
    cron: "45 4 * * *",
    source: "picked",
    note: 'Route header: "schedule daily". Off-peak, staggered.',
    timeoutMs: SHORT,
  },
  {
    key: "funding-followups",
    path: "/api/cron/funding-followups",
    cron: "0 6 * * *",
    source: "picked",
    note: 'Route header: "schedule daily so the upcoming → due-today → overdue tiers fire on time". Early so reminders land at the start of the day.',
    timeoutMs: SHORT,
  },
  {
    key: "legal-deadlines",
    path: "/api/cron/legal-deadlines",
    cron: "15 6 * * *",
    source: "picked",
    note: 'Route header: "schedule daily so the 90/30/7/overdue tiers fire on time". Early, staggered.',
    timeoutMs: SHORT,
  },
  {
    // Phase 10 (finance): recurring invoice drafts, quote expiry, overdue sweep.
    key: "finance",
    path: "/api/cron/finance",
    cron: "20 6 * * *",
    source: "picked",
    note: 'Route header: "daily". Drafts recurring invoices (drafts only — sending still asks), expires quotes, flips overdue invoices. Early so drafts are ready at the start of the day; staggered from the other 06:xx sweeps.',
    timeoutMs: SHORT,
  },
  { key: "fix-agent", path: "/api/cron/fix-agent", cron: "30 6 * * *", source: "deploy", timeoutMs: LONG },
  { key: "reports", path: "/api/cron/reports", cron: "0 7 * * *", source: "deploy", timeoutMs: LONG },
  { key: "autopilot", path: "/api/cron/autopilot", cron: "0 7 * * *", source: "deploy", timeoutMs: LONG },
  { key: "platform-radar", path: "/api/cron/platform-radar", cron: "30 7 * * *", source: "deploy", timeoutMs: LONG },
  { key: "visibility-score", path: "/api/cron/visibility-score", cron: "0 8 * * *", source: "deploy", timeoutMs: LONG },

  // --- Weekly (Mondays) ---------------------------------------------------
  { key: "decay", path: "/api/cron/decay", cron: "0 9 * * 1", source: "deploy", timeoutMs: LONG },
  { key: "radar", path: "/api/cron/radar", cron: "30 9 * * 1", source: "deploy", timeoutMs: LONG },
  { key: "backlinks", path: "/api/cron/backlinks", cron: "0 10 * * 1", source: "deploy", timeoutMs: LONG },
  { key: "internal-links", path: "/api/cron/internal-links", cron: "30 10 * * 1", source: "deploy", timeoutMs: LONG },
  { key: "fleet", path: "/api/cron/fleet", cron: "0 11 * * 1", source: "deploy", timeoutMs: LONG },
  { key: "local-grid", path: "/api/cron/local-grid", cron: "0 11 * * 1", source: "deploy", timeoutMs: LONG },
  { key: "local-competitors", path: "/api/cron/local-competitors", cron: "30 11 * * 1", source: "deploy", timeoutMs: LONG },
  { key: "reviews", path: "/api/cron/reviews", cron: "0 12 * * 1", source: "deploy", timeoutMs: LONG },

  // --- Monthly ------------------------------------------------------------
  { key: "storage-metering", path: "/api/cron/storage-metering", cron: "0 2 1 * *", source: "deploy", timeoutMs: LONG },
  { key: "overage-invoicing", path: "/api/cron/overage-invoicing", cron: "0 3 1 * *", source: "deploy", timeoutMs: LONG },
  // Phase 15.4 (zernio): connected-account metering, before overage invoicing.
  { key: "zernio-accounts", path: "/api/cron/zernio-accounts", cron: "30 2 1 * *", source: "deploy", timeoutMs: LONG },
  // Phase 15.4 (zernio): daily ad-report pull (last 7 days) into ad_reports.
  { key: "zernio-ads-reports", path: "/api/cron/zernio-ads-reports", cron: "40 5 * * *", source: "deploy", timeoutMs: LONG },
];

const parsed = new Map<string, CronSchedule>();

/** The parsed schedule for a job (cached; the table is static). */
export function jobSchedule(job: CronJob): CronSchedule {
  let s = parsed.get(job.key);
  if (!s) {
    s = parseCron(job.cron);
    parsed.set(job.key, s);
  }
  return s;
}

/** The bearer env var a job needs. */
export function jobSecretEnv(job: CronJob): string {
  return job.secretEnv ?? "CRON_SECRET";
}

/**
 * Upper bound on start-time jitter. Every-minute jobs must still land inside
 * the minute they were due (the workflows sweep matches the current minute),
 * so they get at most 5s; everything else up to 30s.
 */
export function jobMaxJitterMs(job: CronJob): number {
  return job.cron.trim() === "* * * * *" ? 5_000 : 30_000;
}
