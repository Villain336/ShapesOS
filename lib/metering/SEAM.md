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

### MCP tool calls (sibling track)

`mcp_tool_call` is passthrough: the MCP server calls `meter()` with the
**underlying action's** key (e.g. `get_rank_report` → `rank_check`,
`run_seo_audit` → `site_audit`, `draft_content_brief` → `content_brief`),
not `mcp_tool_call` itself. `get_usage_summary` → call `getUsageSummary()`
directly (no charge — it's a read).

## Follow-up wiring (not in this track)

| Action | Owning service | Charge point |
|---|---|---|
| `rank_check` | rank tracker cron | per keyword checked |
| `serp_analysis` | SERP service | per live SERP pull |
| `keyword_research` | keyword service | per research task |
| `keyword_ideas` | keyword ideas | per expansion |
| `keyword_gap` | competitor gap | per gap analysis |
| `site_audit` | site audit | per crawl |
| `backlink_summary` | backlinks | per summary request |
| `content_brief` / `ai_article` / `content_refresh` | content engine | per generation |
| `storage_over_quota` | quota cron (monthly) | per GB-month over quota |
| `skill_run_base` / `subagent_spawn` | scheduler | ✅ wired this track |

## What meter() guarantees callers

- Unknown action → `{ ok: false, reason: "unknown_action" }`, nothing written.
- Over cap → `{ ok: false, reason: "cap_exceeded", message }`, nothing written.
- Replay → `{ ok: true, charged, eventId }` of the original, no second charge.
- Metering never throws for business reasons; it throws only on programmer
  errors (missing workspaceId/key, negative override, cross-workspace key).
- The ledger write and the balance bump are one transaction; the 80% alert
  fires after commit and is best-effort.
