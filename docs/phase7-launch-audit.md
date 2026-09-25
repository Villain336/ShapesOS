# F6 launch-readiness audit (2026-09-25)

Machine-readable checks live in `scripts/verify-phase7-launch.mts` (battery:
**green 3×, 142/142**). This report records the methodology, every scan hit with
disposition, PII findings, and the remaining pre-public blockers.

## 1. Secret scan (corrected methodology)

- **History:** `git log --all` — 59 commits, 1 branch (`main`), no tags.
- **Corrected approach:** one broad regex had an invalid character range and
  errors were silenced in the first pass — **that first "zero hits" result was
  invalid and is discarded.** The pattern set was probe-tested against a fake
  Anthropic-shaped key before rerunning; the corrected pass is the one reported
  here.
- **Supplementary pass (2026-09-25):** service-specific sweep across all 59
  commits for DataForSEO / LLM provider keys (`sk-…`, `sk-proj-…`,
  `xox[bap]-`, `ghp_`/`gho_`, `SG.`), AWS (`AKIA…`), Stripe
  (`sk_live_`, `rk_live_`, `whsec_`), Smartlead/Instantly, Brex/Ramp, database
  URLs with credentials, admin passwords, and high-confidence assignments
  (`KEY = "value"`). Result: **no real live credential.**

### Every matched file (disposition: fixture/placeholder)

| Commit range | File | Match | Disposition |
|---|---|---|---|
| history | `app/api/e2e/mock-oauth/token/route.ts` | `"e2e-mock-access-token"`, `"e2e-mock-refresh-token"` | E2E mock route fixtures — not real tokens |
| history | `components/SiteIde.tsx` | textarea placeholder `"-----BEGIN OPENSSH PRIVATE KEY-----"` | UI placeholder text — not a key |
| history | `scripts/verify-llm-routing.mts` | `sk-ant-secret-test-key-AAA111` | Self-describing test value |
| working tree | `scripts/e2e/report/index.html` | embedded/base64 output matching broad patterns | Generated Playwright report output — untracked build artifact, not a live credential |
| history | `Dockerfile` | `ENV DATABASE_URL="postgresql://marketr:marketr@localhost…"` | Throwaway local dev credential (same class as CI service password) — benign |
| history | `.env.example` | `NEXTAUTH_SECRET="change-me-to-a-long-random-string"`, `ADMIN_PASSWORD="CHANGE_ME_min_20_chars"`, `STRIPE_SECRET_KEY=""` | Instructional placeholders, verified by byte inspection |

- **No tracked `.env`, `.pem`, `.key`, `.crt`, or log files** exist in history or
  the working tree (`.gitignore` now also covers `*.key`, `*.crt`, `*.p12`,
  `*.pfx`, `*.log`, `logs/`).
- **Do not scrub history.** Nothing found warrants it; any genuine hit found
  later must be reported, not rewritten.

## 2. PII / demo-data audit (no deletions — per task constraint)

`scripts/seed-demo-phase6.mts` (untracked seed script, referenced by the
`pii-demo-audit` checklist item) contains realistic demo data whose
realism/ownership was **not verified**:

- Names/emails: Maya Chen `maya@triadhomeblog.com` · Devon Park
  `devon@ncremodelingguide.com` · Priya Nair `priya@greensborolivingmag.com` ·
  Tom Alvarez `tom@hvacinsiderweekly.com` · Sara Lindqvist
  `sara@energywisehomes.com`
- Also: `Demo — Triad Home Services` · `412 W Market St, Greensboro, NC 27401` ·
  `(336) 555-0147` · `https://demo-triadhomeservices.com` · reviewer `Angela M.`
- Example-domain emails also present: `priya@example.com`, `marcus@example.com`,
  `denise@example.com`.

Decision needed before public: replace with clearly-fictional seed data or
confirm ownership — tracked as a pending checklist item, not resolved here.

## 3. `.gitignore` / workflow audit

- `.gitignore` now covers `.env*` (with `!.env.example` keep), `*.pem`,
  `*.key`, `*.crt`, `*.p12`, `*.pfx`, `.pgdata/`, `*.log`, `logs/`.
- New `.github/workflows/ci.yml`: typecheck, F6 battery, cred-free smoke,
  secret-scan guardrail (`git grep` with the two known fixture exclusions),
  Prisma fragment presence check. Uses a throwaway local Postgres service
  password; **no `secrets.*` references — nothing private needed.**

## 4. Package license field

- `LICENSE` is byte-identical to the canonical AGPLv3 text (34,523 bytes) —
  verified.
- **`package.json` has no `license` field** (mismatch vs. LICENSE). Left
  unchanged per instruction; tracked as the pending `package-license-field`
  checklist item. The battery reports it as a warning, not a pass/fail.
- Copyright holder still unidentified — pending `copyright-holder` item.

## 5. SBOM flags (`THIRD_PARTY.md`)

- 83 direct dependencies inventoried; no direct GPL-incompatible or proprietary
  dependency.
- `ssh2@^1.17.0` has no `license` field in its package.json (bundled LICENSE
  file is MIT text) — flagged for review.
- Transitive sharp/libvips packages include LGPL-3.0-or-later — AGPL-compatible,
  flagged for review.
- GrowthBook enterprise code prohibited; only MIT OSS core may enter the tree.
- Verdict: **no blockers.**

## 6. Pre-public blockers (all tracked, none resolved here)

1. CLA-vs-DCO **must be decided before public** (staged in CONTRIBUTING.md).
2. `SECURITY.md` / `CODE_OF_CONDUCT.md` contacts are explicit placeholders —
   real private reporting and enforcement addresses needed.
3. `package.json` license field + copyright holder.
4. Open-core split (options A–D) — deferred per SPEC-PHASE7 §12.5; readiness only.
5. PII/demo seed disposition (see §2).
6. Product Hunt playbook is staged, not executed.

## 7. Verification outputs (2026-09-25)

- `npx tsc --noEmit`: **0 errors in the F6 lane** (16 pre-existing errors in
  sibling F1/F3/F4 tracks + `scripts/seed-demo-phase6.mts` — not F6 scope).
- `npx tsx scripts/verify-phase7-launch.mts`: **green 3×, 142/142** (1 expected
  warning: package license field pending).
- `npx tsx scripts/smoke-no-creds.mts`: **green, 21/21** — mock-mode degradation
  is loud (`[llm-router] … → mock`, never silent).
- YAML validation: CI workflow + both issue templates parse.
