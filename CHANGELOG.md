# Changelog

All notable changes to Marketr are documented here, newest first.
This project follows the release-discipline rules below — the changelog is a
launch-readiness item (Phase 7, F6), not an afterthought.

## Release discipline

- **Every user-visible change gets an entry** under `Unreleased` at PR time — not at
  release time, when it's forgotten.
- **Format:** `### Added|Changed|Fixed|Security` sections, one bullet per change, each
  bullet naming the area and linking the PR/issue (`#123`).
- **Security fixes** get their own section and never include exploit details.
- **Money-safety changes** (approvals, kill switches, SRA, billing) are called out
  explicitly — they are the product's trust surface.
- **Who writes it:** the PR author. Reviewers reject PRs with missing entries.
- **When it ships:** on release, `Unreleased` is renamed to the version + date
  (`## [0.3.0] — 2026-10-01`), and a new empty `Unreleased` section is opened.
- **What's out:** internal refactors with no behavior change, dependency bumps with no
  user impact, and docs-only typo fixes don't need entries (use judgment).

## Unreleased

### Added
- Phase 7 (flywheel) F6: public-launch readiness tracker — `launch_checklist` table,
  `/api/flywheel/launch/checklist` routes, `/dashboard/flywheel/launch` UI, and the
  `scripts/verify-phase7-launch.mts` battery. Readiness only; the open-core split is
  deferred and the repo is not flipped public.
- Launch-readiness community files: `CONTRIBUTING.md` (CLA-or-DCO staged as
  must-decide-before-public), `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue/PR templates,
  `CHANGELOG.md` (this file), `THIRD_PARTY.md` SBOM.
- Launch-readiness docs: `docs/open-core-options.md` (neutral decision brief, no
  recommendation), `docs/product-hunt-playbook.md` (staged), `docs/quickstart.md`
  (<10-minute self-host).
- Credential-free smoke test `scripts/smoke-no-creds.mts` + CI workflow
  (`.github/workflows/ci.yml`) that runs green on a clean clone with no private keys.
- `.env.example` now documents every env var the code reads (placeholders only).

### Fixed
- `.gitignore` now covers `*.key`, `*.crt`, `*.p12`, `*.pfx`, `*.log`, and `logs/`
  (previously only `*.pem` and scattered debug logs).

### Security
- Full-history secret scan (2026-09-25): clean — only test fixtures found
  (E2E mock OAuth tokens, an SSH-key textarea placeholder, a named test API key).
  No rotation or history scrub needed. See the F6 audit notes.
