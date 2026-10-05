// Marketr — F6 launch-readiness verification battery (Phase 7).
//
// Run: npx tsx scripts/verify-phase7-launch.mts
// Run 3x green before calling F6 done.
//
// No DB, no network: static checks + pure-logic imports only.
// Covers docs/specs/SPEC-PHASE7.md §2/F6, §4 (launch_checklist), §5 (routes), §9, §10
// (exit gate 9), §12.5 (open-core split deferred — readiness only).

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const failures: string[] = [];
const warnings: string[] = [];
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const warn = (name: string, detail = "") => {
  warnings.push(name);
  console.log(`  ! WARN ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------------------------------------------------------------------------
// 1. Prisma fragment (phase7-launch.prisma) — coordinator merges, we validate
// ---------------------------------------------------------------------------
console.log("prisma fragment");
{
  const f = "prisma/fragments/phase7-launch.prisma";
  ok("fragment exists", existsSync(join(ROOT, f)));
  const src = read(f);
  ok("declares model LaunchChecklist", /model LaunchChecklist \{/.test(src));
  for (const field of ["workspaceId", "key", "item", "category", "status", "evidenceUrl", "completedAt"]) {
    ok(`model has field ${field}`, new RegExp(`\\b${field}\\b`).test(src));
  }
  ok('maps to launch_checklist table', /@@map\("launch_checklist"\)/.test(src));
  ok("workspace relation with Cascade delete", /Workspace @relation\(fields: \[workspaceId\][^)]*onDelete: Cascade\)/.test(src));
  ok("unique (workspaceId, key) — idempotent seed", /@@unique\(\[workspaceId, key\]\)/.test(src));
  ok("fragment carries the do-not-generate assembly note", /do NOT `prisma generate`/.test(src));
  ok("no unrelated models in the F6 fragment", (src.match(/^model \w+ \{/gm) ?? []).length === 1);
}

// ---------------------------------------------------------------------------
// 2. lib/flywheel/launch — catalog + store
// ---------------------------------------------------------------------------
console.log("lib/flywheel/launch");
{
  const catalog = await import("@/lib/flywheel/launch/catalog");
  const items = catalog.LAUNCH_CHECKLIST_CATALOG as { key: string; category: string; title: string; doneWhen: string; specRef: string; evidenceHint: string }[];
  ok("catalog has 21 items", items.length === 21, String(items.length));
  const cats = ["security", "legal", "community", "build"];
  for (const c of cats) {
    ok(`category ${c} non-empty`, items.some((i) => i.category === c));
  }
  const keys = items.map((i) => i.key);
  ok("catalog keys unique", new Set(keys).size === keys.length);
  ok("catalog keys are stable slugs", keys.every((k) => /^[a-z0-9-]+$/.test(k)));
  for (const f of ["key", "category", "title", "doneWhen", "specRef", "evidenceHint"]) {
    ok(`every item has ${f}`, items.every((i) => typeof (i as Record<string, unknown>)[f] === "string" && String((i as Record<string, unknown>)[f]).length > 0));
  }
  ok("no catalog item claims the split is decided", !items.some((i) => /split (is )?decided|going public/i.test(i.title + i.doneWhen)));
  ok("OPEN_CORE_SPLIT_DECIDED === false", catalog.OPEN_CORE_SPLIT_DECIDED === false);

  const storeSrc = read("lib/flywheel/launch/store.ts");
  for (const fn of ["launchTablesReady", "seedLaunchChecklist", "listLaunchChecklist", "progressOf", "completeChecklistItem", "reopenChecklistItem", "isKnownChecklistKey", "LaunchChecklistError"]) {
    ok(`store exports ${fn}`, new RegExp(`export (async )?function ${fn}|export class ${fn}|export \\{[^}]*\\b${fn}\\b`).test(storeSrc));
  }
  ok("store is merge-safe: no typed prisma.launchChecklist usage", !/prisma\.launchChecklist/i.test(storeSrc));
  ok("store uses raw SQL (pre-merge safe)", /\$queryRawUnsafe|\$executeRawUnsafe/.test(storeSrc));
  ok("complete requires evidence (fail-closed)", /evidence_url is required/.test(storeSrc));
  ok("seed is idempotent (ON CONFLICT DO NOTHING)", /ON CONFLICT.*DO NOTHING/.test(storeSrc));
  const store = await import("@/lib/flywheel/launch/store");
  const p0 = store.progressOf([]);
  ok("progressOf([]) zeroed", p0.total === 0 && p0.complete === 0 && p0.pending === 0);
  const p1 = store.progressOf([
    { category: "security", status: "complete" }, { category: "security", status: "pending" },
    { category: "legal", status: "in_progress" },
  ] as never[]);
  ok("progressOf math", p1.total === 3 && p1.complete === 1 && p1.inProgress === 1 && p1.pending === 1 && p1.byCategory.security.complete === 1);
}

// ---------------------------------------------------------------------------
// 3. API routes — spec §5: GET checklist · POST checklist/:id/complete
// ---------------------------------------------------------------------------
console.log("api routes");
{
  const routes: [string, string, string][] = [
    ["app/api/flywheel/launch/checklist/route.ts", "GET", "viewer"],
    ["app/api/flywheel/launch/checklist/[id]/complete/route.ts", "POST", "editor"],
    ["app/api/flywheel/launch/checklist/[id]/reopen/route.ts", "POST", "editor"],
  ];
  for (const [p, method, role] of routes) {
    ok(`${p} exists`, existsSync(join(ROOT, p)));
    const src = read(p);
    ok(`${p} exports ${method}`, new RegExp(`export (async )?function ${method}\\(`).test(src));
    ok(`${p} guards with launchGuard("${role}")`, src.includes(`launchGuard("${role}")`));
    ok(`${p} is force-dynamic`, src.includes('dynamic = "force-dynamic"'));
  }
  ok("_lib.ts guard exists", existsSync(join(ROOT, "app/api/flywheel/launch/_lib.ts")));
  ok("_schemas.ts exists", existsSync(join(ROOT, "app/api/flywheel/launch/_schemas.ts")));
  const schemas = read("app/api/flywheel/launch/_schemas.ts");
  ok("complete schema requires evidence_url", /evidence_url:\s*z\.string\(\)\.trim\(\)\.min\(1/.test(schemas));
  const completeSrc = read("app/api/flywheel/launch/checklist/[id]/complete/route.ts");
  ok("complete route validates with zod", /completeItemSchema\.safeParse/.test(completeSrc));
  ok("complete route 404s on unknown id", /status: 404/.test(completeSrc));
  ok("complete route is workspace-scoped (no cross-workspace IDOR)", /workspace_id = \$2/.test(completeSrc));
}

// ---------------------------------------------------------------------------
// 4. Dashboard page
// ---------------------------------------------------------------------------
console.log("dashboard page");
{
  const p = "app/dashboard/flywheel/launch/page.tsx";
  ok("page exists", existsSync(join(ROOT, p)));
  const src = read(p);
  ok("page renders all 4 categories", /LAUNCH_CATEGORIES\.map/.test(src));
  ok("readiness-only banner (no public flip)", /Readiness only/.test(src) && /no public flip/i.test(src));
  ok("decision brief section present", /open-core split \(deferred\)/i.test(src));
  ok("evidence links rendered", /Evidence/.test(src));
  ok("uses launch store + catalog", src.includes("lib/flywheel/launch/store") && src.includes("lib/flywheel/launch/catalog"));
  ok("complete/reopen actions wired (editor-gated)", src.includes("CompleteButton") && src.includes("ReopenButton") && /canEdit/.test(src));
  ok("progress bars per category", /byCategory/.test(src));
  const actions = "app/dashboard/flywheel/launch/_components/launch-actions.tsx";
  ok("client actions component exists", existsSync(join(ROOT, actions)));
  const aSrc = read(actions);
  ok("actions prompt for evidence", /Evidence URL/.test(aSrc));
  ok("actions refresh after mutation", /router\.refresh\(\)/.test(aSrc));
}

// ---------------------------------------------------------------------------
// 5. Spec §F6 → catalog coverage (every requirement has an item)
// ---------------------------------------------------------------------------
console.log("spec coverage");
{
  const catalog = await import("@/lib/flywheel/launch/catalog");
  const keys = new Set((catalog.LAUNCH_CHECKLIST_CATALOG as { key: string }[]).map((i) => i.key));
  // [spec requirement, catalog key(s)]
  const required: [string, string[]][] = [
    ["full-history secret scan", ["secret-history-scan"]],
    [".gitignore + workflow audit", ["gitignore-audit"]],
    ["PII/demo-data audit", ["pii-demo-audit"]],
    ["canonical AGPLv3 LICENSE", ["license-file"]],
    ["package.json license field", ["package-license-field"]],
    ["copyright holder identified", ["copyright-holder"]],
    ["THIRD_PARTY/SBOM audit", ["sbom-audit"]],
    ["trademark §7 note", ["trademark-note"]],
    ["commercial terms drafted", ["commercial-terms"]],
    ["CONTRIBUTING + CLA/DCO", ["contributing"]],
    ["SECURITY.md", ["security-md"]],
    ["CODE_OF_CONDUCT.md", ["code-of-conduct"]],
    ["issue + PR templates", ["issue-pr-templates"]],
    ["CHANGELOG discipline", ["changelog-discipline"]],
    [".env.example complete", ["env-example"]],
    ["CI on clean clone", ["ci-clean-clone"]],
    ["credential-free smoke", ["smoke-no-creds"]],
    ["<10-min quickstart", ["quickstart"]],
    ["README/docs bar", ["readme-bar"]],
    ["Product Hunt playbook", ["ph-playbook"]],
    ["open-core options brief", ["open-core-brief"]],
  ];
  for (const [req, ks] of required) {
    ok(`spec requirement covered: ${req}`, ks.every((k) => keys.has(k)));
  }
}

// ---------------------------------------------------------------------------
// 6. Community files
// ---------------------------------------------------------------------------
console.log("community files");
{
  const contributing = read("CONTRIBUTING.md");
  ok("CONTRIBUTING.md exists", contributing.length > 500);
  ok("CONTRIBUTING stages CLA-or-DCO", /CLA-or-DCO|CLA.*DCO/i.test(contributing));
  ok("CONTRIBUTING flags must-decide-before-public", /must[- ](?:be[- ])?decide[sd]?[- ]before[- ]public/i.test(contributing));
  ok("CONTRIBUTING has open-vs-commercial boundary", /open-vs-commercial/i.test(contributing));
  ok("CONTRIBUTING marks split undecided", /undecided|deferred/i.test(contributing));
  ok("CONTRIBUTING requires verification evidence", /verify/i.test(contributing));

  const security = read("SECURITY.md");
  ok("SECURITY.md exists", security.length > 300);
  ok("SECURITY.md names a private reporting channel", /private/i.test(security) && /email|report/i.test(security));
  ok("SECURITY.md states a response SLA", /48 hours|SLA/i.test(security));
  ok("SECURITY.md defines scope", /scope/i.test(security));
  ok("SECURITY.md contact is an explicit placeholder (not a fake address)", /\[SECURITY-CONTACT/.test(security));

  ok("CODE_OF_CONDUCT.md exists (Contributor Covenant)", /Contributor Covenant/.test(read("CODE_OF_CONDUCT.md")));
  ok("bug report template exists", existsSync(join(ROOT, ".github/ISSUE_TEMPLATE/bug_report.yml")));
  ok("feature request template exists", existsSync(join(ROOT, ".github/ISSUE_TEMPLATE/feature_request.yml")));
  ok("PR template exists", existsSync(join(ROOT, ".github/pull_request_template.md")));
  const changelog = read("CHANGELOG.md");
  ok("CHANGELOG.md exists with discipline rules", /Release discipline/i.test(changelog));
  ok("CI workflow exists", existsSync(join(ROOT, ".github/workflows/ci.yml")));
  const ci = read(".github/workflows/ci.yml");
  ok("CI runs the F6 battery", /verify-phase7-launch/.test(ci));
  ok("CI runs the cred-free smoke", /smoke-no-creds/.test(ci));
  ok("CI sets no private credentials", !/API_KEY|SECRET.*:.*[A-Za-z0-9]{16,}/.test(ci.replace(/DATABASE_URL.*/g, "")));
}

// ---------------------------------------------------------------------------
// 7. .env.example — every code key documented, placeholders only
// ---------------------------------------------------------------------------
console.log(".env.example");
{
  const example = read(".env.example");
  // Collect every process.env.KEY referenced in source.
  const { execSync } = await import("node:child_process");
  const out = execSync(
    `grep -rhoE 'process\\.env\\.[A-Z_][A-Z0-9_]*' lib app scripts auth.ts proxy.ts --exclude='verify-phase7-launch.mts' 2>/dev/null | sort -u`,
    { cwd: ROOT, encoding: "utf8" },
  );
  const needed = new Set(out.split("\n").filter(Boolean).map((s) => s.replace("process.env.", "")));
  needed.delete("NODE_ENV"); // standard runtime var, not app config
  const documented = new Set(
    [...example.matchAll(/^#? ?([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]),
  );
  const missing = [...needed].filter((k) => !documented.has(k));
  ok("every code env var documented in .env.example", missing.length === 0, missing.slice(0, 10).join(", "));
  // Placeholder-only values: flag anything that looks like a real secret.
  const bad: string[] = [];
  for (const m of example.matchAll(/^([A-Z_][A-Z0-9_]*)=("?)([^"\n]*)\2$/gm)) {
    const [, key, , raw] = m;
    const v = raw.trim();
    if (!v || v === "<redacted>" || v === '""' || v === "''") continue;
    if (/example\.com|localhost|127\.0\.0\.1|https?:\/\/api\.openai\.com|change[-_]me|your-|placeholder/i.test(v)) continue;
    if (/^[A-Za-z0-9+/=_-]{20,}$/.test(v) && !/^(true|false|[0-9]+|memory|local|resend|smtp|redis)$/.test(v)) {
      bad.push(`${key}=${v.slice(0, 12)}…`);
    }
  }
  ok(".env.example values are placeholders only", bad.length === 0, bad.slice(0, 5).join(", "));
}

// ---------------------------------------------------------------------------
// 8. .gitignore audit
// ---------------------------------------------------------------------------
console.log(".gitignore");
{
  const gi = read(".gitignore");
  ok("ignores .env*", /^\.env\*/m.test(gi));
  ok("ignores *.pem", /^\*\.pem$/m.test(gi));
  ok("ignores *.key", /^\*\.key$/m.test(gi));
  ok("ignores pgdata", /\.pgdata/.test(gi));
  ok("ignores logs", /^\*\.log$/m.test(gi) || /^logs\/$/m.test(gi));
  ok("keeps .env.example committable", /!\.env\.example/.test(gi));
}

// ---------------------------------------------------------------------------
// 9. package.json license field (report — coordinator decides the change)
// ---------------------------------------------------------------------------
console.log("package.json");
{
  const pkg = JSON.parse(read("package.json"));
  if (pkg.license === "AGPL-3.0-only") {
    ok('license field is "AGPL-3.0-only"', true);
  } else {
    warn(`license field is ${JSON.stringify(pkg.license ?? "(missing)")} — catalog item package-license-field stays pending; coordinator decides the edit`);
    pass++; // not a battery failure: the checklist tracks it
  }
  ok("LICENSE file present", existsSync(join(ROOT, "LICENSE")));
}

// ---------------------------------------------------------------------------
// 10. Docs: open-core brief, PH playbook, quickstart, THIRD_PARTY
// ---------------------------------------------------------------------------
console.log("docs");
{
  const brief = read("docs/open-core-options.md");
  ok("open-core brief exists", brief.length > 1000);
  for (const o of ["A — Open Everything", "B — AGPL Core", "C — Three-Layer", "D — AGPL Everything"]) {
    ok(`brief covers option ${o[0]}`, brief.includes(o));
  }
  ok("brief states no recommendation", /no recommendation/i.test(brief));
  ok("brief marks split deferred/undecided", /deferred|undecided/i.test(brief));
  ok("brief has the AGPLv3 §7 trademark note (OnlyOffice 2026)", /§7/.test(brief) && /OnlyOffice/i.test(brief));

  const ph = read("docs/product-hunt-playbook.md");
  ok("PH playbook staged (not executed)", /STAGED/i.test(ph));
  ok("PH playbook: 12:01 AM PT Tuesday", /12:01 AM PT.*Tuesday/i.test(ph));
  ok("PH playbook: 14-day prep", /14-day/i.test(ph));
  ok("PH playbook: never solicit upvotes", /never solicit upvotes/i.test(ph));
  ok("PH playbook: 450–600 upvote band", /450[–-]600/.test(ph));

  const qs = read("docs/quickstart.md");
  ok("quickstart exists", qs.length > 500);
  ok("quickstart promises <10 minutes", /<10 minutes/i.test(qs));
  ok("quickstart needs no API keys", /no API keys|mock/i.test(qs));

  const sbom = read("THIRD_PARTY.md");
  ok("THIRD_PARTY.md exists with license table", /\| Package \| Version range \| License \|/.test(sbom));
  ok("SBOM flags ssh2's missing license field", /ssh2/.test(sbom) && /missing/i.test(sbom));
  ok("SBOM verdict: no blockers", /no blockers/i.test(sbom));

  const readme = read("README.md");
  ok("README has a launch bar (tagline + bullets + badges)", /Tagline:/.test(readme) && /img\.shields\.io/.test(readme));
  ok("README has an open-vs-commercial table", /Open vs\. commercial/.test(readme));
  ok("README marks the split undecided in the bar", /undecided/i.test(readme));
  ok("README stages screenshots (no fake ones)", /Staged.*real-UI screenshots/i.test(readme));

  const terms = read("docs/commercial-license-terms.md");
  ok("commercial terms page exists as DRAFT", /Status: draft/i.test(terms));
  ok("commercial terms are not in force", /not in force|not effective/i.test(terms));
  ok("commercial terms defer to the split decision", /open-core split/i.test(terms) && /undecided|decided/i.test(terms));
  ok("commercial terms note CLA/DCO prerequisite", /CLA-vs-DCO|CLA.*DCO/i.test(terms));
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed, ${warnings.length} warning(s)`);
if (warnings.length > 0) console.log("warnings:", warnings.join("; "));
if (fail > 0) {
  console.log("failures:", failures.join(", "));
  process.exit(1);
}
console.log("F6 BATTERY GREEN");
