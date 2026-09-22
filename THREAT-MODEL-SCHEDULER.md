# Marketr — Scheduler & Parallel Subagents Threat Model (Phase B, track B2)

**Status:** Written before any code (process-locked: threat model first).
**Scope:** `lib/scheduler/`, `/api/schedules/*`, `/api/scheduler/*`, Automations → Schedules UI, `ScheduledSkill` / `SkillRun` / `SubagentRun` models.
**Assumptions:** The agent loop is mocked (no live LLM, no paid APIs). The filesystem
service (`lib/filesystem/service.ts`) is built by a sibling agent — this track codes
against its published contract and a local fallback.

## Trust boundaries

1. **API layer** — the only enforcement boundary for multi-tenant isolation
   (workspace_id re-checked on every operation; the DB registry is the source
   of truth, never the URL or a client-supplied field).
2. **Trigger engine** (`lib/scheduler/`) — cron evaluation, event bus, run
   guardrails. Runs server-side under service privileges; must never confuse
   a client-supplied payload with an engine-generated event.
3. **Subagent sandbox** — each subagent inherits the parent run's declared
   tools and grants, and *nothing else*.
4. **Filesystem** — run outputs land at `/artifacts/runs/<run-id>/...` through
   the registry-gated service; subagents cannot address other workspaces' paths.

## Abuse cases → mitigations (each has an adversarial test in scripts/verify-scheduler.mts)

### T1. Runaway loops — event trigger that fires itself
*Abuse:* A scheduled skill's output (or its connector writes) generates the same
event the schedule listens for → infinite self-triggering loop burning credits
and hammering providers.
*Mitigations:*
- **Cycle detection:** every SkillRun carries a `triggerLineage` chain
  (`[scheduleId, ...parentScheduleIds]`). An event publish whose lineage already
  contains the candidate schedule is blocked and audited (`scheduler_cycle_blocked`).
- **Max runs per hour per schedule** (default 12, configurable; hard ceiling 60):
  firing beyond the cap is dropped + audited, never queued.
- Event sources must not synchronously emit events that their own firing
  handlers produce (stub detectors are inject-only; real detectors come later
  and must dedupe by payload hash + window).

### T2. Cron-expression injection
*Abuse:* `cronExpr` like `*/1 * * * *; rm -rf /` or `$(curl …)` — anything that
assumes the expression is executed rather than parsed.
*Mitigations:*
- Cron parser is a strict 5-field matcher: each field must match
  `^[0-9,*/-]+$` and every numeric value is range-checked per field
  (min 0-59, hour 0-23, dom 1-31, month 1-12, dow 0-7). Anything else → 400,
  rejected before persistence. No eval, no shell, no regex interpolation of
  the raw string.
- `nextRunAfter` is computed arithmetically from the parsed fields only.

### T3. Unauthorized schedule creation / edit (RBAC)
*Abuse:* An editor creates workspace-wide schedules, a viewer edits someone
else's schedule, or one workspace edits another's schedules by ID guessing.
*Mitigations:*
- Create: `skills.install` grant or admin+ for workspace-scoped schedules;
  project editors may create *project-scoped* schedules only (project must be in
  their workspace). Every mutation re-checks: schedule row's `workspaceId` must
  equal the caller's workspace; cross-workspace IDs → 404 (no existence oracle).
- The M11 scan stays green: every mutation route names an auth primitive
  (`requireWorkspaceAccess`, `requirePermission`, `cronGate`).
- Manual trigger and approve/reject inherit the same grants as create/edit.

### T4. Subagent privilege escalation
*Abuse:* A subagent is granted broader tools/grants than the parent run
(e.g. the parent is a project-scoped run, the subagent writes to another
project or calls an undeclared connector tool).
*Mitigations:*
- Subagents are spawned with a **grant envelope**: `{ workspaceId, projectId,
  skillId, declaredTools, parentRunId }`. The executor intersects the skill's
  declared tools with the envelope; any tool outside the envelope is denied and
  audited (`connector_tool_denied` reuse). Envelope is constructed server-side
  from the parent's DB rows, never from client input.
- Subagent runs are separate `SubagentRun` rows tied to the parent `SkillRun`;
  no ambient privileges pass through process state.

### T5. Event payload spoofing
*Abuse:* A client crafts an event payload claiming `rank_drop` for a project in
another workspace, or forges a `connector_error` to trigger expensive runs.
*Mitigations:*
- `POST /api/scheduler/events` requires editor+ on the target workspace (or the
  CRON_SECRET service path). Payloads are zod-validated against per-source
  schemas; unknown fields are stripped; unknown sources are rejected.
- The workspace/project in the payload must resolve inside the caller's
  accessible workspace — the bus re-checks with `accessibleWorkspaceWhere`.
- Engine-generated lineage is server-side only: clients cannot set
  `triggerLineage`.

### T6. Missed-cron stampede after downtime
*Abuse:* After a restart/outage, every overdue schedule fires at once (or fires
N times for N missed windows) — a thundering herd that burns credits.
*Mitigations:*
- **Catch-up policy (decided):** after a restart, a missed cron fires **once**
  and is audited as `scheduler_run_missed`. The schedule's `nextRunAt` advances
  to the next *future* slot, never replays every missed window.
- Tick is idempotent: `lastRunAt`/`nextRunAt` are updated in the same write
  that claims the run; concurrent ticks can't double-fire.

### T7. Concurrency-cap bypass
*Abuse:* A schedule with `concurrencyLimit: 4` spawns 40 subagents because fan-out
is calculated per skill stage, or two concurrent runs of the same schedule each
spawn 4.
*Mitigations:*
- Concurrency cap = min(schedule.concurrencyLimit, workspace default (4),
  absolute ceiling 16). The fan-out pool is a counting semaphore *per run*;
  a second guard counts active subagents per schedule across runs.
- Cap values from clients are clamped to [1, 16]; non-integers rejected.

### T8. Schedule enumeration across workspaces
*Abuse:* Listing or fetching schedules by ID to discover other tenants' automation.
*Mitigations:*
- All list/detail queries are `where: { id, workspaceId }` — cross-workspace
  IDs return 404, identical to nonexistent. No timing oracle is introduced
  (single indexed query, no two-step existence check).
- Run detail responses never include another workspace's rows (same pattern).

### T9. Supervised-ladder bypass ("run silently" when policy says "notify + wait")
*Abuse:* A supervised skill executes its write/tool effects without human
approval — e.g. manual trigger skips the approval gate, or autopilot mode is
set by an editor who shouldn't choose it.
*Mitigations:*
- Approval mode is evaluated at fire time from the schedule row + workspace
  default; `supervised` runs enter `awaiting_approval` and execute **nothing**
  until an admin/`skills.install`-granted user approves (`scheduler_run_approved`).
  Reject → `rejected`, audited, no effects.
- Manual triggers honor the same mode: they create an `awaiting_approval` run
  for supervised schedules, not a running one.

### T10. Output-path traversal / cross-tenant artifact writes
*Abuse:* `outputPath` containing `../../` or another workspace's ID.
*Mitigations:*
- Output paths are engine-constructed (`/artifacts/runs/<run-id>/...`) — never
  client-supplied. The filesystem service re-checks `workspaceId` per call.
  The local fallback store resolves inside `.data/scheduler-runs/<workspaceId>/`.

## Residual / accepted risks
- The skill executor is **mocked** (no LLM): real agent-loop integration (Phase C
  LLM work) must re-run this battery with the live loop, especially T4/T9.
- In-memory tick coordination: multi-instance deployments need a distributed
  lock (Redis) around `runSchedulerTick` — single-instance now, flagged.
- Cron evaluation uses server-local time; user timezones are stored as
  display-only in v1 (documented in the UI).
