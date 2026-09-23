# Marketr — Metering Threat Model (Phase C, W4)

The usage ledger is the money. Every abuse case below is either enforced in
`lib/metering/service.ts`, in the Prisma schema/migration, or covered by
`scripts/verify-metering.mts`. Nothing in this track touches Stripe — the
billing sink is a hosted-only stub behind an interface.

## T1 — Idempotency-key replay / double-charge

**Abuse:** A caller retries `meter()` with the same `idempotencyKey` (network
retry, user double-click, or a malicious client replaying a key) and gets
charged twice for one action.

**Mitigations:**
- `UsageEvent.idempotencyKey` is `UNIQUE` at the DB level. The second insert
  with the same key can never create a second row — the database is the
  backstop, not application logic.
- `meter()` checks for an existing event with the key *before* the cap
  check. A replay returns the prior result (`{ ok: true, charged, eventId }`)
  without touching `CreditBalance.usedCredits` — replays never consume cap.
- Cross-workspace key reuse is rejected, not honored: if the existing event's
  `workspaceId` differs from the caller's, `meter()` throws instead of
  returning the prior result, so a key minted in workspace A can never be
  used to read (or launder charges through) workspace B. Keys should be
  namespaced by the caller (`skill-run:<id>`, `subagent-run:<id>`), but the
  server does not trust the namespace — it checks the stored workspace.
- Race between the pre-check and the insert (two concurrent first-time calls
  with the same key): the unique constraint raises P2002 inside the
  transaction; `meter()` catches it, re-reads the winner's row, and returns
  it. Exactly one charge, ever.

**Battery:** replay same key 3× → 1 event, 1× charge; concurrent same-key
pair → 1 event; cross-workspace key reuse → rejected.

## T2 — Cap-bypass races (concurrent meter() calls)

**Abuse:** N concurrent `meter()` calls each read `usedCredits` below the cap,
all pass the check, all append — the workspace blows past its cap.

**Mitigations:**
- Cap check and ledger append happen inside one interactive transaction that
  opens with `SELECT ... FOR UPDATE` on the workspace's `CreditBalance` row.
  Concurrent `meter()` calls for the same workspace serialize on the row
  lock; each sees the previous call's bumped `usedCredits` before deciding.
- The row is created on first use (upsert-inside-transaction) so there is
  always exactly one balance row per workspace to lock.
- `usedCredits` is only ever incremented inside that locked transaction —
  there is no other writer (the battery asserts no code path updates it
  outside `meter()`).

**Battery:** 20 concurrent `meter()` calls against a cap with room for 7 →
exactly 7 succeed, 13 get `cap_exceeded`, `usedCredits` equals 7× cost.

## T3 — Cross-workspace charging (actor in workspace A billed to B)

**Abuse:** A caller passes another workspace's ID (or a project belonging to
another workspace) so their usage lands on someone else's credit pool —
or reads someone else's ledger for reconnaissance.

**Mitigations:**
- `meter()` is a library function; the workspace boundary is enforced by its
  *callers* (API routes use `requireWorkspaceAccess`, the scheduler passes
  the run's own `workspaceId`). The service itself never accepts a
  workspace ID from an untrusted channel — routes take it from the session's
  authorized workspace, never from a request body.
- When `projectId` is supplied, `meter()` verifies the project belongs to
  the given workspace (single query) and throws on mismatch. A project ID
  from workspace B cannot be attached to workspace A's ledger.
- Reads (`getUsageSummary`, CSV export) filter strictly by `workspaceId`
  from the authorized session; `byProject` aggregation groups by the
  project's own workspace-scoped rows only.
- `actorId` is recorded as evidence only — it never influences which
  workspace is charged. The charged workspace always comes from the
  server-side context (route auth or the scheduler run's workspace).

**Battery:** meter with project from another workspace → rejected; summary
for workspace A contains zero rows from workspace B.

## T4 — Negative/zero credit actions

**Abuse:** A caller passes a negative credit amount (refund themselves into
a larger balance) or games zero-cost actions to inflate usage.

**Mitigations:**
- Credit amounts come from the versioned `CREDIT_COSTS` table, not from the
  caller. The optional `credits` override (used by the scheduler for
  composite run totals) is validated: must be an integer ≥ 0, else the call
  throws before any DB write.
- There is no negative-cost action in the table and no refund path in this
  track — refunds/adjustments are a future admin flow with its own audit,
  deliberately out of scope.
- Zero-cost actions (`publish`, `connector_sync`) append a 0-credit event
  for audit completeness but skip the balance bump and can never reduce
  `usedCredits`. They also cannot *increase* the cap headroom — the bump is
  `increment(0)`, a no-op by construction.
- `usedCredits` is `Int` (no floats anywhere — `1 credit = $0.01` is only a
  display conversion) and the schema has no decrement path.

**Battery:** negative override → throws, no event; zero-cost action →
`ok: true, charged: 0`, balance unchanged; unknown action → `unknown_action`.

## T5 — Ledger tampering (updates/deletes to UsageEvent)

**Abuse:** Anyone with DB or code access rewrites history — updates a row's
credits, deletes events to hide usage, backdates `occurredAt`.

**Mitigations:**
- Application layer: `lib/metering/service.ts` exposes no update or delete
  for `UsageEvent` — the only write path is `create` inside `meter()`.
  There is no `updateUsageEvent`/`deleteUsageEvent` export to misuse.
- Database layer: the migration adds a `prevent_usage_event_mutation()`
  trigger that raises on any `UPDATE` or `DELETE` on `usage_events`
  (PostgreSQL rule — enforced even for direct SQL/console access, unlike
  application-level checks). The trigger is documented in the migration.
- `occurredAt` is set server-side (`now()`) at insert; callers cannot supply
  it. `id` is `cuid()`, `idempotencyKey` is caller-supplied but unique.
- Dispute evidence (`evidenceRef`) is a free-text pointer (run ID, report
  path), never the evidence itself — see T7.

**Battery:** raw `UPDATE`/`DELETE` on `usage_events` → rejected by the
trigger; service has no update/delete exports (static check).

## T6 — Period-rollover double-counting

**Abuse:** At the month boundary, usage is counted against both the old and
new period (double charge against the cap), or `usedCredits` resets while
events from the old period still count, or purchased credits vanish early.

**Mitigations:**
- Rollover happens lazily inside `meter()`'s locked transaction: if `now ≥
  periodStart + 1 month`, the transaction first resets `usedCredits = 0`,
  advances `periodStart` to the new period, expires purchased credits past
  their 12-month `purchasedExpiresAt`, *then* applies the current charge to
  the fresh period. One transaction, one period — a charge can never land
  in two periods.
- `getUsageSummary` defaults to the balance's current `periodStart` and
  aggregates events with `occurredAt ≥ periodStart`, so the dashboard and
  the cap always agree on what "this period" means.
- The 80%-alert "once per period" uses `SpendCap.lastAlertAt < periodStart`
  as the reset condition — a new period re-arms the alert exactly once.
- Included credits reset monthly; purchased top-ups persist until
  `purchasedExpiresAt` (12 months from purchase). Both fields live on
  `CreditBalance`, mutated only in the locked rollover path.

**Battery:** backdate `periodStart` 40 days, meter once → `usedCredits`
equals only the new charge, `periodStart` advanced; alert re-arms.

## T7 — evidenceRef spoofing in disputes

**Abuse:** A caller sets `evidenceRef` to a misleading value ("refunded",
another workspace's run ID) to win a chargeback dispute.

**Mitigations:**
- `evidenceRef` is *descriptive, not authoritative*: the ledger's
  `action`, `credits`, `occurredAt`, `projectId`, and `actorId` are the
  dispute facts. `evidenceRef` is a pointer for humans ("see run X").
- Server-generated callers (scheduler) set it to internal IDs the server
  minted; it is never rendered as a trusted link without re-resolving the
  ID through the normal authorization path.
- The CSV export labels the column `evidence_ref (unverified pointer)` so
  downstream consumers (Mara's client invoices) don't treat it as proof.

## T8 — keyId spoofing / attribution integrity (Phase C gaps, G1)

**Abuse:** An MCP caller passes another workspace's API-key ID (or a made-up
keyId) as `keyId` so their usage is attributed to someone else's key —
poisoning per-key breakdowns, or laundering usage through a key that will be
revoked/deleted to hide the trail.

**Mitigations:**
- `keyId` is validated server-side inside the meter transaction: it must
  match an `mcpApiKey.id` **or** `mcpOAuthClient.clientId` whose
  `workspaceId` equals the charged workspace. A keyId from another workspace
  (or a nonexistent one) throws — same treatment as cross-workspace
  projectId (T3).
- `meter()` is a library function; the only trusted keyId source is the MCP
  server's own auth context (`requireMcpAuth` → `ctx.credential.keyId`),
  resolved from the Bearer <redacted> hash before the tool runs. Callers never take
  keyId from agent-supplied input.
- On idempotency replay, the *original* event's keyId stands — a replay
  cannot re-attribute an existing charge to a different key.
- Revocation is enforced at auth time (`requireMcpAuth`), not in the
  ledger: a revoked key can no longer mint calls, so its historical rows
  stay accurate without a ledger-side revocation check.

**Battery:** meter with another workspace's keyId → throws, no event;
nonexistent keyId → throws; valid keyId → stored, appears in `byKey`.

## T9 — pre-run cap-gate TOCTOU (Phase C gaps, G1)

**Abuse / failure mode:** The scheduler's pre-run `checkCap()` says "allowed",
but between the check and the post-run charge another process consumes the
cap — the run executes "for free", or conversely the pre-check blocks a run
that would have fit.

**Mitigations:**
- The pre-run gate is an **optimization, not the enforcement boundary**.
  Enforcement stays in `meter()`'s locked transaction (T2): if the cap is
  exhausted by the time the run's charges land, the charges return
  `cap_exceeded`, are audit-logged, and the run's ledger stays clean. The
  pre-check can never *authorize* an over-cap charge.
- The pre-check never writes: it cannot double-charge, and a blocked run
  records `status: "blocked"` with the plain-language reason in the run's
  `error` field plus a `scheduler_run_blocked_cap` audit entry. Blocked runs
  never execute — no subagent rows, no tool calls, no charges.
- `checkCap()` is advisory by contract (its doc comment says so); only
  `meter()` is authoritative. The gate reuses the same `blockAtCap` /
  `autoOverage` semantics so gate and charge cannot disagree on policy.

**Battery:** capped workspace → `executeSkillRun` returns with run status
`blocked`, zero subagent rows, zero new usage events, audit entry present.

## T10 — wiring-point workspace confusion (Phase C gaps, G1)

**Abuse:** A newly wired charge point takes `workspaceId` from the request
body / query string, letting a caller bill another workspace (or read its
cap state via error messages).

**Mitigations:**
- Every charge point derives `workspaceId` from a server-side join, never
  from client input: the project row (`project.workspaceId`), the site row's
  project, the skill run's `workspaceId`, or the cron gate's session
  workspace. The battery statically asserts no wired call site passes a
  body-derived workspaceId (grep check on the diff).
- `projectId`, where supplied, is re-validated inside `meter()` (T3) — the
  charge point's project lookup is defense in depth, not the boundary.
- Cap-denied messages are the same plain-language copy everywhere
  ("Credit cap reached … Raise the cap or add credits in Settings → Usage.")
  and never disclose another workspace's usage.

## T11 — storage snapshot approximation honesty (Phase C gaps, G1)

**Abuse / failure mode:** The monthly `storage_over_quota` cron charges from
a point-in-time `usedBytes` snapshot, not a time-weighted average — a
workspace that spikes over quota and cleans up before month-end is never
charged, while one that sits 1 byte over all month pays a full GB-month.

**Mitigations (honesty, not precision):**
- The cron route header, SEAM.md, and the Settings → Usage copy all state
  the rule plainly: **charged on the month-end snapshot, per whole GB over
  quota (rounded up), 1 credit per GB-month**. No pretense of averaging.
- The idempotency key `storagequota:<workspaceId>:<YYYY-MM>` makes the
  monthly charge exactly-once; a re-run of the cron never double-charges.
- The GB math is a pure exported helper (`gbOverQuota`) covered by the
  battery, so the rounding rule is pinned by test, not by prose.

## T12 — hour-bucket idempotency for row-less actions (Phase C gaps, G1)

**Abuse / failure mode:** `keyword_ideas`, `keyword_gap`, and chat-tool
equivalents have no domain row to derive a stable idempotency key from, so
SEAM.md's `<action>:<row-id>` pattern cannot apply. A random key per attempt
would make every retry a new charge; a fully stable key would make repeat
use free forever.

**Mitigations (documented tradeoff):**
- These actions use `kwideas:<projectId>:<seedHash>:<limit>:<UTC-hour>` (and
  the `kwgap:` analogue): retries/double-clicks within the same UTC hour
  dedup to one charge; genuinely repeated use an hour later charges again.
- The tradeoff is explicit: we under-charge (favor the user) on repeats
  within the hour rather than risk double-charging on retry. The battery
  pins both behaviors.
- Actions WITH a domain row (rank_check → ranking row, content_brief →
  contentItem, ai_article → contentItem+updatedAt, site_audit → audit row,
  backlink_summary → pull row, content_refresh → autopilotItem) keep the
  strict `<action>:<row-id>` form.

## T13 — day-bucket idempotency gaming (standalone SERP/keyword paths)

**Abuse / failure mode:** `serp_analysis` and `keyword_research` have no
domain row, so their idempotency keys are day-bucketed:
`serpanalysis:<hash(workspace+keyword+location+device+day)>`,
`keywordresearch:<hash(workspace+seed+location+limit+day)>`. A user who re-runs the
same query tomorrow is charged again (intended — SERPs change daily); a
user who hammers the same query all day gets one charge (intended
under-charge, same tradeoff as T12's hour buckets, but day-granular
because SERP data is meaningfully stable within a day and the vendor pull
is the costliest primitive).

**Mitigations (documented tradeoff):**
- The day bucket is UTC (`dayBucket()` in `lib/metering/wiring.ts`) — no
  timezone gaming; the boundary is the same for everyone.
- Replays within the day return `{ ok: true }` from `meter()` with the
  ORIGINAL event — the replay path is checked before the cap check (T1),
  so a same-day repeat is never cap-blocked and never double-charged.
- The pull itself re-executes on replay (results are not cached) — in live
  mode this spends vendor budget without a user charge. Accepted: the
  alternative (caching SERPs) is a product feature with staleness
  semantics, not a metering fix. Documented here so it can't be
  "discovered" later as a surprise.
- Key includes workspace+location+device+limit so "same keyword, different market"
  is a genuinely different (charged) analysis, not a free replay.

**Battery:** same query twice same day → 1 event; different day bucket →
new charge; different location → new charge.

## T14 — shared-helper metering discipline (no double-charge on SERP pulls)

**Abuse / failure mode:** The raw SERP pull is now a shared un-metered
helper (`lib/serp/pull.ts` `pullSerp()`). If a caller meters it AND the
parent action meters too (brief generation charging both `content_brief`
and `serp_analysis` for its internal pull), the user is double-charged for
one intent — violating the charge-at-intent rule.

**Mitigations:**
- `pullSerp()` is un-metered BY CONSTRUCTION: it imports nothing from
  `lib/metering` (static battery check — the import graph is pinned), so it
  cannot charge no matter how it is called.
- Metering lives ONLY at the seams: the standalone
  `POST /api/serp/analyze` route (action `serp_analysis`) and the existing
  parent-action call sites (`content_brief` per ContentItem,
  `rank_check` per ranking row). Internal pulls inside those flows call
  `pullSerp()` and charge only the parent action.
- The MCP `analyze_serp` tool meters via the per-tool passthrough (the
  UNDERLYING `serp_analysis` action, 1 credit) BEFORE execution; its
  handler calls the same un-metered core as the route — no second charge.
- The old best-effort `recordUsage(workspaceId, "serp_calls", 1)` counter
  is untouched legacy telemetry, not the ledger — it never affects billing.

**Battery:** generate a brief (which pulls a SERP internally) → exactly one
ledger event with action `content_brief`, zero `serp_analysis` events;
static check that `lib/serp/pull.ts` has no metering import.

## Policy notes (not threats, recorded so they can't drift)

- **Mock-mode charging:** the ledger meters successful actions even when the
  underlying provider is a mock (same as the Phase C scheduler wiring).
  Credits are the product's unit of account, not a vendor-cost pass-through;
  on self-host they cost nothing. The UI already marks mock results as mock.
- **Charge at intent:** one user intent = one ledger action. A brief that
  pulls 5 SERPs internally charges `content_brief` once, not 5×
  `serp_analysis`. The standalone routes exist so standalone intent is
  possible — and separately billable.

## Non-goals (explicitly not handled here)

- Stripe webhook forgery / top-up fraud — the sink is a stub; the hosted
  track that wires Stripe owns its webhook verification.
- A workspace admin disputing *legitimate* charges — that's a support
  process, and the immutable ledger is its evidence.
- Per-seat billing, proration, plan changes mid-period — out of MVP scope.
