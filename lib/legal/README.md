# Legal/Compliance — Slice 1: Obligation map · Slice 2: Deadline engine

Spec: `docs/BUSINESS-OS-FEATURE-SPECS.md` §4. Onboarding captures industry +
business model + jurisdictions → the engine computes the tenant's obligation
checklist (licenses, filings, tax registrations, insurance, permits). Slice 2
adds computed deadlines with escalation tiers that feed the alert hub.

## Slice 5: digital properties (Hullcheck synergy)

Hullcheck's "don't get sued" engine — legal, compliance, and security
scanning for apps and websites — is the **digital side** of the Legal
surface (slices 1–4 are the physical/regulatory side). Critical context:
Hullcheck is a spec, not an implementation — there is no scan engine to
wire to. So slice 5 implements Hullcheck's **layer taxonomy** (detect / fix
/ prove / harden / document / comply — the six layers of the
legal/compliance/security surface; operate/certify arrive with the engine)
and **result model** inside Legal, structured so the future engine plugs
in. **No scanner is built here.**

- `digital.ts` — pure engine: layer taxonomy, 16-item self-assessment
  checklist (the v1 "scanner": the tenant's own yes/no/not-sure answers),
  `answersToFindings` ("no" = gap at full severity; "not sure" = flagged one
  notch lower, marked Unverified — never silently dropped), finding status
  transitions (open → fixed/dismissed; closed findings reopen), and the
  `DigitalScan` ingestion shape with validation (`hullcheck_engine` scans
  require `engineVersion`).
- `prisma-store.ts` — slice 5 section: property CRUD (`LegalDigitalProperty`:
  name, url, kind website|app, notes), finding CRUD (`LegalDigitalFinding`:
  itemKey, hullcheckLayer, title, plain-English summary, severity, status,
  source, obligationKey), `recordSelfAssessment` (replaces open
  self-assessment findings; fixed/dismissed untouched),
  `importDigitalScan` (**rejects** `hullcheck_engine` until the real engine
  is connected — guardrail: never invent scan results), obligation titles
  joined by key for the UI link-out.
- `__tests__/digital.test.ts` — 34 tests: taxonomy validity, checklist seed
  validity, self-assessment → findings (no/yes/unsure semantics, kind
  filtering, unknown-key rejection), obligation-key linking against the
  slice-1 seed templates, status transitions, source labeling, scan
  validation, severity stepping, URL validation.

## Routes

- `GET/POST /api/legal/digital-properties` — property list / register (editor).
- `GET/PATCH/DELETE /api/legal/digital-properties/[id]` — detail + findings / edit / remove (editor).
- `GET/POST /api/legal/digital-properties/[id]/findings` — findings list / record-by-hand or scan import (editor).
- `PATCH /api/legal/digital-properties/[id]/findings/[findingId]` — status transition (editor).
- `GET/POST /api/legal/digital-properties/[id]/assess` — kind-scoped checklist / submit answers → findings (editor).

## UI

- `app/dashboard/legal/views/DigitalView.tsx` — "Digital" tab in
  `LegalApp.tsx`: property list (dense table), per-property findings grouped
  by Hullcheck layer, self-assessment walk-through (source banner: "your
  answers, not a scan"), manual finding form, plain-English summaries on
  every finding, "have an attorney confirm" nudge on legal items, and a
  link-out to the related slice-1 obligation. "Don't get sued" framing.
  Severity pills are monochrome (severity is not a genuine agent state).

## Hard guardrails (never bend)

1. **Information, never legal advice** — `LEGAL_DISCLAIMER` on every page
   and API response; legal findings carry the confirm-with-professional nudge.
2. **No invented scan results** — v1 findings come from the tenant's
   self-assessment or manual import; the source label is on every finding;
   `hullcheck_engine` imports are rejected until the engine exists.
3. **Licensed partner invariant** — insurance obligations name the licensed
   partner ("they hold the licenses, we provide the software") and never
   present a binding path. Enforced by tests.

---

# Slice 2 layout

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
