# Contributing to Marketr

Thanks for considering a contribution. Marketr is an open-source marketing & SEO workspace
(AGPLv3), with a commercial white-label license for agencies. This document tells you how to
contribute, what the verification bar is, and where the open-vs-commercial boundary sits.

> **Status note (2026-09-25):** the open-core split is **deferred — undecided**. The repo is in
> launch-*readiness*, not launched. Nothing below flips the repo public; the boundary section
> describes the intended shape so contributors don't build the wrong thing while the decision
> is pending.

## Ground rules

1. **The vault rule:** venture plans, research, and anything under `research/` marked private
   stays private. Don't publish or reference private material in issues, PRs, or commits.
2. **Spec-first:** features start from an approved spec (`SPEC-*.md`). If no spec exists for your
   change, open an issue first and get alignment before coding.
3. **Money is a red lane:** anything touching spend, billing, or payouts needs explicit human
   approval in the design — autopilot never buys. See `docs/MASTER-PLAN.md` §3.1.
4. **Verify before you claim:** every PR must show its verification evidence (see below). A PR
   that says "tests pass" without the output gets sent back.

## Dev setup

```bash
git clone <repo-url> && cd marketr
cp .env.example .env        # fill in: DATABASE_URL at minimum
npm ci
npx prisma migrate dev     # or: npx prisma db push (dev only)
npm run dev                # http://localhost:3000
```

Self-host quickstart (clean machine, <10 min): `docs/quickstart.md`.

## Verification steps (required on every PR)

1. `npx tsc --noEmit` — must be clean.
2. `npm run build` — production build must be green.
3. Run the verification battery for the module you touched:
   `npx tsx scripts/verify-<module>.mts` (batteries live in `scripts/`; most are pure-logic,
   no DB/network).
4. If you touched a security surface, run `node scripts/verify-m11-security.mjs` too.
5. Paste the outputs in the PR description (the PR template has a checklist).

New modules ship with their own `scripts/verify-*.mts` battery — a feature without a battery
is not done.

## PR guidelines

- One concern per PR. Keep diffs reviewable (<~500 lines unless it's generated code).
- Follow the existing module conventions: `lib/<area>/*` for logic, `app/api/<area>/*` for
  routes (guard with the area's `_lib.ts`), `app/dashboard/<area>/*` for UI, prisma fragments
  in `prisma/fragments/` (never edit `prisma/schema.prisma` directly — the coordinator merges).
- No secrets, credentials, or real PII in code, fixtures, or seeds. Demo data must be
  obviously fake (example.com emails, 555-01XX numbers, "Demo —" prefixes).
- UI: Lucide icons only, no emoji UI. Follow the component libraries in
  `~/workspace/design-vault` conventions already in the tree (`components/vault/`).
- Commits: conventional prefixes (`feat`, `fix`, `docs`, `chore`, `test`). Local git only —
  never push without explicit approval.

## CLA or DCO — must be decided before public

> ⚠️ **STAGED DECISION — not made.** Marketr is planned as AGPLv3 **plus** a commercial
> white-label license. That dual-license story requires ONE of the following before the repo
> goes public:
>
> - **A Contributor License Agreement (CLA)** granting the project re-licensing rights, or
> - **A Developer Certificate of Origin (DCO)** policy **plus** a rule that commercial-only
>   code is company-authored (no outside contributions accepted into the commercial layer).
>
> Until this is decided, external contributions are accepted **into the open codebase only**,
> under AGPLv3, and the decision is tracked as a launch-readiness item. Do not assume either
> outcome in your contribution.

By contributing now, you agree your contribution is licensed under the project's open license
(AGPLv3) — see `LICENSE`.

## Open-vs-commercial boundary (intended shape — split undecided)

The open tier must be a **complete product**, not a crippled demo. The intended boundary
(when the split is decided) follows the proven open-core shape:

| Open (AGPLv3) | Intended commercial |
|---|---|
| Full marketing OS: keyword research, competitor gap, content engine, retention loops | White-label sub-accounts & client-facing branding removal |
| Fix agent (supervised → scheduled → autopilot trust ladder) | SSO/SAML, RBAC governance, audit exports |
| Self-hosted adapters (BYO keys/seats) | Managed/hosted keys, premium integrations, compliance artifacts |
| Community connectors | Priority support & SLAs |

**Do not build commercial-layer features** (white-label removal, SSO/RBAC gating, license
enforcement) unless a spec explicitly asks for them — that work waits for the split decision.
If you're unsure which side your idea falls on, ask in the issue first (the authentik lesson:
publish the boundary *before* people code).

## Reporting security issues

Do **not** open a public issue for security problems. See `SECURITY.md`.

## Code of conduct

Behave like an adult. The full text is in `CODE_OF_CONDUCT.md`; violations go to the
contact listed there.
