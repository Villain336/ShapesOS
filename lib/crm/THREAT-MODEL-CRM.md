# THREAT MODEL — Lead Pipeline CRM (Phase 1, R1)

**Date:** 2026-09-24 · **Author:** Z7 (subagent) · **Scope:** `lib/crm/`,
`app/api/crm/`, `app/dashboard/crm/`, `scripts/verify-crm.mts`.

The CRM is a multi-tenant boundary: leads are the agency's and the client's
most sensitive PII (names, emails, phones, deal values). A CRM bug is a
tenant-isolation bug. The threat model leads the build; the adversarial
battery (`scripts/verify-crm.mts`) must cover every abuse case below.

## Trust boundaries

- **The DB row is the authorization boundary.** Every query is scoped by
  `workspaceId` derived server-side from the session (`getOrCreateWorkspace`);
  a row from another workspace is indistinguishable from a nonexistent row
  (404 both ways, no existence oracle).
- **The public capture endpoint is unauthenticated by design** — the
  unguessable form token (`mkfrm_<32 hex>`, 128-bit entropy) is the
  capability. Tokens are stored only as SHA-256 hashes; the raw token is
  shown once at creation and never again.
- **The CRM never moves money.** `crm_active_leads` is a usage *dimension*
  (read-only count, `lib/crm/meter.ts`), not a credit action — it must never
  call `meter()` or appear on the billing ledger as a charge.

## Abuse cases

### 1. Cross-workspace IDOR (lead/pipeline/form IDs)

- **Attack:** user in workspace A requests lead/pipeline/form `id` belonging
  to workspace B; or passes a B pipelineId/clientId/projectId when creating
  a lead in A.
- **Mitigation:** every route re-queries with `where: { id, workspaceId }`.
  Foreign-key references supplied by the client (pipelineId, clientId,
  projectId, formId) are re-fetched with the caller's workspaceId and rejected
  (404) on mismatch — never trusted from the request alone.
- **Residual:** none accepted; the battery asserts cross-workspace read,
  write, pipeline-association, client-association, and form-token access all
  fail.

### 2. Public capture-form abuse

- **Attack:** token guessed/enumerated, form spam-flooded, bot submissions,
  oversized payloads, XSS payloads in lead fields, lead-ID probing via
  duplicate responses.
- **Mitigation:**
  - 128-bit unguessable tokens; **disabled or unknown tokens return 404**
    (no existence oracle beyond the token itself, which is the capability);
  - per-token+IP in-memory rate limit (10 submissions/min) — a single-instance
    assumption; multi-instance deployments must move this to a shared store
    (documented, not yet done);
  - honeypot field `website` — submissions with it set are accepted silently
    and discarded (bot learns nothing);
  - 2 KB body limit; Zod validation (email format, phone length, message
    length);
  - dedup-checked insert — a repeat submit returns the same generic
    `{ ok: true }` acknowledgment **without revealing lead IDs or any
    existing-lead data**;
  - the config GET exposes only name/redirectUrl, never internal IDs.
- **Residual:** honeypots are a speed bump, not a wall — sophisticated bots
  ignore them; rate limiting is per-token+IP, so distributed spam from many
  IPs is only slowed. Accepted for v1; form owners can disable the form
  (token revoked instantly) on abuse.

### 3. CSV import abuse

- **Attack:** 2 GB upload, million-row CSV (DoS), formula injection
  (`=cmd|'/c calc'!A0`) into exported CSVs, malformed rows crashing the parser,
  importing into another workspace's pipeline.
- **Mitigation:** 2 MB body cap, 5,000-row cap, per-row validation with
  row-indexed errors, dedup-aware (duplicates reported, not inserted),
  pipeline re-scoped to the caller's workspace before import.
- **Residual:** formula injection — cell values beginning with `=`, `+`, `-`,
  `@` are written as-is into the export CSV. Accepted for v1; export is
  tenant-scoped and downloads are trusted-user actions. Flagged for a future
  hardening pass (prefix-with-quote or strip on export).

### 4. Dedup races

- **Attack/condition:** two concurrent inserts with the same normalized
  email/phone.
- **Mitigation:** dedup is a DB uniqueness constraint on
  `[workspaceId, dedupKey]` (not just an app-level precheck). The API returns
  409 on `P2002`; the race loser gets the duplicate response. Key
  normalization: lowercase+trim for email, digit-stripping for phone.
- **Residual:** closed (won/lost) leads — the precheck deliberately allows a
  new lead matching a closed lead's contact (re-engagement), but the unique
  constraint still rejects it at the DB layer with a 409. Behavior is
  explicit: same dedupKey is unique per workspace regardless of stage. The
  API precheck and the constraint are aligned (both reject), so no silent
  inconsistency — documented as a known product decision, not a bug.

### 5. Stage-machine integrity

- **Attack:** client submits a stage ID that doesn't exist, or removes a
  stage that leads still occupy (orphaning them).
- **Mitigation:** every stage write is validated against the pipeline's
  parsed stage list (unknown stage → 400). Pipeline stage removal is blocked
  with 409 while any lead occupies the removed stage. Stage changes write a
  `stage_change` activity row (audit trail).
- **Residual:** no optimistic-concurrency guard on concurrent stage moves —
  last write wins, both are logged. Accepted for v1 (human-scale CRM).

### 6. Score gaming / non-determinism

- **Attack:** caller tries to set `score` directly via the API.
- **Mitigation:** `score` is server-computed only (create/PATCH/activity
  recompute via `recomputeScore`); no route accepts a client score. Rules are
  deterministic (scoring v1 in `lib/crm/stages.ts`) so the same inputs always
  produce the same score — the battery asserts this.

### 7. Data export exfiltration

- **Attack:** export endpoint used to bulk-exfiltrate another tenant's leads.
- **Mitigation:** export is tenant-scoped (same `workspaceId` filter as the
  list), capped at 10,000 rows, requires an authenticated workspace role,
  and honors the active filter set (no wider than what the UI shows).
- **Residual:** an authenticated workspace member can export all leads —
  that is by design (their data). Cross-workspace export is the battery case.

## Scoring rules v1 (deterministic)

Base by source: referral 50 · phone 45 · website_form 40 · ad/direct_mail 30 ·
ooh 25 · import/other 20. Completeness: +10 email · +10 phone · +5 company.
Recency: +15 activity in 7d · +8 activity in 30d. Engagement: +2 per
qualifying activity, capped at +10. Clamped 0–100. Bands: cold <40, warm
40–69, hot 70+. Rules live in `scoreFor()` (`lib/crm/stages.ts`); the API
never accepts a client-supplied score.
