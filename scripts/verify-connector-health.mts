// Marketr — Phase B (B3) connector-health adversarial battery.
// Run: npx tsx scripts/verify-connector-health.mts
// No DB, no network: pure logic + static source checks.
// Threat-model coverage (THREAT-MODEL-connector-health.md):
//   §1 no SSRF probes · §2 no secret leakage · §3 alert-spam containment
//   §4 no cross-workspace status access · §5 re-auth CSRF
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  sanitizeHealthError,
  serializeHealth,
  shouldFireHealthAlert,
  alertCooldownMinutes,
  toConnectorErrorEvent,
  FIX_HINTS,
  HEALTH_ERROR_CODES,
  type HealthCheckResult,
} from "../lib/connectors/health";
import { MOCK_ONLY_ADAPTER_KEYS } from "../lib/connectors/m21/registry";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// --- §2: secret leakage -----------------------------------------------------
console.log("secret leakage (payload + errors)");

const healthSrc = src("lib/connectors/health.ts");
// The checker never decrypts: expiry comes from the credential ROW select.
ok("checker never calls decrypt()", !/decrypt\s*\(/.test(healthSrc));
ok("checker never touches encryptedBlob", !/encryptedBlob/.test(healthSrc));
// No raw fetch to arbitrary URLs in the checker (refresh uses injected fetchImpl).
ok("checker makes no direct fetch() calls", !/(^|[^A-Za-z])fetch\s*\(/.test(healthSrc));
ok("checker has no timers of its own (scheduler owns the cron)", !/setInterval|setTimeout/.test(healthSrc));

// sanitizeHealthError: token-laden errors collapse to closed codes, nothing echoes.
const nasty = new Error(
  'invalid_grant: bad auth. access_token=ya29.abc123 refresh_token=1//xyz apiKey=sk-live-999 bearer tok_zzz',
);
const code = sanitizeHealthError(nasty);
ok("token-laden error maps to a closed code", (HEALTH_ERROR_CODES as readonly string[]).includes(code));
ok("mapped code is auth_rejected, not a leak", code === "auth_rejected");
ok("fix hint contains no token material", !/ya29|abc123|sk-live|tok_zzz/.test(FIX_HINTS[code]));
ok("non-Error junk maps to unknown_error", sanitizeHealthError({ weird: 1 }) === "unknown_error");
ok("network failure maps to provider_unreachable", sanitizeHealthError(new Error("fetch failed: ENOTFOUND api.x.com")) === "provider_unreachable");
// Every code has a plain-language hint; no hint contains token-shaped text.
for (const c of HEALTH_ERROR_CODES) {
  const hint = FIX_HINTS[c];
  ok(`hint exists for ${c}`, typeof hint === "string" && hint.length > 20);
  ok(
    `hint for ${c} has no token-shaped material`,
    !/access_token|api_key|bearer\s+\S+|sk-|ya29/i.test(hint.replace(/API-key/g, "")),
  );
}

// serializeHealth: strict allow-list projection; hostile values never echoed.
const ALLOWED = new Set([
  "connectionId", "connectorKey", "displayName", "connectionLabel", "authType",
  "connectionStatus", "status", "lastCheckAt", "lastSuccessAt", "errorCode",
  "fixHint", "quota", "liveCheck", "label",
]);
const hostile = serializeHealth(
  { id: "c1", connectorKey: "wordpress", status: "active", meta: { label: "<img>", apiKey: "sk-live-999" } },
  {
    status: "error",
    lastCheckAt: new Date("2026-09-22T12:00:00Z"),
    lastSuccessAt: null,
    lastError: "'; DROP TABLE connector_health; --",
    quotaUsed: 12.5,
    quotaLimit: 100,
  },
);
ok("payload keys are exactly the allow-list", Object.keys(hostile).every((k) => ALLOWED.has(k)) && Object.keys(hostile).length === ALLOWED.size);
ok("unrecognized lastError code is dropped, not echoed", hostile.errorCode === null && hostile.fixHint === null);
ok("meta.apiKey never appears in payload", !JSON.stringify(hostile).includes("sk-live-999"));
const good = serializeHealth(
  { id: "c2", connectorKey: "google-search-console", status: "active", meta: {} },
  { status: "unknown", lastCheckAt: new Date(), lastSuccessAt: null, lastError: "mock_adapter", quotaUsed: null, quotaLimit: null },
);
ok("mock adapter payload is unknown + not liveCheck", good.status === "unknown" && good.liveCheck === false);
ok("quota numbers pass through", hostile.quota?.used === 12.5 && hostile.quota?.limit === 100);
const badQuota = serializeHealth(
  { id: "c3", connectorKey: "resend", status: "active", meta: { quota: { used: "lots", limit: null } } },
  null,
);
ok("non-numeric quota is dropped", badQuota.quota === null);

// --- §1: no SSRF probes / honest unknown ------------------------------------
console.log("honesty (mock adapters never green, no probes)");
const nativeDir = join(ROOT, "lib/connectors/m21/native");
const mockFromHeaders = new Set<string>();
for (const f of readdirSync(nativeDir)) {
  if (!f.endsWith(".ts")) continue;
  const body = readFileSync(join(nativeDir, f), "utf8");
  if (/MOCK-ONLY/.test(body)) mockFromHeaders.add(f.replace(/\.ts$/, ""));
}
const keyOf: Record<string, string> = {
  buffer: "buffer", canva: "canva", dataforseo: "dataforseo", ga4: "ga4",
  "google-ads": "google-ads", "google-drive": "google-drive",
  "google-search-console": "google-search-console", "meta-ads": "meta-ads",
  notion: "notion", resend: "resend", webflow: "webflow", wordpress: "wordpress",
};
const expectedMock = new Set([...mockFromHeaders].map((f) => keyOf[f]).filter(Boolean));
ok(
  "MOCK_ONLY set matches adapter MOCK-ONLY headers",
  expectedMock.size === MOCK_ONLY_ADAPTER_KEYS.size &&
    [...expectedMock].every((k) => MOCK_ONLY_ADAPTER_KEYS.has(k)),
  `headers={${[...expectedMock]}} set={${[...MOCK_ONLY_ADAPTER_KEYS]}}`,
);
ok("exactly 7 mock-only adapters", MOCK_ONLY_ADAPTER_KEYS.size === 7);
ok(
  "checker source never references safeFetch/probe/test_connection",
  !/safeFetch|test_connection|\.test\(\)/.test(healthSrc),
);

// --- §3: alert spam containment ---------------------------------------------
console.log("alert spam containment (cooldown + escalation)");
ok("cooldown base is 15 minutes", alertCooldownMinutes(1) === 15);
ok("cooldown doubles: 30m, 60m", alertCooldownMinutes(2) === 30 && alertCooldownMinutes(3) === 60);
ok("cooldown caps at 24h", alertCooldownMinutes(10) === 1440 && alertCooldownMinutes(99) === 1440);
const t0 = new Date("2026-09-22T12:00:00Z");
ok("healthy never alerts", shouldFireHealthAlert("healthy", null, 0, t0) === false);
ok("unknown never alerts", shouldFireHealthAlert("unknown", null, 0, t0) === false);
ok("degraded never alerts", shouldFireHealthAlert("degraded", null, 0, t0) === false);
ok("needs_reauth fires once per episode", shouldFireHealthAlert("needs_reauth", null, 0, t0) === true);
ok(
  "needs_reauth suppressed after first alert",
  shouldFireHealthAlert("needs_reauth", t0, 1, new Date(t0.getTime() + 60_000)) === false,
);
ok("error fires when never alerted", shouldFireHealthAlert("error", null, 0, t0) === true);
ok(
  "error suppressed inside 15m window",
  shouldFireHealthAlert("error", t0, 1, new Date(t0.getTime() + 14 * 60_000)) === false,
);
ok(
  "error fires after 15m window",
  shouldFireHealthAlert("error", t0, 1, new Date(t0.getTime() + 16 * 60_000)) === true,
);
ok(
  "error backoff escalates (1h window at 3 consecutive errors)",
  shouldFireHealthAlert("error", t0, 3, new Date(t0.getTime() + 59 * 60_000)) === false &&
    shouldFireHealthAlert("error", t0, 3, new Date(t0.getTime() + 61 * 60_000)) === true,
);
// Flapping connector: bounded alerts per day (15+30+60+120+240+480+960 → ≤7).
let alerts = 0;
let last: Date | null = null;
let consec = 0;
for (let m = 0; m < 24 * 60; m += 1) {
  const now = new Date(t0.getTime() + m * 60_000);
  if (shouldFireHealthAlert("error", last, consec, now)) {
    alerts++;
    last = now;
    consec++;
  }
}
ok("flapping connector bounded to ≤7 error alerts/day", alerts <= 7, `got ${alerts}`);
// Alerts route through the hub with a dedup key (static check).
ok("alerts use emitAlert with dedupKey", /emitAlert\(\{[\s\S]*dedupKey:\s*`connector_error:/.test(healthSrc));
ok("checker never sends raw email/webhook", !/nodemailer|sendEmail|webhook.*post|fetch\(.*webhook/i.test(healthSrc));

// --- connector_error event payload (scheduler contract) ----------------------
console.log("connector_error event payload");
const base: HealthCheckResult = {
  connectionId: "conn_1",
  workspaceId: "ws_1",
  connectorKey: "wordpress",
  status: "needs_reauth",
  lastCheckAt: t0,
  lastSuccessAt: null,
  errorCode: "expired_token",
  fixHint: FIX_HINTS.expired_token,
  quotaUsed: null,
  quotaLimit: null,
  liveCheck: true,
  label: null,
};
const evt = toConnectorErrorEvent(base, 2);
ok("event has the documented shape", !!evt && evt.type === "connector_error" && evt.workspaceId === "ws_1" && evt.status === "needs_reauth" && evt.errorCode === "expired_token" && evt.consecutiveErrors === 2 && typeof evt.occurredAt === "string" && typeof evt.fixHint === "string");
ok("healthy results produce no event", toConnectorErrorEvent({ ...base, status: "healthy" }, 0) === null);
ok("unknown results produce no event", toConnectorErrorEvent({ ...base, status: "unknown" }, 0) === null);

// --- §4: cross-workspace access blocked --------------------------------------
console.log("workspace isolation (routes)");
const routeFiles = [
  "app/api/connections/health/route.ts",
  "app/api/connections/[id]/health/route.ts",
  "app/api/connections/[id]/check/route.ts",
];
for (const rel of routeFiles) {
  const body = src(rel);
  ok(`${rel}: requires auth`, /requireUser\(\)/.test(body));
  ok(
    `${rel}: workspace-scoped authorization`,
    /requireWorkspaceAccess|getMembership/.test(body),
  );
  ok(
    `${rel}: connection resolved by { id, workspaceId }`,
    /findFirst\(\{\s*where:\s*\{\s*id,\s*workspaceId/.test(body) || /workspaceId:\s*access\.workspaceId/.test(body),
  );
  ok(`${rel}: no raw credential fields selected`, !/credential|encryptedBlob|apiKey/.test(body));
}
const checkSrc = src("app/api/connections/[id]/check/route.ts");
ok("manual check requires owner-or-admin", /connection\.userId !== user\.id && !roleAtLeast\(membership\.role, "admin"\)/.test(checkSrc));
ok("manual check is audited", /connector_health_checked/.test(checkSrc));

// --- §5: re-auth CSRF ---------------------------------------------------------
console.log("re-auth CSRF");
const tabSrc = src("components/settings/ConnectorHealthTab.tsx");
ok("Reconnect deep-links existing flow (no new OAuth endpoints)", /onReconnect\(h\.connectorKey, h\.authType\)/.test(tabSrc));
ok("no new auth-url/callback/token-exchange routes added", !/connectors\/\$\{|"\/api\/connectors\/[^"]*\/(auth-url|callback)/.test(src("app/api/connections/[id]/check/route.ts")));
ok("check route is POST-only", /export async function POST/.test(checkSrc) && !/export async function GET/.test(checkSrc));

// --- summary ------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
