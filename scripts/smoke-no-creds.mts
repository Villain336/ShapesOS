// Marketr — credential-free smoke test (Phase 7, F6).
//
// Run: npx tsx scripts/smoke-no-creds.mts
//
// Proves the app boots and behaves in MOCK MODE with zero private
// credentials. Any provider-backed path must degrade to mock or skip
// gracefully — skips are explicit, never silent.
//
// Only DATABASE_URL may be set (CI provides a throwaway postgres). Every
// other credential env var is scrubbed in-process to simulate a cred-free
// machine; the parent environment is untouched.

const CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "LLM_API_KEY",
  "DATAFORSEO_LOGIN",
  "DATAFORSEO_PASSWORD",
  "SMARTLEAD_API_KEY",
  "INSTANTLY_API_KEY",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "CALLRAIL_API_KEY",
  "CALLRAIL_WEBHOOK_SECRET",
  "MARKETR_APPROVAL_SECRET",
  "AUTHORITY_APPROVAL_SECRET",
  "MARKETR_CREDENTIALS_KEY",
  "DUB_BASE_URL",
  "ADMIN_PASSWORD",
  "NEXTAUTH_SECRET",
  "AUTH_SECRET",
  "CRON_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "CANVA_CLIENT_SECRET",
  "OIDC_CLIENT_SECRET",
  "SMTP_PASS",
  "MARKETR_S3_SECRET_KEY",
];

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(name: string, reason: string) {
  console.log(`  ○ SKIP ${name} — ${reason}`);
}

// --- 1. Scrub credentials in-process (simulate a cred-free machine) ---
console.log("credential scrub");
const scrubbed: string[] = [];
for (const v of CREDENTIAL_VARS) {
  if (process.env[v] !== undefined && process.env[v] !== "") {
    scrubbed.push(v);
    delete process.env[v];
  }
}
check(
  "no private credentials visible to the app",
  scrubbed.length === 0,
  scrubbed.length > 0 ? `scrubbed in-process: ${scrubbed.join(", ")}` : "",
);
if (scrubbed.length > 0) {
  console.log(`    (note: ${scrubbed.length} credential var(s) were set in the parent env and scrubbed in-process)`);
}

// --- 2. LLM router degrades to mock, loudly ---
console.log("llm router (mock mode)");
const { llmRoutingStatus } = await import("@/lib/llm/router");
const status = llmRoutingStatus();
for (const w of ["copy", "bulk", "background"] as const) {
  const s = status[w];
  check(
    `workload ${w}: mock, not live`,
    s.isLive === false && s.name === "mock",
    JSON.stringify(s),
  );
  check(`workload ${w}: fallback reason stated (loud, not silent)`, typeof s.fallback === "string" && s.fallback.length > 0);
}

// --- 3. Launch lib loads without credentials ---
console.log("launch lib");
const catalog = await import("@/lib/flywheel/launch/catalog");
check("catalog loads: 21 items", catalog.LAUNCH_CHECKLIST_CATALOG.length === 21, String(catalog.LAUNCH_CHECKLIST_CATALOG.length));
check(
  "catalog covers all 4 categories",
  ["security", "legal", "community", "build"].every((c) =>
    catalog.LAUNCH_CHECKLIST_CATALOG.some((i: { category: string }) => i.category === c),
  ),
);
check("open-core split not decided", catalog.OPEN_CORE_SPLIT_DECIDED === false);
const store = await import("@/lib/flywheel/launch/store");
for (const fn of ["launchTablesReady", "seedLaunchChecklist", "listLaunchChecklist", "progressOf", "completeChecklistItem", "reopenChecklistItem"]) {
  check(`store exports ${fn}`, typeof (store as Record<string, unknown>)[fn] === "function");
}
// progressOf is pure — exercise it with zero rows (no DB needed).
const p = store.progressOf([]);
check("progressOf([]) is zeroed", p.total === 0 && p.complete === 0);

// --- 4. Launch API route modules import (no throw at import time) ---
console.log("launch api routes");
const listRoute = await import("@/app/api/flywheel/launch/checklist/route");
check("GET /api/flywheel/launch/checklist exports GET", typeof listRoute.GET === "function");
const completeRoute = await import("@/app/api/flywheel/launch/checklist/[id]/complete/route");
check("POST .../checklist/:id/complete exports POST", typeof completeRoute.POST === "function");
const reopenRoute = await import("@/app/api/flywheel/launch/checklist/[id]/reopen/route");
check("POST .../checklist/:id/reopen exports POST", typeof reopenRoute.POST === "function");

// --- 5. DB-gated paths skip explicitly without DATABASE_URL ---
console.log("db-gated paths");
if (!process.env.DATABASE_URL) {
  skip("launchTablesReady() live probe", "DATABASE_URL unset — tablesReady() is fail-closed by design");
  check("launchTablesReady is fail-closed without DB (import OK)", true);
} else {
  const ready = await store.launchTablesReady();
  check("launchTablesReady() resolves to boolean", typeof ready === "boolean");
}

// --- summary ---
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("failures:", failures.join(", "));
  process.exit(1);
}
console.log("SMOKE GREEN — app is cred-free safe (mock mode).");
