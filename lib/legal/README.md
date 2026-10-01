# Legal/Compliance — Slice 1: Obligation map · Slice 2: Deadline engine

Spec: `docs/BUSINESS-OS-FEATURE-SPECS.md` §4. Onboarding captures industry +
business model + jurisdictions → the engine computes the tenant's obligation
checklist (licenses, filings, tax registrations, insurance, permits). Slice 2
adds computed deadlines with escalation tiers that feed the alert hub.

## Slice 2 layout

- `deadlines.ts` — pure engine: escalation tiers (`date_needed`, `due_90`,
  `due_30`, `due_7`, `overdue`), whole-day `daysUntilDue`, month-clamped
  `nextDueDate` from the tenant-set anchor, alert copy builders.
- `deadline-sweep.ts` — workspace sweep: computes each open deadline's tier
  and emits through the alert hub (`legal_deadline` trigger) on tier change
  only (recorded on `lastAlertedTier`), so the 90 → 30 → 7 → overdue ladder
  fires once per tier. Takes store + emitter as arguments (tests inject fakes).
- `prisma-store.ts` — deadline CRUD on the store: `upsertDeadline` (one open
  row per template key; a re-set date resets the escalation ladder),
  `updateDeadline`, `markDeadlineDone` (recurring deadlines spawn the next
  occurrence, source `computed`, anchored to the confirmed date), plus the
  sweep ports `listOpenDeadlines` / `recordAlertedTier`.
- `__tests__/deadlines.test.ts` — 22 tests: tier boundaries, recurrence math,
  date-needed behavior, sweep escalation/dedup, disclaimer on every alert,
  and the no-fabricated-date scan over seed templates.

## Routes

- `GET/POST /api/legal/deadlines` — deadlines with computed tiers +
  obligations still waiting for a date; tenant sets a date (editor).
- `PATCH/DELETE /api/legal/deadlines/[id]` — edit / remove a deadline (editor).
- `POST /api/cron/legal-deadlines` — escalation sweep (cron gate: CRON_SECRET
  across all profiles, or editor+ session for one workspace).
- Alert hub: `legal_deadline` trigger (conditionKeys: severities), emitted by
  the sweep; tenants route it to Slack/Telegram/email like any other trigger.

## UI

- `app/dashboard/legal/views/DeadlinesView.tsx` — deadlines sorted by
  urgency, inline date picker + recurrence select, "waiting for a date"
  queue, completed history. Monochrome urgency pills (status color+shape is
  reserved for genuine agent states).
- `LegalApp.tsx` — Obligations / Deadlines pill tabs with an attention badge.

## Hard guardrails (never bend)

1. **Information, never legal advice** — `LEGAL_DISCLAIMER` on every page,
   API response, and emitted alert.
2. **No invented specifics** — a deadline only exists once the tenant
   sets/confirms a date; recurring reminders are computed from that anchor
   via `nextDueDate`; unconfirmed dates render as "date needed", never a
   guessed date. Seed templates carry cadence, never calendar dates
   (enforced by the no-fabricated-date scan test).
3. **Licensed partner invariant** — insurance deadlines carry no binding
   path; "they hold the licenses, we provide the software."

---

# Slice 1 details (below)

Spec: `docs/BUSINESS-OS-FEATURE-SPECS.md` §4. Onboarding captures industry +
business model + jurisdictions → the engine computes the tenant's obligation
checklist (licenses, filings, tax registrations, insurance, permits).

## Layout

- `types.ts` — domain types, industry/jurisdiction/business-model registries,
  `LEGAL_DISCLAIMER`, input validation.
- `seeds.ts` — 20 seed obligation templates (NC-first + national baseline;
  industries: food, drones, SaaS, services). Coverage expands by data addition:
  new industry/jurisdiction = new rows here, never a code change.
- `obligations.ts` — pure computation engine: `templateAppliesToProfile`,
  `computeObligations` (per-tenant, national layered under jurisdiction
  templates, overrides merged by template key), `validateSeedTemplates`.
- `prisma-store.ts` — `PrismaLegalStore`: profile upsert + obligation
  materialization, idempotent template seeding, computed checklist reads,
  tenant status updates (open/snoozed/dismissed/done).
- `__tests__/obligations.test.ts` — 22 tests: per-tenant generation, NC vs
  national layering, industry filtering, override merge, seed validation,
  and the hard guardrails.

## Routes

- `GET/PUT /api/legal/profile` — profile read/save (PUT = editor).
- `GET /api/legal/obligations` — computed checklist.
- `PATCH /api/legal/obligations/[key]` — status update (editor).
- `GET /api/legal/seed`, `POST /api/legal/seed` — template list / idempotent seed.

## Hard guardrails (never bend)

1. **Information, never legal advice** — `LEGAL_DISCLAIMER` on every page,
   API response, and seed context.
2. **No invented specifics** — templates never carry form numbers, statute
   citations, or specific deadlines; unverified items are `needsReview` and
   render as "verify before acting". Enforced by seed-validation tests.
3. **Licensed partner invariant** — insurance obligations name the licensed
   partner ("they hold the licenses, we provide the software") and never
   present a binding path. Enforced by tests.
