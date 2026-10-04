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
walk(join(ROOT, "app/r")); // public vanity-URL redirect lives outside /api
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
  "requireMcpAuth",                             // MCP bearer auth (lib/mcp/auth.ts) — tenant from credential
  "guardWorkspace",                              // lib/enrichment/guard.ts R6 helper — requireUser + requireWorkspaceRole(editor) for mutations
  "authorityGuard",                              // Phase 6 authority session guard (app/api/authority/_lib.ts) — role-gated per route
  "flywheelGuard",                              // Phase 7 flywheel guard (app/api/flywheel/_lib.ts) — requireUser + requireWorkspaceRole(editor) for mutations
  "dspGuard",                                   // Phase 7 DSP guard (app/api/flywheel/dsp/_lib.ts) — requireUser + requireWorkspaceRole(editor) for mutations
  "launchGuard",                                // Phase 7 launch guard (app/api/flywheel/launch/_lib.ts) — requireUser + requireWorkspaceRole(editor) for mutations
  "mayCreateWorkspace",                         // Phase 3 workspace creation gate (lib/auth/signup.ts) — invite-only mode: members/operator only
  "requirePlatformOperator",                    // Phase 1 host-wide resources (lib/auth/require-platform-operator.ts) — MARKETR_PLATFORM_OPERATORS only
  "requireSelfService",                         // Phase 4a own-account actions (lib/auth/require-self-service.ts) — no target id read from the request; keyed to the session subject
  "requireScimAuth",                            // Phase 4a SCIM 2.0 (lib/scim/auth.ts) — per-workspace hashed bearer token; tenant from the token, RLS-scoped
  "requireAccountUser",                         // Phase 4a self-service account security (lib/auth/mfa/guard.ts) — acts only on the caller's own factors; destructive changes need re-auth
  "financeGuard",                               // Phase 10 (finance) ops guard (lib/ops/finance/http.ts) — requireUser + requireWorkspaceRole(editor|admin) for mutations
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
  // Phase C (W5): MCP OAuth 2.1 endpoints — capability model, see route comments.
  "app/api/mcp/oauth/register/route.ts":
    "DCR open registration per RFC 7591 (no credentials issued); strict pre-auth rate limit + redirect_uri validation",
  "app/api/mcp/oauth/consent/route.ts":
    "signed-in user + AES-GCM-sealed grant token minted by the authorize endpoint; the grant is the capability and fixes the scope set",
  "app/api/mcp/oauth/token/route.ts":
    "authorization-code exchange; single-use code + PKCE verifier is the capability (standard OAuth 2.1)",
  // Phase C gap-fill (G2): Stripe billing webhook — capability model, see route comments.
  "app/api/billing/webhook/route.ts":
    "inbound Stripe webhook; HMAC signature verified with stripe.webhooks.constructEvent before any parsing/logic (lib/metering/THREAT-MODEL-BILLING.md B1); signature is the authorization",
  // Phase 1 (R1): CRM public capture form — capability model, see route comments.
  "app/api/crm/public/forms/[token]/route.ts":
    "public lead-capture endpoint; unguessable token (mkfrm_<32hex>, sha256 at rest) is the capability, scoped to one pipeline; per-token+IP rate limit, honeypot, Zod validation, dedup-checked insert; disabled/missing token 404s",
  // Phase 2 (R5): call-tracking webhooks + public booking — capability model, see route comments.
  "app/api/calls/webhooks/twilio/voice/route.ts":
    "inbound Twilio voice webhook; HMAC-SHA1 verified with TWILIO_AUTH_TOKEN before any parsing/logic (lib/calls/webhooks.ts verifyTwilioSignature); unknown numbers 404, released numbers rejected; provider call SID is the idempotency key",
  "app/api/calls/webhooks/twilio/status/route.ts":
    "inbound Twilio status-callback webhook; same HMAC-SHA1 verification as voice; updates are idempotent per provider call SID and never resurrect terminal call states",
  "app/api/calls/webhooks/twilio/transcription/route.ts":
    "inbound Twilio transcription-callback webhook; same HMAC-SHA1 verification as voice; transcription text stored on the matched call row only",
  "app/api/calls/public/booking/[token]/route.ts":
    "public booking endpoint; unguessable token (mkbook_<32hex>, sha256 at rest) is the capability, scoped to one page; per-page+IP rate limit, Zod validation + body-size cap, explicit TCPA consent required, offered-slot + clash-checked insert; disabled/missing token 404s",
  // Phase 2 (P2): physical attribution kit — public redeem + vanity redirect.
  // Capability model (honest): unlisted random identifiers, not crypto
  // secrets — see lib/physical/bundles.ts header. Nothing behind either
  // route is confidential (redirect / lead creation + touch logging).
  "app/api/attribution/bundles/redeem/route.ts":
    "public promo redemption; 30-bit random code (WAVE-<6>, globally unique) is the capability, scoped to its bundle's workspace; per-code+IP rate limit (10/min), Zod validation + body-size cap, email-or-phone required; invalid/disabled code 404s with no oracle; redemption unique per (bundle,lead)",
  "app/r/[slug]/route.ts":
    "public vanity-URL redirect; 40-bit random slug (globally unique, findUnique resolution) is the capability; anonymous scan logged per (bundle,ip,day) via unique constraint (P2002 collapse), disabled bundle 410s, unknown slug 404s; qr_code touch only for identified (?lead=) scanners",
  // Phase 3 (R3): messaging webhook + unsubscribe — capability model, see route comments.
  "app/api/messaging/inbound/sms/route.ts":
    "inbound Twilio SMS webhook; HMAC-SHA1 verified with TWILIO_AUTH_TOKEN before any parsing/logic (provider.validateWebhookSignature); invalid signature 401s; STOP/HELP/START only mutate consent state, no PII returned",
  // Phase 4b: inbound email replies for the CRM inbox — capability model, see route comments.
  "app/api/messaging/inbound/email/route.ts":
    "inbound Resend email.received webhook; Svix signature (RESEND_INBOUND_WEBHOOK_SECRET) verified over the raw body before any parsing/logic, fail closed (503 without a secret, 401 on a bad signature); tenant only from the HMAC-signed reply+<workspace>-<sig> address; appends one inbound ledger row, idempotent per email id, returns no data",
  "app/api/messaging/unsubscribe/route.ts":
    "public one-click unsubscribe; HMAC-signed token (workspaceId+messageId+leadId) is the capability; invalid/expired token 404s; only sets opt_out, never returns data",
  // Phase 3 (R4): review QR completion — capability model, see route comments.
  "app/api/review-requests/by-token/[token]/complete/route.ts":
    "public QR-landing completion; unlisted random review-request token is the capability (mirrors /r/[slug] vanity model); per-token+IP rate limit; only flips viewed→completed, expired links 410",
  // Phase 4 (T1): direct-mail provider webhooks — capability model, see route comments.
  "app/api/webhooks/mail/lob/route.ts":
    "inbound Lob mail-tracking webhook; HMAC-SHA256 verified (timestamp-bound raw body, lib/mail/lob.ts) before any parsing/logic; invalid signature 401s; idempotent via MailWebhookEvent unique (provider,eventId), duplicate/out-of-order collapse; only updates piece delivery status + attribution touches, never returns data",
  "app/api/webhooks/mail/postgrid/route.ts":
    "inbound PostGrid mail-tracking webhook; JWT verified (Bearer or body token/jwt, lib/mail/postgrid.ts) before any parsing/logic; invalid signature 401s; same idempotency + status-update-only semantics as the Lob route",
  // Phase 5 (media buying): CallRail webhook — capability model, see route comments.
  "app/api/webhooks/callrail/route.ts":
    "inbound CallRail call-event webhook; HMAC signature verified (x-callrail-signature) before any parsing/logic; invalid signature 401s; idempotent via CallWebhookEvent unique(provider,eventId); only updates call/attribution state, never returns data",
  // Phase 6 (O1): Smartlead/Instantly webhooks — capability model, see route comments.
  "app/api/authority/outreach/webhooks/smartlead/route.ts":
    "inbound Smartlead event webhook; HMAC-SHA256 verified (x-marketr-signature, SMARTLEAD_WEBHOOK_SECRET) before any parsing/logic (app/api/authority/outreach/webhooks/_handler.ts); invalid/missing signature 401s; idempotent per provider event id; only updates outreach sequence/prospect state (incl. stop-on-reply), never returns data",
  "app/api/authority/outreach/webhooks/instantly/route.ts":
    "inbound Instantly event webhook; same HMAC-SHA256 verification as the Smartlead route (INSTANTLY_WEBHOOK_SECRET); invalid/missing signature 401s; idempotent per provider event id; only updates outreach sequence/prospect state (incl. stop-on-reply), never returns data",
  // Phase 6 (R1): GBP review-notification webhook — capability model, see route comments.
  "app/api/authority/webhooks/gbp/route.ts":
    "inbound GBP Pub/Sub new-review notification webhook; HMAC-SHA256 verified (x-marketr-signature) before any parsing/logic; invalid signature 401s; idempotent per notification id; only enqueues reviews into the approval queue, never returns data",
  // Phase 8 (G1): business-graph platform webhooks — capability model, see route comments.
  "app/api/substrate/graph/webhooks/[platform]/route.ts":
    "inbound platform webhook (hubspot/shopify/meta/salesforce); per-platform HMAC verified with fail-closed semantics (verifyTierWWebhook in lib/substrate/graph/connectors/tierw.ts) before any parsing/logic; missing secret 503s, forged signature 401s, replayed delivery 409s; only appends graph facts, never returns data",
  // E-sign (Documenso) + session replay + data-room view beacon (2026-10-03 audit).
  "app/api/esign/webhooks/documenso/route.ts":
    "inbound Documenso webhook; shared secret compared timing-safely before any parsing/logic, fails closed (401) when unset or wrong; only advances envelope/signer state, never returns data",
  "app/api/s/[token]/replay/route.ts":
    "public session-replay ingest for a shared Studio page; hashed share token is the capability (revoked/expired/opt-in checked), batch-size capped; append-only, never returns data",
  "app/r/funding/[token]/views/[viewId]/route.ts":
    "public data-room view-duration beacon; the view row must belong to the link resolved from the unguessable 128-bit token and its workspace; only updates that view's duration",
  // Sign-in surface under /api/auth (proxy auth tier: 10 req/min per IP).
  // Phase 6 replaced the blanket "app/api/auth/ is Auth.js" skip with these
  // explicit entries, so a new route there must justify itself too.
  "app/api/auth/passkey/options/route.ts":
    "Phase 4a passkey sign-in options; first half of a sign-in, returns a random single-use 5-minute challenge that grants nothing until signIn(\"passkey\") verifies a signed assertion with a registered credential",
  "app/api/auth/email/signup/route.ts":
    "Phase 6 email signup; creates an UNVERIFIED account and emails a single-use verify link (SHA-256 at rest), password unusable until verified; SIGNUP_MODE=invite via signInAllowed, login lockout, CAPTCHA, password policy, per-address send limit; same 202 whether or not the address exists",
  "app/api/auth/email/magic-link/route.ts":
    "Phase 6 magic link request; always the same 200; emails a single-use 15-minute link (SHA-256 at rest) redeemed only through the email-link Credentials provider; lockout, CAPTCHA step-up, per-address send limit",
  "app/api/auth/email/password/forgot/route.ts":
    "Phase 6 password reset request; always the same 200; emails a single-use 1-hour reset link (SHA-256 at rest) only when an email account exists; lockout, CAPTCHA step-up, per-address send limit",
  "app/api/auth/email/password/reset/route.ts":
    "Phase 6 password reset; the single-use reset token is the capability, consumed by one guarded UPDATE (used_at IS NULL AND expires_at > now) after the password policy passes; voids every other link for the address",
  // Phase 6 (runtime): workflow canvas webhook trigger — capability model, see route comments.
  "app/api/hooks/workflows/[id]/route.ts":
    "inbound workflow-trigger webhook; ShapesOS-Signature HMAC-SHA256 (lib/webhooks/signing.ts verifyWebhookSignature, per-workflow whsec_ secret stored as a secrets() envelope) verified before any parsing/logic with a 5-minute window; exact replays 409 via unique receipt; unknown workflow/no secret/no webhook trigger 404 alike; per-workflow rate limit + 64 KiB body cap; only starts a run through startWorkflowRun (kill switch honoured), returns run id + status only",
  // Phase 9 (repos): GitHub PR feedback webhook — capability model, see route comments.
  // Phase 10 (finance): tenant Stripe Checkout webhook — capability model, see route comments.
  "app/api/ops/stripe/webhook/[workspaceId]/route.ts":
    "inbound tenant Stripe webhook; Stripe-Signature verified with THAT workspace's own webhook secret (lib/secrets envelope, stripe.webhooks.constructEvent with timestamp tolerance) before any parsing/logic (unset secret 503, bad signature 400); only checkout.session.completed carrying this workspace's invoice metadata is applied, once per payment intent (advisory lock + lookup), under the tenant's RLS scope; 1 MiB body cap; returns ids only",
  "app/api/hooks/github/route.ts":
    "inbound GitHub webhook; X-Hub-Signature-256 HMAC-SHA256 with GITHUB_WEBHOOK_SECRET verified in constant time over the raw body before parsing (unset secret → 503); delivery id is the primary key of github_webhook_deliveries so redeliveries are no-ops; bots, non-collaborators, non shapes/<runId> branches and forks ignored; routed to its workspace via a SELECT-only policy on agent_pull_requests, every write under that tenant's GUC; only queues a pr_feedback agent job (pushes still need a person's OK); 1 MiB body cap, per-IP limit in proxy.ts; returns counts only",
};
const uncovered = [];
for (const f of routeFiles) {
  const rel = f.replace(ROOT + "/", "");
  // Auth.js's own catch-all handler (re-exports GET/POST from handlers).
  if (rel === "app/api/auth/[...nextauth]/route.ts") continue;
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
ok(`all ${routeFiles.length} route files scanned (app/api + app/r)`, true);
ok("every mutation route is authorization-gated", uncovered.length === 0, uncovered.join("; "));
const missingAllowList = Object.keys(PUBLIC_BY_DESIGN).filter(k => {
  try { return !statSync(join(ROOT, k)).isFile(); } catch { return true; }
});
ok("every public-by-design entry maps to a real route file", missingAllowList.length === 0, missingAllowList.join("; "));
ok(
  "public-by-design allow-list is documented",
  Object.keys(PUBLIC_BY_DESIGN).length === 35 && // Phase 9 (repos): +1 app/api/hooks/github
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
// Phase 8: sandbox checkpoint restore + previews (lib/sandbox).
ok("agent-run restore = editor+ or the run's starter", has("app/api/agent-runs/[runId]/restore/route.ts", /!isStarter && !\(await requireWorkspaceRole\(user\.id, workspace\.id, "editor"\)\)/));
ok("agent-run stop = editor+ or the run's starter", has("app/api/agent-runs/[runId]/cancel/route.ts", /!isStarter && !\(await requireWorkspaceRole\(user\.id, workspace\.id, "editor"\)\)/));
ok("sandbox preview: members only, writes editor+ or starter, exposed ports only, no app cookies upstream",
  has("app/api/agent-runs/[runId]/preview/[port]/[[...path]]/route.ts", /requireRole: requireWorkspaceRole/) &&
  has("lib/sandbox/preview-proxy.ts", /requireRole\(userId, workspaceId, "viewer"\)/) &&
  has("lib/sandbox/preview-proxy.ts", /run\.startedBy !== userId && !\(await requireRole\(userId, workspaceId, "editor"\)\)/) &&
  has("lib/sandbox/preview-proxy.ts", /exposedPorts\.includes\(port\)/) &&
  has("lib/sandbox/preview.ts", /"cookie",\s*"authorization"/));
ok("sandbox preview CSP is an opaque-origin sandbox (no allow-same-origin)",
  /export const SANDBOX_PREVIEW_CSP = \[\s*"sandbox allow-scripts allow-forms allow-modals allow-downloads",/.test(readFileSync(join(ROOT, "lib/security/headers.ts"), "utf8")) &&
  !/allow-same-origin|allow-top-navigation|allow-popups/.test((readFileSync(join(ROOT, "lib/security/headers.ts"), "utf8").match(/export const SANDBOX_PREVIEW_CSP = \[([\s\S]*?)\]/) ?? [])[1] ?? "x allow-same-origin"));
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
// Headers are built in lib/security/headers.ts and wired in next.config.ts.
const nextCfg = readFileSync(join(ROOT, "next.config.ts"), "utf8");
const headersSrc = readFileSync(join(ROOT, "lib/security/headers.ts"), "utf8");
ok("security headers wired in next.config.ts", /buildSecurityHeaders/.test(nextCfg) && /headers\(\)/.test(nextCfg));
ok("security headers defined", /X-Content-Type-Options/.test(headersSrc) && /X-Frame-Options/.test(headersSrc) && /Strict-Transport-Security/.test(headersSrc));
ok("Content-Security-Policy blocks inline handlers + plugins", /Content-Security-Policy/.test(headersSrc) && /script-src-attr 'none'/.test(headersSrc) && /object-src 'none'/.test(headersSrc));
// Phase 3: CSP is per-request (nonce) and set by proxy.ts, not next.config.
const proxySrc = readFileSync(join(ROOT, "proxy.ts"), "utf8");
const scriptSrcLine = (headersSrc.match(/const scriptSrc = \[([\s\S]*?)\]/) ?? [])[1] ?? "";
ok("CSP script-src is nonce-based (strict-dynamic, no 'unsafe-inline', eval dev-only)",
  /'nonce-\$\{opts\.nonce\}'/.test(scriptSrcLine) && /'strict-dynamic'/.test(scriptSrcLine) &&
  !/unsafe-inline/.test(scriptSrcLine) && /opts\.dev \? \["'unsafe-eval'"/.test(scriptSrcLine));
ok("CSP nonce from a CSPRNG", /crypto\.getRandomValues/.test(headersSrc));
ok("proxy sets the per-request CSP on request + response",
  /generateCspNonce\(\)/.test(proxySrc) && /contentSecurityPolicyFor\(/.test(proxySrc) &&
  /requestHeaders\.set\("content-security-policy"/.test(proxySrc) && /headers\.set\("Content-Security-Policy"/.test(proxySrc));
ok("proxy matcher covers pages and every API route", /"\/api\/:path\*"/.test(proxySrc) && /_next\/static/.test(proxySrc));
ok("no second (static) CSP header from next.config",
  !/"Content-Security-Policy"|buildContentSecurityPolicy|contentSecurityPolicyFor/.test(nextCfg) &&
  !/key: "Content-Security-Policy"/.test(headersSrc.slice(headersSrc.indexOf("export function buildSecurityHeaders"))));
ok("pages render per request (nonce reaches the HTML)", /await connection\(\)/.test(readFileSync(join(ROOT, "app/layout.tsx"), "utf8")));
ok("HSTS gated on https", /shouldSendHsts/.test(nextCfg) && /startsWith\("http:\/\/"\)/.test(headersSrc));
ok("X-Powered-By disabled", /poweredByHeader:\s*false/.test(nextCfg));
const authCfg = readFileSync(join(ROOT, "auth.ts"), "utf8");
ok("12h session maxAge", /maxAge:\s*12 \* 60 \* 60/.test(authCfg));
const sso = readFileSync(join(ROOT, "lib/sso.ts"), "utf8");
ok("OIDC provisioning defaults to editor", /SSO_DEFAULT_ROLE/.test(sso));
const login = readFileSync(join(ROOT, "app/login/page.tsx"), "utf8") + readFileSync(join(ROOT, "app/login/LoginClient.tsx"), "utf8");
ok("SSO buttons conditional on config", /providers\.length/.test(login) || /configured/i.test(login));

// --- 5b. Email sign-in (Phase 6): stateless JWT kept, guards wired ---
console.log("email sign-in");
const emailStore = readFileSync(join(ROOT, "lib/auth/email/store.ts"), "utf8");
const emailAuthorize = readFileSync(join(ROOT, "lib/auth/email/authorize.ts"), "utf8");
const emailPassword = readFileSync(join(ROOT, "lib/auth/email/password.ts"), "utf8");
const emailMail = readFileSync(join(ROOT, "lib/auth/email/mail.ts"), "utf8");
ok("no Auth.js database adapter (stateless JWT)", !/adapter\s*:/.test(authCfg) && /strategy:\s*"jwt"/.test(authCfg));
ok("email providers registered in auth.ts", /EMAIL_PASSWORD_PROVIDER_ID/.test(authCfg) && /EMAIL_LINK_PROVIDER_ID/.test(authCfg) && /authorizeEmailPassword/.test(authCfg) && /authorizeEmailLink/.test(authCfg));
ok("email password login reuses lockout + CAPTCHA step-up + audit",
  // Phase 6: the shared (Postgres-backed) *Async variants are what sign-in calls.
  /loginLockedOut(Async)?\(/.test(emailAuthorize) && /recordLoginFailure(Async)?\(/.test(emailAuthorize) && /recordLoginSuccess(Async)?\(/.test(emailAuthorize) &&
  /captchaRequired(Async)?\(/.test(emailAuthorize) && /verifyCaptchaToken\(/.test(emailAuthorize) && /auth_login_failed/.test(emailAuthorize));
ok("unverified accounts can't use a password", /status: "unverified"/.test(emailStore) && /EmailUnverifiedError/.test(emailAuthorize));
ok("signup honours SIGNUP_MODE=invite (signInAllowed)", /signupMode\(deps\.env\) === "invite" && !\(await signInAllowed\(/.test(emailStore));
ok("links are single use (guarded UPDATE on used_at/expires_at)", /usedAt: null, expiresAt: \{ gt: now \}/.test(emailStore) && /res\.count !== 1/.test(emailStore));
ok("only token hashes stored", /tokenHash: hashEmailToken\(token\)/.test(emailStore));
ok("scrypt with explicit parameters + timingSafeEqual", /SCRYPT_PARAMS = \{ N: 2 \*\* 15, r: 8, p: 1 \}/.test(emailPassword) && /timingSafeEqual\(/.test(emailPassword));
ok("console link fallback is development-only", /isProduction\(env\) \? null : "console"/.test(emailMail));
ok("production links never use the request Host", /appBaseUrl\(env, null\) \?\? \(isProduction\(env\) \? null :/.test(emailMail));
ok("account deletion removes email accounts + links", /"email_accounts"/.test(readFileSync(join(ROOT, "lib/gdpr/account-delete.ts"), "utf8")) && /DELETE FROM "email_auth_tokens"/.test(readFileSync(join(ROOT, "lib/gdpr/account-delete.ts"), "utf8")));

// --- 6. Secrets abstraction contract ---
console.log("secrets");
const secrets = readFileSync(join(ROOT, "lib/secrets/index.ts"), "utf8");
ok("SecretsProvider interface", /interface SecretsProvider/.test(secrets));
ok("env default provider", /EnvSecretsProvider/.test(secrets));
ok("KMS stub documented", /AwsKmsSecretsProvider/.test(secrets));
ok("credential call sites use secrets()", has("app/api/sites/route.ts", /secrets\(\)\.encrypt/));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
