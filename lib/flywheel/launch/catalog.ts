// Marketr — F6 launch-readiness checklist catalog.
//
// The canonical item list derived from docs/specs/SPEC-PHASE7.md §2/F6 and §10 exit
// gate 9. Rows in the `launch_checklist` table are seeded from this catalog
// (keyed by `key`, idempotent per workspace). Editing a title here does not
// rewrite history — rows denormalize the title at seed time.
//
// The open-core split is DEFERRED by standing decision (§12.5): this catalog
// tracks READINESS only. No public flip is part of this phase.

export type LaunchCategory = "security" | "legal" | "community" | "build";
export type LaunchStatus = "pending" | "in_progress" | "complete";

export interface LaunchChecklistItem {
  key: LaunchCategory extends never ? never : string;
  category: LaunchCategory;
  /** Human-readable item title (denormalized into the DB row at seed). */
  title: string;
  /** What "done" means, concretely. */
  doneWhen: string;
  /** Spec reference (docs/specs/SPEC-PHASE7.md section). */
  specRef: string;
  /** What counts as evidence (commits, docs, CI runs). */
  evidenceHint: string;
}

export const LAUNCH_CATEGORIES: { key: LaunchCategory; title: string; blurb: string }[] = [
  {
    key: "security",
    title: "Security pre-flight",
    blurb: "No secret may ever reach the public history. Audit first, then rotate + scrub any hit before anything else.",
  },
  {
    key: "legal",
    title: "Legal & license",
    blurb: "The AGPLv3 + commercial dual-license story must be airtight before strangers read the code.",
  },
  {
    key: "community",
    title: "Community files",
    blurb: "Strangers need to know how to contribute, report, and behave — and what the CLA/DCO call will be.",
  },
  {
    key: "build",
    title: "Build confidence",
    blurb: "A clean clone must build, pass CI, and run a credential-free smoke test in under ten minutes.",
  },
];

export const LAUNCH_CHECKLIST_CATALOG: LaunchChecklistItem[] = [
  // ------------------------------------------------------------------
  // Security
  // ------------------------------------------------------------------
  {
    key: "secret-history-scan",
    category: "security",
    title: "Full-history secret scan clean",
    doneWhen:
      "Every commit on every branch scanned for key/token/private-key/password patterns; zero real secrets found. " +
      "Any hit → rotate the secret AND scrub history (BFG/git-filter-repo) before any public push — you cannot un-leak.",
    specRef: "§2/F6 (Security pre-flight), §10 gate 9",
    evidenceHint: "Scan script + results log (commit + file for every hit, or explicit clean report).",
  },
  {
    key: "gitignore-audit",
    category: "security",
    title: ".gitignore + workflow audit",
    doneWhen:
      ".gitignore covers .env*, *.pem, *.key, pgdata, logs; no CI/workflow file references anything but secrets.*.",
    specRef: "§2/F6 (Security pre-flight)",
    evidenceHint: ".gitignore diff; workflow grep for hardcoded values.",
  },
  {
    key: "pii-demo-audit",
    category: "security",
    title: "PII + demo-data audit",
    doneWhen:
      "Seeds and fixtures grepped for real emails, names, phone numbers, client data. " +
      "Hits triaged: demo data stays (flagged), real PII removed. No real client data ships in fixtures.",
    specRef: "§2/F6 (Security pre-flight)",
    evidenceHint: "Audit report listing every hit and its disposition (keep-flagged / removed).",
  },
  // ------------------------------------------------------------------
  // Legal
  // ------------------------------------------------------------------
  {
    key: "license-file",
    category: "legal",
    title: "Canonical AGPLv3 LICENSE at root",
    doneWhen: "LICENSE is the canonical, unmodified AGPLv3 text (byte-identical to the FSF canonical copy).",
    specRef: "§2/F6 (Legal & license)",
    evidenceHint: "Diff of LICENSE against https://www.gnu.org/licenses/agpl-3.0.txt.",
  },
  {
    key: "package-license-field",
    category: "legal",
    title: "package.json license field matches",
    doneWhen: 'package.json declares "license": "AGPL-3.0-only" (SPDX), matching the LICENSE file.',
    specRef: "§2/F6 (Legal & license)",
    evidenceHint: "package.json diff.",
  },
  {
    key: "copyright-holder",
    category: "legal",
    title: "Copyright holder identified",
    doneWhen:
      "The copyright holder (entity/person) is named — required for the commercial re-licensing path. " +
      "Decided explicitly; \"TBD\" is not done.",
    specRef: "§2/F6 (Legal & license)",
    evidenceHint: "Decision record (who holds copyright for re-licensing).",
  },
  {
    key: "sbom-audit",
    category: "legal",
    title: "THIRD_PARTY/SBOM license audit",
    doneWhen:
      "Every dependency listed with its license; anything GPL-incompatible or proprietary flagged. " +
      "No GPL-incompatible or proprietary dependency may poison the AGPLv3 dual-license story.",
    specRef: "§2/F6 (Legal & license)",
    evidenceHint: "THIRD_PARTY.md with per-dependency licenses + flags.",
  },
  {
    key: "trademark-note",
    category: "legal",
    title: "Trademark / AGPLv3 §7 branding note staged",
    doneWhen:
      "Decision brief staged on protecting the \"ShapesOS\" brand via AGPLv3 §7 additional permissions " +
      "(the OnlyOffice 2026 \"Logo Trap\" precedent): white-label boundary without touching the license grant. " +
      "Decision itself deferred with the open-core split.",
    specRef: "§2/F6 (Legal & license), §12.5",
    evidenceHint: "docs/open-core-options.md §trademark.",
  },
  {
    key: "commercial-terms",
    category: "legal",
    title: "Commercial license terms page drafted",
    doneWhen:
      "The commercial white-label license terms are drafted so the public repo never reads as a trap " +
      "(Plausible-style: what open covers vs what commercial covers).",
    specRef: "§2/F6 (Legal & license)",
    evidenceHint: "Draft terms page (docs/ or site copy).",
  },
  // ------------------------------------------------------------------
  // Community
  // ------------------------------------------------------------------
  {
    key: "contributing",
    category: "community",
    title: "CONTRIBUTING.md with CLA-or-DCO + boundary",
    doneWhen:
      "CONTRIBUTING.md ships PR guidelines, dev setup, and verification steps; the CLA-vs-DCO call is " +
      "STAGED as must-decide-before-public (dual-license needs re-licensing rights or a " +
      "company-authored-commercial-code policy); the open-vs-commercial feature boundary is published " +
      "(the authentik lesson) — with the split itself marked undecided.",
    specRef: "§2/F6 (Community files)",
    evidenceHint: "CONTRIBUTING.md at root.",
  },
  {
    key: "security-md",
    category: "community",
    title: "SECURITY.md",
    doneWhen: "SECURITY.md names a private reporting channel, a response SLA, and the scope (in/out).",
    specRef: "§2/F6 (Community files)",
    evidenceHint: "SECURITY.md at root.",
  },
  {
    key: "code-of-conduct",
    category: "community",
    title: "CODE_OF_CONDUCT.md",
    doneWhen: "Code of conduct present (Contributor Covenant or equivalent), with enforcement contact.",
    specRef: "§2/F6 (Community files)",
    evidenceHint: "CODE_OF_CONDUCT.md at root.",
  },
  {
    key: "issue-pr-templates",
    category: "community",
    title: "Issue + PR templates",
    doneWhen: "Bug/feature issue templates and a PR template exist and ask for the verification steps.",
    specRef: "§2/F6 (Community files)",
    evidenceHint: ".github/ISSUE_TEMPLATE/* + .github/pull_request_template.md.",
  },
  {
    key: "changelog-discipline",
    category: "community",
    title: "CHANGELOG / release discipline",
    doneWhen: "CHANGELOG.md exists with the release-discipline rules (what gets an entry, who writes it, when).",
    specRef: "§2/F6 (Community files)",
    evidenceHint: "CHANGELOG.md at root.",
  },
  {
    key: "env-example",
    category: "community",
    title: ".env.example complete (placeholders only)",
    doneWhen:
      ".env.example documents every env var the code reads, with placeholder values only — never real values. " +
      "A stranger can configure the app from this file alone.",
    specRef: "§2/F6 (Community files)",
    evidenceHint: ".env.example diff vs process.env inventory.",
  },
  // ------------------------------------------------------------------
  // Build
  // ------------------------------------------------------------------
  {
    key: "ci-clean-clone",
    category: "build",
    title: "CI green on clean clone",
    doneWhen:
      "CI (typecheck, lint, verify batteries, production build) passes on a fresh clone with no local state. " +
      "No step may require private credentials.",
    specRef: "§2/F6 (Build confidence), §10 gate 9",
    evidenceHint: "CI workflow file + green run on a clean checkout.",
  },
  {
    key: "smoke-no-creds",
    category: "build",
    title: "Credential-free E2E smoke test",
    doneWhen:
      "A smoke test passes with zero private credentials (mock mode / graceful skips for provider-backed paths). " +
      "Skips are explicit, never silent.",
    specRef: "§2/F6 (Build confidence), §10 gate 9",
    evidenceHint: "Smoke script + passing run with an empty env (minus DATABASE_URL).",
  },
  {
    key: "quickstart",
    category: "build",
    title: "<10-minute self-host quickstart",
    doneWhen:
      "docs/quickstart.md takes a stranger from zero to a running instance in under ten minutes " +
      "(clone → env → db → dev). Timed end-to-end at least once.",
    specRef: "§2/F6 (Build confidence), §10 gate 9",
    evidenceHint: "docs/quickstart.md + timed run notes.",
  },
  {
    key: "readme-bar",
    category: "build",
    title: "README/docs bar",
    doneWhen:
      "README has the one-line tagline + 3-bullet what-it-does + hero screenshot + badges above the fold; " +
      "a clear open-vs-commercial table (Plausible-style); docs site covers install, config, architecture, " +
      "API reference, licensing; 3–5 real-UI screenshots; a public roadmap file.",
    specRef: "§2/F6 (README/docs bar)",
    evidenceHint: "README.md + docs/ + roadmap file.",
  },
  {
    key: "ph-playbook",
    category: "build",
    title: "Product Hunt playbook staged",
    doneWhen:
      "docs/product-hunt-playbook.md stages the 12:01 AM PT Tuesday launch, 14-day prep timeline, " +
      "never-solicit-upvotes rule, and the ~450–600 upvote target band. Staged, not executed.",
    specRef: "§2/F6 (Product Hunt playbook staged)",
    evidenceHint: "docs/product-hunt-playbook.md.",
  },
  {
    key: "open-core-brief",
    category: "build",
    title: "Open-core options map as decision brief",
    doneWhen:
      "docs/open-core-options.md presents the four options (A: open everything, B: AGPL core + closed " +
      "enterprise pack, C: three-layer, D: AGPL everything + cloud premium) with tradeoffs and NO " +
      "recommendation. The split itself is explicitly undecided.",
    specRef: "§2/F6, §12.5",
    evidenceHint: "docs/open-core-options.md.",
  },
];

export function catalogKeys(): string[] {
  return LAUNCH_CHECKLIST_CATALOG.map((i) => i.key);
}

export function catalogByCategory(category: LaunchCategory): LaunchChecklistItem[] {
  return LAUNCH_CHECKLIST_CATALOG.filter((i) => i.category === category);
}

/** Spec §12.5: the split is deferred — readiness only, no flip. */
export const OPEN_CORE_SPLIT_DECIDED = false;
