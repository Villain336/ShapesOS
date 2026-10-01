# Legal/Compliance — Slice 1: Obligation map

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
