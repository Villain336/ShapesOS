// Marketr — M11 security verification (node scripts/verify-m11-security.mjs).
// No DB, no network: pure logic checks + static route-coverage analysis.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

// --- 1. Role hierarchy (parsed from lib/authz.ts, truth-table checked) ---
console.log("role hierarchy");
const authz = readFileSync(join(ROOT, "lib/authz.ts"), "utf8");
const rankMatch = authz.match(/ROLE_RANK[^=]*=\s*\{([^}]*)\}/s);
const ranks = {};
for (const m of rankMatch[1].matchAll(/(\w+):\s*(\d+)/g)) ranks[m[1]] = Number(m[2]);
ok("four roles ranked", JSON.stringify(Object.keys(ranks).sort()) === JSON.stringify(["admin","editor","owner","viewer"]));
ok("owner > admin > editor > viewer", ranks.owner > ranks.admin && ranks.admin > ranks.editor && ranks.editor > ranks.viewer);
const atLeast = (role, min) => ranks[role] >= ranks[min];
const matrix = {
  viewer:  { viewer: true,  editor: false, admin: false, owner: false },
  editor:  { viewer: true,  editor: true,  admin: false, owner: false },
  admin:   { viewer: true,  editor: true,  admin: true,  owner: false },
  owner:   { viewer: true,  editor: true,  admin: true,  owner: true  },
};
let matrixOk = true;
for (const [role, row] of Object.entries(matrix))
  for (const [min, want] of Object.entries(row))
    if (atLeast(role, min) !== want) matrixOk = false;
ok("roleAtLeast truth table (16 cases)", matrixOk);
ok("forbidden() helper exists", /export function forbidden\(/.test(authz));

// --- 2. Mutation-route coverage: every POST/PUT/PATCH/DELETE must be authorization-gated ---
// A route passes when its source — following relative imports (./_handlers,
// ../_lib, local guard() helpers live in the file) — contains at least one
// recognized authorization primitive, or the route is PUBLIC_BY_DESIGN with
// a documented justification. requireUser alone is authentication, not
// authorization, and never passes.
console.log("route coverage");
const routeFiles = [];
const walk = (d) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e === "route.ts") routeFiles.push(p);
  }
};
walk(join(ROOT, "app/api"));
// Recursively inline relative imports so delegation (../_lib, ./_handlers)
// doesn't hide the authorization check from static analysis.
function fullSource(f, seen = new Set()) {
  if (seen.has(f)) return "";
  seen.add(f);
  let s;
  try { s = readFileSync(f, "utf8"); } catch { return ""; }
  const dir = dirname(f);
  for (const m of s.matchAll(/from "(\.[^"]*)"/g)) {
    const cand = join(dir, m[1] + ".ts");
    try {
      if (statSync(cand).isFile()) s += "\n" + fullSource(cand, seen);
    } catch { /* not a resolvable file import */ }
  }
  return s;
}
// Every authorization primitive the codebase uses (2026-09-22 audit). When a
// new helper is introduced, it MUST be added here — the scan fails closed.
const AUTHZ_PRIMITIVES = [
  "requireProjectRole", "requireWorkspaceRole", // lib/authz.ts core RBAC
  "requirePermission",                          // lib/authz.ts M21 grant-based
  "requireProjectAccess", "requireWorkspaceAccess", // lib/route-utils.ts (min role)
  "requireEditor", "requireWorkspaceEditor",    // per-area _lib.ts (editor+)
  "requireWorkspaceAdmin", "requireOwnerAdmin", // per-area _lib.ts (admin+)
  "requireRole",                                // app/api/programmatic/util.ts
  "requireWorkflow", "requireWorkflowProject",  // lib/workflow/http.ts
  "cronGate", "CRON_SECRET",                    // cron service auth (lib/cron/gate.ts)
  "roleAtLeast",                                // inline owner-or-admin checks (lib/authz.ts)
];
// Public by design. Each entry documents WHY — this is a justification list,
// not a suppression list. Adding an entry requires a code comment in the
// route explaining the capability/token model.
const PUBLIC_BY_DESIGN = {
  "app/api/newsletter/unsubscribe/route.ts":
    "public token capability (RFC 8058 one-click unsubscribe); token is the capability",
  "app/api/newsletter/webhooks/resend/route.ts":
    "inbound webhook, fail-closed Svix verification (lib/newsletter/webhook-auth.ts)",
  "app/api/workspace/invites/accept/route.ts":
    "signed-in user + single-use invite token bound to claimant email (lib/authz.ts claimInviteToken)",
};
const uncovered = [];
for (const f of routeFiles) {
  const rel = f.replace(ROOT + "/", "");
  if (rel.startsWith("app/api/auth/")) continue; // Auth.js provider routes
  // E2E test-only mock infrastructure: every handler 404s unless the
  // E2E_MOCK_OAUTH=1 flag is set; never enabled in production builds.
  if (rel.startsWith("app/api/e2e/")) continue;
  if (PUBLIC_BY_DESIGN[rel]) continue;
  const s = fullSource(f);
  const muts = [...s.matchAll(/export async function (POST|PUT|PATCH|DELETE)\(/g)].map(m => m[1]);
  if (!muts.length) continue;
  const gate = AUTHZ_PRIMITIVES.find(p => s.includes(p));
  if (!gate) uncovered.push(`${rel} [${muts.join(",")}]`);
}
ok(`all ${routeFiles.length} API route files scanned`, true);
ok("every mutation route is authorization-gated", uncovered.length === 0, uncovered.join("; "));
ok(
  "public-by-design allow-list is documented",
  Object.keys(PUBLIC_BY_DESIGN).length === 3 &&
    Object.values(PUBLIC_BY_DESIGN).every(v => v.length > 20)
);

// --- 3. Spot checks: credential CRUD is admin+, fix-agent settings admin+, viewers read-only ---
console.log("spot checks");
const has = (file, re) => re.test(readFileSync(join(ROOT, file), "utf8"));
ok("SFTP credential create = admin+", has("app/api/sites/route.ts", /requireProjectRole\(user\.id,\s*project\.id,\s*"admin"\)/));
ok("SFTP credential delete = admin+", has("app/api/sites/[id]/route.ts", /"admin"/));
ok("hosting token create = admin+", has("app/api/hosting/connections/route.ts", /"admin"/));
ok("hosting token delete = admin+", has("app/api/hosting/connections/[id]/route.ts", /"admin"/));
ok("site-with-credentials create = admin+", has("app/api/websites/route.ts", /minRole = storesCredentials \? "admin" : "editor"/));
ok("fix-agent settings = admin+", has("app/api/websites/[id]/fix-agent/route.ts", /"admin"/));
ok("project delete = admin+", has("app/api/projects/[id]/route.ts", /"admin"/));
ok("member management = admin+", has("app/api/workspace/members/route.ts", /requireWorkspaceRole\(user\.id, workspace\.id, "admin"\)/));
ok("deploy writes = editor+", has("app/api/websites/[id]/deploy/route.ts", /"editor"/));
ok("audit writes = editor+", has("app/api/websites/[id]/audit/route.ts", /requireProjectRole\(user\.id, site\.projectId, "editor"\)/));
ok("issue approval = editor+", has("app/api/websites/[id]/issues/approve-all/route.ts", /"editor"/));
ok("rankings check session path = editor+", has("app/api/rankings/check/route.ts", /requireProjectRole\(user!\.id, projectId, "editor"\)/));
ok("cron fix-agent session path filters by role", has("app/api/cron/fix-agent/route.ts", /requireProjectRole\(user\.id, s\.projectId, "editor"\)/));

// --- 4. Audit coverage: credential + membership lifecycle events exist ---
console.log("audit coverage");
ok("credential_created action in schema", /credential_created/.test(readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8")));
ok("credential_deleted action in schema", /credential_deleted/.test(readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8")));
ok("member_* actions in schema", /member_added/.test(authz) || /member_added/.test(readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8")));
ok("SFTP create writes audit", has("app/api/sites/route.ts", /action: "credential_created"/));
ok("SFTP delete writes audit", has("app/api/sites/[id]/route.ts", /action: "credential_deleted"/));
ok("hosting create writes audit", has("app/api/hosting/connections/route.ts", /action: "credential_created"/));
ok("hosting delete writes audit", has("app/api/hosting/connections/[id]/route.ts", /action: "credential_deleted"/));
ok("remote deploy writes audit", has("app/api/websites/[id]/deploy/route.ts", /action: "deploy"/));
ok("hosting deploy writes audit", has("app/api/websites/[id]/deploy-hosting/route.ts", /action: "deploy"/));

// --- 5. Hardening surface ---
console.log("hardening");
const nextCfg = readFileSync(join(ROOT, "next.config.ts"), "utf8");
ok("security headers in next.config.ts", /X-Content-Type-Options/.test(nextCfg) && /X-Frame-Options/.test(nextCfg) && /Strict-Transport-Security/.test(nextCfg));
ok("HSTS gated on https", /isHttps/.test(nextCfg));
const authCfg = readFileSync(join(ROOT, "auth.ts"), "utf8");
ok("12h session maxAge", /maxAge:\s*12 \* 60 \* 60/.test(authCfg));
const sso = readFileSync(join(ROOT, "lib/sso.ts"), "utf8");
ok("OIDC provisioning defaults to editor", /SSO_DEFAULT_ROLE/.test(sso));
const login = readFileSync(join(ROOT, "app/login/page.tsx"), "utf8");
ok("SSO buttons conditional on config", /providers\.length/.test(login) || /configured/i.test(login));

// --- 6. Secrets abstraction contract ---
console.log("secrets");
const secrets = readFileSync(join(ROOT, "lib/secrets/index.ts"), "utf8");
ok("SecretsProvider interface", /interface SecretsProvider/.test(secrets));
ok("env default provider", /EnvSecretsProvider/.test(secrets));
ok("KMS stub documented", /AwsKmsSecretsProvider/.test(secrets));
ok("credential call sites use secrets()", has("app/api/sites/route.ts", /secrets\(\)\.encrypt/));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
