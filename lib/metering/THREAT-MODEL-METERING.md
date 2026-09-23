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

## Non-goals (explicitly not handled here)

- Stripe webhook forgery / top-up fraud — the sink is a stub; the hosted
  track that wires Stripe owns its webhook verification.
- A workspace admin disputing *legitimate* charges — that's a support
  process, and the immutable ledger is its evidence.
- Per-seat billing, proration, plan changes mid-period — out of MVP scope.
