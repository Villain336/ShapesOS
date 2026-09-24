# Marketr — metering seam (Phase C, W4)

How any product action becomes a ledger charge. The scheduler is wired
(`lib/scheduler/runner.ts` → `recordMeterCharge`); everything below is the
documented follow-up — do not rewrite every service in this track.

## The call pattern

```ts
import { meter } from "@/lib/metering/service";

const res = await meter({
  workspaceId,            // from the authorized session / run — NEVER from request body
  projectId,              // optional; must belong to workspaceId (server-checked)
  actorId,                // optional; evidence only, never affects billing
  action: "rank_check",   // key into CREDIT_COSTS (lib/metering/credits.ts)
  idempotencyKey: `rankcheck:${checkRowId}`,  // stable per charge — see below
  evidenceRef: `rank-check:${checkRowId}`,    // unverified human pointer (T7)
});

if (!res.ok && res.reason === "cap_exceeded") {
  // Surface res.message verbatim — it is already plain-language.
  // Do NOT retry silently; do NOT split the action to dodge the cap.
}
```

### Idempotency keys

Derive from the domain row the charge pays for: `<action>:<row-id>`. The same
logical charge retried (network retry, double-click, cron re-fire) reuses
the key and returns the prior result with no double charge. Never generate a
random key per attempt — that defeats the dedup. Cross-workspace key reuse
is rejected server-side.

### When to call

At the point the cost is incurred, after the action succeeds. For
orchestration (scheduler), charges are recorded per component as they
complete: `skill_run_base` (run-level) + `subagent_spawn` (per subagent),
with the optional `credits` override carrying the computed total so the
ledger reconciles with the run's `creditsUsed`.

### Zero-cost actions

`publish` and `connector_sync` cost 0. Call `meter()` anyway — it appends a
0-credit event for audit completeness and never touches the cap.

### Usage dimensions (not credit actions)

Some quantities are *dimensions* surfaced for reporting/limits, not
billable credit actions. They never call `meter()` and never appear on the
ledger as charges:

| Dimension | Source | Meaning |
|---|---|---|
| `crm_active_leads` | `lib/crm/meter.ts` | Count of leads not in a closed (won/lost) stage, tenant-scoped by `workspaceId`. Read-only: `getActiveLeadCount(workspaceId)`, `getActiveLeadCountByPipeline(workspaceId)`. Used by the CRM UI (pipeline list counts, status bar) and available for future seat/usage-limit policy. No credit charge is created, by design. |
| `attribution` (no meter) | `lib/attribution/*` | Revenue attribution (Phase 2, C2) adds **no new usage meter**. Touch logging, report computation, and spend entries are analytics, not billable actions — they never call `meter()` and never appear on the ledger. Attribution quality (multi-touch models, content influence, ROAS) is a **tier/value feature**, not a metered dimension. `AttributionSpend` rows are manual analytics inputs for CPL/CAC/ROAS math — they are not billing charges and must never be confused with `meter()` credit events. |

### MCP tool calls (sibling track)

`mcp_tool_call` is passthrough: the MCP server calls `meter()` with the
**underlying action's** key (e.g. `get_rank_report` → `rank_check`,
`run_seo_audit` → `site_audit`, `draft_content_brief` → `content_brief`),
not `mcp_tool_call` itself. `get_usage_summary` → call `getUsageSummary()`
directly (no charge — it's a read).

**Per-key attribution (G1):** pass `keyId` in the `meter()` call —
`ctx.credential.keyId` for API-key auth, `ctx.credential.clientId` for
OAuth. It is validated to the workspace server-side (T8); a bad keyId
throws. Reads: `getUsageSummary({ workspaceId, keyId? })` filters to one
key, or returns `byKey` (keyId → credits, `"direct"` bucket for non-MCP
charges) when unfiltered.

## Follow-up wiring (Phase C gaps, G1 — wired)

| Action | Owning service | Charge point |
|---|---|---|
| `rank_check` | rank tracker cron | ✅ per keyword checked (`app/api/rankings/check/route.ts`, key `rankcheck:<rankingId>`) |
| `serp_analysis` | SERP analysis | ✅ standalone (`POST /api/serp/analyze`, key `serpanalysis:<hash(workspace+keyword+location+device+day)>`; T13 day-bucket). Raw pull is the shared un-metered `lib/serp/pull.ts` (T14); internal pulls in brief/rank-check flows charge the parent action only. MCP: `analyze_serp` tool via mcp_tool_call passthrough. |
| `keyword_research` | keyword research | ✅ standalone (`POST /api/keywords/research`, key `keywordresearch:<hash(workspace+seed+location+limit+day)>`; T13 day-bucket). Composes provider keywordIdeas into a clustered report; the lighter `keyword_ideas` expansion is a separate action and is never double-charged. MCP: `research_keywords` tool via mcp_tool_call passthrough. |
| `keyword_ideas` | keyword ideas | ✅ per expansion (`app/api/keywords/ideas/route.ts` + chat `research_keywords` tool; hour-bucketed key, T12) |
| `keyword_gap` | competitor gap | ✅ per gap analysis (`app/api/competitors/gap/route.ts`; hour-bucketed key, T12) |
| `site_audit` | site audit | ✅ per crawl (`lib/audit/audit.ts` `runAudit`; key `siteaudit:<auditId>`; covers the API route and the chat audit tool) |
| `backlink_summary` | backlinks | ✅ per completed pull (`lib/seo/backlink-pull.ts` `runBacklinkPull`; key `backlinksummary:<pullId>`) |
| `content_brief` / `ai_article` / `content_refresh` | content engine | ✅ per generation (brief/draft routes + chat draft tool; autopilot `decay_refresh` items) |
| `storage_over_quota` | quota cron (monthly) | ✅ `POST /api/cron/storage-metering` (key `storagequota:<ws>:<YYYY-MM>`; snapshot rule, T11) |
| `skill_run_base` / `subagent_spawn` | scheduler | ✅ wired Phase C; pre-run cap gate added in G1 (T9) |

## What meter() guarantees callers

- Unknown action → `{ ok: false, reason: "unknown_action" }`, nothing written.
- Over cap → `{ ok: false, reason: "cap_exceeded", message }`, nothing written.
- Replay → `{ ok: true, charged, eventId }` of the original, no second charge.
- Metering never throws for business reasons; it throws only on programmer
  errors (missing workspaceId/key, negative override, cross-workspace key).
- The ledger write and the balance bump are one transaction; the 80% alert
  fires after commit and is best-effort.

## Overage accrual (invoicing track)

When a charge lands beyond the **paid pool** (`includedCredits +
purchasedCredits`), meter() marks the overage portion factually on the
UsageEvent: `overageCredits = max(0, min(charge, usedBefore + charge −
paidPool))`. This is accounting, not policy:

- It is written **only when the workspace has auto-overage ON**. Legacy
  `blockAtCap: false` usage passes the cap but accrues nothing — it can
  never be invoiced. Hard-cap denials write nothing (no event, no accrual).
- It is measured against the paid pool, **not** `cap.capCredits`: an admin
  may raise the cap above the pool, but only the pool is pre-paid.
- It is capped to the charge: an event fully beyond the pool marks exactly
  its own credits, never the cumulative excess. A straddling charge (e.g.
  95/100 used, 10-credit charge) marks only the 5 overage credits — one
  event per charge, exact split.
- Zero-cost actions always mark 0.

The monthly invoice cron (`POST /api/cron/overage-invoicing`,
`StripeBillingSink.invoiceOverage`) sums `overage_credits` per workspace
for completed UTC months; amounts always come from this column — Stripe
never decides what is owed. See `lib/metering/billing.ts` and
THREAT-MODEL-BILLING.md B9–B15.
