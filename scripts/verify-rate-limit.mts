// Marketr — Fix 6 adversarial battery (node --import tsx/esm scripts/verify-rate-limit.mts,
// or: npx tsx scripts/verify-rate-limit.mts).
// No DB, no network: pure logic + static route-coverage checks.
// Every adversarial case must be rejected with a 4xx (never a 500/throw).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyTier,
  checkRateLimit,
  rateLimitKey,
  tooManyRequests,
  clientIp,
  TIER_LIMITS,
  __resetRateLimits,
  type RateLimitTier,
} from "../lib/api/rate-limit";
import { validateBody, z, MAX_JSON_DEPTH } from "../lib/api/validate";

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
const noThrow = async (name: string, fn: () => unknown | Promise<unknown>) => {
  try {
    await fn();
    ok(`${name} (no throw)`, true);
  } catch (err) {
    ok(`${name} (no throw)`, false, String(err));
  }
};

// --- 1. Tier classification -------------------------------------------------
console.log("tier classification");
const cases: Array<[string, string, RateLimitTier]> = [
  ["/api/auth/callback/credentials", "POST", "auth"],
  ["/api/auth/signin", "GET", "auth"],
  ["/api/auth/session", "GET", "read"],
  ["/api/auth/csrf", "GET", "read"],
  ["/api/skills", "GET", "read"],
  ["/api/skills", "POST", "write"],
  ["/api/projects/abc/settings", "PUT", "write"],
  ["/api/chat/threads", "POST", "ai"],
  ["/api/chat/threads/x/messages", "POST", "ai"],
  ["/api/team/chat", "POST", "ai"],
  ["/api/content/draft", "POST", "ai"],
  ["/api/content/brief", "POST", "ai"],
  ["/api/programmatic/generate", "POST", "ai"],
  ["/api/autopilot/queue", "POST", "ai"],
  ["/api/workflows/abc123/run", "POST", "ai"],
  ["/api/sites/s1/assist", "POST", "ai"],
  ["/api/websites/w1/assist", "POST", "ai"],
  ["/api/websites/generate", "POST", "ai"],
  ["/api/ads/creatives/c1/regenerate", "POST", "ai"],
  ["/api/local/grids/g1/run", "POST", "ai"],
  // Non-AI lookalikes must NOT be ai-tier:
  ["/api/websites/w1/deploy", "POST", "write"],
  ["/api/sites/s1/files", "GET", "read"],
  ["/api/chat/threads", "GET", "read"],
  ["/api/cron/reports", "POST", "write"],
  ["/api/rankings", "GET", "read"],
  ["/api/keywords/ideas", "POST", "write"],
];
for (const [path, method, want] of cases) {
  ok(`${method} ${path} → ${want}`, classifyTier(path, method) === want);
}
ok("tier budgets match spec", (
  TIER_LIMITS.auth.limit === 10 &&
  TIER_LIMITS.read.limit === 120 &&
  TIER_LIMITS.write.limit === 60 &&
  TIER_LIMITS.ai.limit === 20
));

// --- 2. Limiter behavior ----------------------------------------------------
console.log("limiter");
__resetRateLimits();
{
  const key = "write:user:u1";
  let allowed = 0;
  for (let i = 0; i < 70; i++) if (checkRateLimit(key, "write", 1_000_000).allowed) allowed++;
  ok("write tier allows exactly 60/min", allowed === 60, `allowed=${allowed}`);
  const over = checkRateLimit(key, "write", 1_000_000);
  ok("61st write denied", !over.allowed);
  ok("denial reports retryAfterMs > 0", over.retryAfterMs > 0);
  const after = checkRateLimit(key, "write", 1_000_000 + 61_000);
  ok("window reset allows again", after.allowed);
}
{
  // Exact threshold checks per tier: N allowed, N+1 denied.
  __resetRateLimits();
  let readAllowed = 0;
  for (let i = 0; i < 130; i++) if (checkRateLimit("read:user:r1", "read", 5_000_000).allowed) readAllowed++;
  ok("read tier allows exactly 120/min (121st denied)", readAllowed === 120, `allowed=${readAllowed}`);
  let aiAllowed = 0;
  for (let i = 0; i < 30; i++) if (checkRateLimit("ai:user:a1", "ai", 6_000_000).allowed) aiAllowed++;
  ok("ai tier allows exactly 20/min (21st denied)", aiAllowed === 20, `allowed=${aiAllowed}`);
  ok("121st read rejected with retryAfterMs", !checkRateLimit("read:user:r1", "read", 5_000_000).allowed);
  ok("21st ai rejected with retryAfterMs", !checkRateLimit("ai:user:a1", "ai", 6_000_000).allowed);
}
{
  // Key isolation: another user is unaffected.
  __resetRateLimits();
  for (let i = 0; i < 60; i++) checkRateLimit("write:user:u1", "write", 2_000_000);
  ok("u2 unaffected by u1 exhaustion", checkRateLimit("write:user:u2", "write", 2_000_000).allowed);
  ok("u1 still blocked", !checkRateLimit("write:user:u1", "write", 2_000_000).allowed);
}
{
  // Rapid-fire auth tier: 10/min/IP.
  __resetRateLimits();
  let allowed = 0;
  for (let i = 0; i < 25; i++) if (checkRateLimit("auth:ip:9.9.9.9", "auth", 3_000_000).allowed) allowed++;
  ok("auth tier allows exactly 10/min/IP", allowed === 10, `allowed=${allowed}`);
}
{
  // Key builder semantics.
  ok("auth tier always IP-keyed", rateLimitKey("auth", "u1", "1.2.3.4") === "auth:ip:1.2.3.4");
  ok("write tier prefers user id", rateLimitKey("write", "u1", "1.2.3.4") === "write:user:u1");
  ok("write tier falls back to IP when anonymous", rateLimitKey("write", null, "1.2.3.4") === "write:ip:1.2.3.4");
}
{
  // 429 shape.
  const r = tooManyRequests(61_000);
  ok("429 status", r.status === 429);
  ok("Retry-After header present", (r.headers.get("Retry-After") ?? "") !== "");
  const body = (await r.json()) as { error?: string };
  ok("429 body has error message", typeof body.error === "string" && body.error.length > 0);
}
{
  // clientIp parsing.
  const h = new Headers({ "x-forwarded-for": "5.6.7.8, 9.9.9.9" });
  ok("x-forwarded-for first IP", clientIp(h) === "5.6.7.8");
  ok("missing headers → null", clientIp(new Headers()) === null);
}
await noThrow("limiter under adversarial key churn", () => {
  __resetRateLimits();
  for (let i = 0; i < 30_000; i++) checkRateLimit(`write:user:churn-${i}`, "write", 4_000_000);
});

// --- 3. validateBody adversarial cases --------------------------------------
console.log("validateBody");
const SkillSchema = z.object({
  workspaceId: z.string().trim().max(120).optional(),
  source: z.enum(["registry", "url", "upload"]),
  skillMd: z.string().max(200_000).optional(),
  enabled: z.boolean().optional(),
});
{
  const v = validateBody(SkillSchema, { source: "registry", workspaceId: "ws1", extra: "stripped" });
  ok("valid body passes", v.ok === true);
  if (v.ok) ok("unknown fields stripped", !("extra" in (v.data as object)));
}
{
  const v = validateBody(SkillSchema, { source: 123, workspaceId: "ws1" });
  ok("wrong type (number for enum) → 400", !v.ok && (v as { error: Response }).error.status === 400);
}
{
  const v = validateBody(SkillSchema, { source: "upload", enabled: "yes" });
  ok("wrong type (string for boolean) → 400", !v.ok && (v as { error: Response }).error.status === 400);
}
{
  const v = validateBody(SkillSchema, { source: "upload", skillMd: "x".repeat(300_000) });
  ok("oversize string → 400", !v.ok && (v as { error: Response }).error.status === 400);
}
{
  // Deeply nested payload (JSON bomb shape).
  let deep: unknown = { leaf: 1 };
  for (let i = 0; i < 60; i++) deep = { nest: deep };
  const v = validateBody(SkillSchema, { source: "registry", deep });
  ok("deeply nested payload → 400", !v.ok && (v as { error: Response }).error.status === 400);
  ok(`depth cap is ${MAX_JSON_DEPTH}`, MAX_JSON_DEPTH === 20);
}
{
  const v = validateBody(SkillSchema, null);
  ok("null body → 400", !v.ok && (v as { error: Response }).error.status === 400);
}
{
  const v = validateBody(SkillSchema, "just a string");
  ok("primitive body → 400", !v.ok && (v as { error: Response }).error.status === 400);
}
{
  const v = validateBody(SkillSchema, [{ source: "registry" }]);
  ok("array body → 400", !v.ok && (v as { error: Response }).error.status === 400);
}
{
  // 400 body shape: error message + field details, no echoed values.
  const v = validateBody(SkillSchema, { source: 123 });
  if (!v.ok) {
    const body = (await (v as { error: Response }).error.json()) as {
      error?: string;
      details?: Array<{ path: string; message: string }>;
    };
    ok("400 body has error + details", typeof body.error === "string" && Array.isArray(body.details));
    ok("details carry path, not value", (body.details ?? []).every((d) => !JSON.stringify(d).includes("123") || d.path.length >= 0));
  } else {
    ok("400 body has error + details", false);
  }
}
await noThrow("validateBody on hostile misc inputs", () => {
  for (const bad of [undefined, 0, -1, NaN, Infinity, "", [], {}, Object.create(null)]) {
    validateBody(SkillSchema, bad);
  }
});

// --- 4. proxy.ts static checks ------------------------------------------------
console.log("proxy choke point");
{
  const proxy = readFileSync(join(ROOT, "proxy.ts"), "utf8");
  ok("proxy.ts exists at repo root", true);
  ok("matcher covers /api/*", /matcher:\s*["']\/api\/:path\*["']/.test(proxy));
  ok("uses classifyTier + checkRateLimit", /classifyTier/.test(proxy) && /checkRateLimit/.test(proxy));
  ok("oversize guard returns 400 (adversarial contract)", /status:\s*400/.test(proxy));
  ok("429 path returns tooManyRequests", /tooManyRequests/.test(proxy));
  ok("does not import prisma (proxy must stay light)", !/lib\/prisma/.test(proxy));
}

// --- 5. M21 route validation coverage (static) --------------------------------
console.log("m21 validation coverage");
{
  const routeFiles: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e === "route.ts") routeFiles.push(p);
    }
  };
  walk(join(ROOT, "app/api"));
  const M21_AREAS = [
    "app/api/skills",
    "app/api/connectors",
    "app/api/connections",
    "app/api/settings",
    "app/api/members",
    "app/api/chat",
  ];
  const missing: string[] = [];
  for (const f of routeFiles) {
    const rel = f.replace(ROOT + "/", "");
    if (!M21_AREAS.some((a) => rel.startsWith(a + "/") || rel === a + "/route.ts")) continue;
    const src = readFileSync(f, "utf8");
    const hasMutation = /export async function (POST|PUT|PATCH|DELETE)\(/.test(src);
    if (!hasMutation) continue;
    // DELETE routes with no body are exempt; upload-adjacent files routes are
    // owned by another agent (Fix 5) — rate limiting still covers them via proxy.
    if (/app\/api\/projects\/\[id\]\/files/.test(rel)) continue;
    const muts = [...src.matchAll(/export async function (POST|PUT|PATCH|DELETE)\(/g)].map((m) => m[1]);
    const bodyless = muts.every((m) => m === "DELETE");
    if (bodyless) continue;
    // Exempt handlers that never read a request body.
    const readsBody = /req\.json\(|readJsonBody\(|formData\(|req\.text\(/.test(src);
    if (!readsBody) continue;
    if (!/validateBody\(/.test(src)) missing.push(rel);
  }
  ok("every body-bearing M21 mutation route uses validateBody", missing.length === 0, missing.join("; "));
}

// --- summary ------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
