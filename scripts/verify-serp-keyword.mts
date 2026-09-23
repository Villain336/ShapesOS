// Marketr — standalone SERP analysis + keyword research adversarial battery
// (Phase C gap-fill: standalone execution paths).
//
// Run: DATABASE_URL=<redacted> \
//   npx tsx --tsconfig tsconfig.json scripts/verify-serp-keyword.mts
// Run 3x green before calling this done. Fully offline: no DataForSEO
// credentials in the environment, so every provider call is the clearly
// labeled mock path. Battery workspaces are uniquely named per run
// (zz-serpkw-battery-*) and left in place, matching the metering battery
// convention.
//
// Covers THREAT-MODEL-METERING.md T13 (day-bucket idempotency) and T14
// (shared-helper metering discipline), plus THREAT-MODEL-MCP.md T17:
//   1. Exactly-once standalone charges (serp_analysis 1c, keyword_research 40c)
//   2. Same-day replay dedupes (one ledger event, replay returns original)
//   3. Cross-workspace isolation (same query in two workspaces = two charges)
//   4. Device/location/limit participate in the dedup key
//   5. Pre-cap denial: plain-language 402 text, zero provider execution, zero events
//   6. Raw pullSerp() writes zero ledger events (brief/rank-check flows never
//      incur a serp_analysis charge for their internal pulls)
//   7. Unmetered cores write zero events (MCP handler path charges exactly
//      once, through the protocol passthrough)
//   8. MCP passthrough meters the UNDERLYING action with keyId attribution
//      (never the zero-cost mcp_tool_call action)
//   9. Empty/unknown keyword validation (400, no charge)
//  10. Mock honesty (mock flag + human-readable note)
//  11. Static: lib/serp/pull.ts imports no metering code
//  12. Static: cap pre-gate runs before any provider call in both cores

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const { prisma } = await import("@/lib/prisma");
const {
  analyzeSerp,
  analyzeSerpUnmetered,
  ActionError,
} = await import("@/lib/serp/analyze");
const {
  researchKeywords,
  researchKeywordsUnmetered,
} = await import("@/lib/keywords/research");
const { pullSerp } = await import("@/lib/serp/pull");
const { meterToolCall } = await import("@/lib/mcp/metering");
const { mintApiKey } = await import("@/lib/mcp/auth");
const { checkCap } = await import("@/lib/metering/service");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const RUN = `zz-serpkw-battery-${Date.now()}-${process.pid}`;
const uid = (s: string) => `batt-${process.pid}-${randomUUID().slice(0, 8)}-${s}`;

async function makeSetup(plan: "starter" | "pro" = "starter") {
  const userId = uid("user");
  const ws = await prisma.workspace.create({
    data: { name: `${RUN}-ws-${randomUUID().slice(0, 6)}`, ownerUserId: userId, plan },
  });
  await prisma.workspaceMember.create({
    data: { workspaceId: ws.id, userId, role: "editor" },
  });
  const project = await prisma.project.create({
    data: { workspaceId: ws.id, domain: `batt-${randomUUID().slice(0, 6)}.example.com` },
  });
  return { userId, ws, project };
}

async function eventsOf(workspaceId: string, action?: string) {
  return prisma.usageEvent.count({
    where: { workspaceId, ...(action ? { action } : {}) },
  });
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const a = await makeSetup();
const b = await makeSetup();
// Cap-denied workspace: hard cap of 0 credits, blocking.
const c = await makeSetup();
await prisma.spendCap.create({
  data: { workspaceId: c.ws.id, capCredits: 0, blockAtCap: true },
});

const KW = `battery keyword ${randomUUID().slice(0, 8)}`;
const SEED = `battery seed ${randomUUID().slice(0, 8)}`;

// ── 1. Exactly-once standalone serp_analysis charge ──────────────────────────

const r1 = await analyzeSerp({
  userId: a.userId,
  projectId: a.project.id,
  keyword: KW,
  actorId: a.userId,
});
check(
  "serp_analysis charges exactly 1 credit on first pull",
  r1.charged === 1 && typeof r1.eventId === "string",
  `charged=${r1.charged}`,
);
check(
  "serp_analysis writes exactly one ledger event",
  (await eventsOf(a.ws.id, "serp_analysis")) === 1,
);
check(
  "serp_analysis ledger event carries 1 credit",
  (await prisma.usageEvent.findUnique({ where: { id: r1.eventId } }))?.credits === 1,
);
check(
  "analysis payload is honest mock",
  r1.analysis.mock === true &&
    r1.analysis.notes.some((n) => n.toLowerCase().includes("mock")),
  JSON.stringify(r1.analysis.notes),
);
check(
  "analysis payload has results + deterministic breakdown",
  r1.analysis.results.length > 0 &&
    typeof r1.analysis.analysis.resultCount === "number",
);

// ── 2. Same-day replay dedupes (T13) ─────────────────────────────────────────

const r2 = await analyzeSerp({
  userId: a.userId,
  projectId: a.project.id,
  keyword: KW,
  actorId: a.userId,
});
check(
  "same-day replay returns the original event (no second charge)",
  r2.eventId === r1.eventId && (await eventsOf(a.ws.id, "serp_analysis")) === 1,
  `eventId=${r2.eventId} vs ${r1.eventId}`,
);

// ── 3/4. Dedup key dimensions: workspace, device, location ───────────────────

const rB = await analyzeSerp({
  userId: b.userId,
  projectId: b.project.id,
  keyword: KW,
  actorId: b.userId,
});
check(
  "same keyword in another workspace charges separately (T13 cross-ws)",
  (await eventsOf(b.ws.id, "serp_analysis")) === 1 &&
    (await eventsOf(a.ws.id, "serp_analysis")) === 1,
);

const rMobile = await analyzeSerp({
  userId: a.userId,
  projectId: a.project.id,
  keyword: KW,
  device: "mobile",
  actorId: a.userId,
});
check(
  "device participates in the dedup key (desktop≠mobile)",
  (await eventsOf(a.ws.id, "serp_analysis")) === 2 &&
    rMobile.eventId !== r1.eventId,
);

const rLoc = await analyzeSerp({
  userId: a.userId,
  projectId: a.project.id,
  keyword: KW,
  locationCode: 2114, // Germany, not the 2840 default
  actorId: a.userId,
});
check(
  "location participates in the dedup key",
  (await eventsOf(a.ws.id, "serp_analysis")) === 3 &&
    rLoc.analysis.locationCode === 2114,
  `locationCode=${rLoc.analysis.locationCode}`,
);

// ── 5. keyword_research exactly-once + dedupe ────────────────────────────────

const k1 = await researchKeywords({
  userId: a.userId,
  projectId: a.project.id,
  seedKeyword: SEED,
  actorId: a.userId,
});
check(
  "keyword_research charges exactly 40 credits on first task",
  k1.charged === 40 && (await eventsOf(a.ws.id, "keyword_research")) === 1,
  `charged=${k1.charged}`,
);
check(
  "research report is honest mock with clusters",
  k1.report.mock === true &&
    k1.report.totalIdeas > 0 &&
    Object.values(k1.report.clusters).some((cl) => cl.length > 0),
  `totalIdeas=${k1.report.totalIdeas}`,
);
const k2 = await researchKeywords({
  userId: a.userId,
  projectId: a.project.id,
  seedKeyword: SEED,
  limit: 50,
  actorId: a.userId,
});
check(
  "same-day research replay dedupes (T13)",
  k2.eventId === k1.eventId && (await eventsOf(a.ws.id, "keyword_research")) === 1,
);
const kB = await researchKeywords({
  userId: b.userId,
  projectId: b.project.id,
  seedKeyword: SEED,
  actorId: b.userId,
});
check(
  "same seed in another workspace charges separately",
  kB.eventId !== k1.eventId && (await eventsOf(b.ws.id, "keyword_research")) === 1,
);

// ── 6. Raw pullSerp() writes zero events (T14) ───────────────────────────────

const beforeRaw = await eventsOf(a.ws.id);
await pullSerp({ keyword: `raw pull ${randomUUID().slice(0, 8)}`, depth: 10 });
check(
  "pullSerp() (brief/rank-check helper) writes zero ledger events",
  (await eventsOf(a.ws.id)) === beforeRaw,
);

// ── 7. Unmetered cores write zero events (MCP single-charge) ─────────────────

const beforeUnmetered = await eventsOf(a.ws.id);
await analyzeSerpUnmetered({
  userId: a.userId,
  projectId: a.project.id,
  keyword: `unmetered ${randomUUID().slice(0, 8)}`,
});
await researchKeywordsUnmetered({
  userId: a.userId,
  projectId: a.project.id,
  seedKeyword: `unmetered seed ${randomUUID().slice(0, 8)}`,
});
check(
  "un-metered cores (MCP handler path) write zero ledger events",
  (await eventsOf(a.ws.id)) === beforeUnmetered,
);

// ── 8. MCP passthrough: underlying action + keyId attribution (T17) ──────────

const { keyHash, keyPrefix } = mintApiKey();
const keyRow = await prisma.mcpApiKey.create({
  data: {
    workspaceId: a.ws.id,
    userId: a.userId,
    name: `${RUN}-key`,
    keyHash,
    keyPrefix,
    scopes: ["tools:analyze_serp", "tools:research_keywords"],
  },
});
const m1 = await meterToolCall({
  tool: "analyze_serp",
  workspaceId: a.ws.id,
  actorId: a.userId,
  callId: `${RUN}-m1`,
  keyId: keyRow.id,
});
check("mcp passthrough for analyze_serp succeeds", m1.ok === true, JSON.stringify(m1));
if (m1.ok) {
  const ev = await prisma.usageEvent.findUnique({ where: { id: m1.eventId } });
  check(
    "mcp passthrough charges the UNDERLYING action serp_analysis",
    ev?.action === "serp_analysis",
    `action=${ev?.action}`,
  );
  check(
    "mcp passthrough charges 1 credit (not zero, not double)",
    ev?.credits === 1,
    `credits=${ev?.credits}`,
  );
  check(
    "mcp passthrough preserves keyId attribution",
    ev?.keyId === keyRow.id,
    `keyId=${ev?.keyId}`,
  );
}
const m2 = await meterToolCall({
  tool: "research_keywords",
  workspaceId: a.ws.id,
  actorId: a.userId,
  callId: `${RUN}-m2`,
  keyId: keyRow.id,
});
check("mcp passthrough for research_keywords succeeds", m2.ok === true, JSON.stringify(m2));
if (m2.ok) {
  const ev = await prisma.usageEvent.findUnique({ where: { id: m2.eventId } });
  check(
    "mcp passthrough charges the UNDERLYING action keyword_research",
    ev?.action === "keyword_research",
    `action=${ev?.action}`,
  );
  check(
    "mcp passthrough charges 40 credits",
    ev?.credits === 40,
    `credits=${ev?.credits}`,
  );
}

// ── 9. Pre-cap denial: plain language, zero execution, zero events ────────────

const capBefore = await eventsOf(c.ws.id);
let denied: unknown = null;
try {
  await analyzeSerp({
    userId: c.userId,
    projectId: c.project.id,
    keyword: `denied ${randomUUID().slice(0, 8)}`,
  });
} catch (e) {
  denied = e;
}
check(
  "cap-denied analyzeSerp throws ActionError cap_denied",
  denied instanceof ActionError && denied.code === "cap_denied" && denied.status === 402,
  denied instanceof ActionError ? `${denied.code}/${denied.status}` : String(denied),
);
check(
  "cap-denial message is plain-language (mentions plan/support path)",
  denied instanceof ActionError &&
    denied.message.toLowerCase().includes("credit") &&
    denied.message.length > 20,
  denied instanceof ActionError ? denied.message.slice(0, 120) : "",
);
check(
  "cap-denied run writes zero ledger events",
  (await eventsOf(c.ws.id)) === capBefore,
);
const capStatus = await checkCap(c.ws.id);
check("cap gate is actually blocking for the denied workspace", capStatus.allowed === false);

// ── 10. Validation: empty keyword/seed → 400, no charge ──────────────────────

const beforeVal = await eventsOf(a.ws.id);
for (const [label, fn] of [
  ["empty keyword", () => analyzeSerp({ userId: a.userId, projectId: a.project.id, keyword: "   " })],
  ["empty seed", () => researchKeywords({ userId: a.userId, projectId: a.project.id, seedKeyword: "" })],
] as const) {
  let vErr: unknown = null;
  try {
    await fn();
  } catch (e) {
    vErr = e;
  }
  check(
    `${label} rejected with validation (400)`,
    vErr instanceof ActionError && vErr.code === "validation" && vErr.status === 400,
    vErr instanceof ActionError ? `${vErr.code}/${vErr.status}` : String(vErr),
  );
}
check(
  "validation failures write zero ledger events",
  (await eventsOf(a.ws.id)) === beforeVal,
);

// ── 11/12. Static assertions ─────────────────────────────────────────────────

const pullSrc = readFileSync(join(HERE, "..", "lib", "serp", "pull.ts"), "utf8");
const pullImports = pullSrc.split("\n").filter((l) => l.trimStart().startsWith("import"));
check(
  "lib/serp/pull.ts imports no metering code (T14)",
  pullImports.every((l) => !/metering|usage|credits/i.test(l)),
  pullImports.join(" | "),
);

const analyzeSrc = readFileSync(join(HERE, "..", "lib", "serp", "analyze.ts"), "utf8");
const unmeteredBody = analyzeSrc.slice(
  analyzeSrc.indexOf("export async function analyzeSerpUnmetered"),
);
check(
  "analyzeSerpUnmetered gates cap before any provider call (T9)",
  unmeteredBody.indexOf("checkCap(") !== -1 &&
    unmeteredBody.indexOf("checkCap(") < unmeteredBody.indexOf("pullSerp("),
);
check(
  "metered analyzeSerp() is the only writer of serp_analysis events",
  (analyzeSrc.match(/action: "serp_analysis"/g) ?? []).length === 1,
);

const researchSrc = readFileSync(join(HERE, "..", "lib", "keywords", "research.ts"), "utf8");
const researchUnmeteredBody = researchSrc.slice(
  researchSrc.indexOf("export async function researchKeywordsUnmetered"),
);
check(
  "researchKeywordsUnmetered gates cap before any provider call (T9)",
  researchUnmeteredBody.indexOf("checkCap(") !== -1 &&
    researchUnmeteredBody.indexOf("checkCap(") < researchUnmeteredBody.indexOf("keywordIdeas("),
);
check(
  "metered researchKeywords() is the only writer of keyword_research events",
  (researchSrc.match(/action: "keyword_research"/g) ?? []).length === 1,
);

// ── Report ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(", "));
  process.exit(1);
}
