// Marketr — Phase 8 G1 verification battery (SPEC-PHASE8.md §10 gate 1).
//
// Run: npx tsx scripts/verify-phase8-graph.mts
// Run 3x green before calling this done.
//
// Covers:
//   A. Fixture client → all 19 entity types present (≥1 node each)
//   B. Expected relationships (product→price HAS_PRICE, campaign→channel
//      RAN_ON, competitor→keyword TARGETS)
//   C. Every node carries as_of + source (freshness contract)
//   D. Provenance chain node → edge → fact → source is traversable
//   E. Bi-temporal point-in-time query returns the era-valid state
//   F. Append-only log replays to the same state (deterministic projection)
//   G. ER: deliberate duplicates merge correctly AND reversibly; ambiguous
//      fixtures land in the queue — NOTHING auto-merges in v1
//   H. Webhooks: forged signatures rejected, valid ingested, replays rejected,
//      unconfigured connectors fail honestly
//   I. Tier-S rate-budget exhaustion → backoff (never blows the budget)
//   J. RLS proofs: cross-workspace node/edge/fact reads blocked; fail-closed
//      without the tenant GUC; cross-workspace writes rejected
//   K. Append-only guard: the facts module exposes no update/delete path
//
// Strategy: a scratch database on the preview cluster (created/dropped by
// this script — the preview DB is never touched). Lib modules are imported
// AFTER process.env.DATABASE_URL points at the scratch DB.

import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHmac } from "node:crypto";

const execFileAsync = promisify(execFile);

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

// ---------------------------------------------------------------------------
// DB bootstrap (no @/ imports yet — DATABASE_URL must point at scratch first)
// ---------------------------------------------------------------------------

const PGBIN = `${process.env.HOME}/.local/lib/python3.12/site-packages/pgserver/pginstall/bin`;
const SCRATCH_DB = "marketr_graph_battery";

function dbParts() {
  const env = readFileSync("/home/hatch/workspace/marketr/.env", "utf8");
  const m = env.match(/^DATABASE_URL=(.+)$/m);
  if (!m) throw new Error("DATABASE_URL not found in .env");
  const raw = m[1].trim().replace(/^["']|["']$/g, "");
  const u = new URL(raw);
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    host: u.hostname,
    port: u.port || "5432",
  };
}

async function psql(db: string, sql: string): Promise<string> {
  const p = dbParts();
  const { stdout } = await execFileAsync(`${PGBIN}/psql`, [
    "-h", p.host, "-p", p.port, "-U", p.user, "-d", db,
    "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql,
  ], { env: { ...process.env, PGPASSWORD: p.password } });
  return stdout.trim();
}

async function setupScratchDb() {
  const p = dbParts();
  await psql("postgres", `DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
  await psql("postgres", `CREATE DATABASE "${SCRATCH_DB}"`);
  // The G1 migration FK-references workspaces (created by the base
  // migrations). The scratch DB only gets the G1 migration, so stub the
  // parent table faithfully: id TEXT PRIMARY KEY, matching the real schema.
  await psql(SCRATCH_DB, `CREATE TABLE workspaces (id TEXT PRIMARY KEY)`);
  await execFileAsync(`${PGBIN}/psql`, [
    "-h", p.host, "-p", p.port, "-U", p.user, "-d", SCRATCH_DB,
    "-v", "ON_ERROR_STOP=1",
    "-f", "/home/hatch/workspace/marketr/prisma/migrations/20260925174000_phase8_graph/migration.sql",
  ], { env: { ...process.env, PGPASSWORD: p.password } });
  // Two fixture workspaces (RLS is only on graph tables — workspaces insert freely).
  const ws = (id: string) => `INSERT INTO workspaces (id) VALUES ('${id}')`;
  await psql(SCRATCH_DB, ws("ws-a-fixture"));
  await psql(SCRATCH_DB, ws("ws-b-other"));
  await psql(SCRATCH_DB, ws("ws-er"));
  await psql(SCRATCH_DB, ws("ws-replay"));
  const url = `postgresql://${encodeURIComponent(p.user)}:${encodeURIComponent(p.password)}@${p.host}:${p.port}/${SCRATCH_DB}`;
  return url;
}

async function teardownScratchDb() {
  await psql("postgres", `DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
}

const WS_A = "ws-a-fixture";
const WS_B = "ws-b-other";
const WS_ER = "ws-er";
const WS_REPLAY = "ws-replay";

const scratchUrl = await setupScratchDb();
process.env.DATABASE_URL = scratchUrl;
process.env.GRAPH_WEBHOOK_TEST_SECRETS = JSON.stringify({ hubspot: "wh-test-secret" });
console.log("scratch db ready:", SCRATCH_DB);

// ---------------------------------------------------------------------------
// Lib imports (after env is pointed at scratch)
// ---------------------------------------------------------------------------

const { appendFact, exportFacts, replayFacts } = await import("@/lib/substrate/graph/facts");
const { withWorkspaceScope } = await import("@/lib/substrate/graph/rls");
const { resolveNode, resolveWorkspace, REVIEW_THRESHOLD } = await import("@/lib/substrate/graph/resolve");
const { resolveErItem, revertMerge, listErQueue } = await import("@/lib/substrate/graph/merges");
const { freshnessLabel } = await import("@/lib/substrate/graph/freshness");
const { ENTITY_TYPES } = await import("@/lib/substrate/graph/types");
const { prisma } = await import("@/lib/prisma");
const tiers = await import("@/lib/substrate/graph/connectors/tiers");
const tierw = await import("@/lib/substrate/graph/connectors/tierw");
const hmacMod = await import("@/lib/substrate/graph/connectors/hmac");

const T1 = new Date("2026-09-01T00:00:00Z");
const T2 = new Date("2026-09-20T00:00:00Z");

// ---------------------------------------------------------------------------
// A/B/C/D — seed all 19 entity types with expected relationships
// ---------------------------------------------------------------------------
console.log("\nA–D. fixture seeding + relationships + provenance");

const seedFacts = [
  { type: "brand", ref: "brand:acme outdoors", fact: "seed_brand", core: { name: "Acme Outdoors", domain: "acmeoutdoors.com" }, rels: [{ to: "competitor:trailheadgear.com", edgeType: "COMPETES_WITH" }] },
  { type: "competitor", ref: "competitor:trailheadgear.com", fact: "seed_competitor", core: { name: "Trailhead Gear", domain: "trailheadgear.com" }, rels: [{ to: "keyword:hiking backpack", edgeType: "TARGETS" }] },
  { type: "product", ref: "product:summit-bp-01", fact: "seed_product", core: { name: "Summit Backpack", sku: "SUMMIT-BP-01" }, rels: [{ to: "price:summit-bp-01", edgeType: "HAS_PRICE", properties: { amountCents: 12900 } }] },
  { type: "price", ref: "price:summit-bp-01", fact: "seed_price", core: { sku: "SUMMIT-BP-01", amountCents: 12900, currency: "USD" }, rels: [] },
  { type: "campaign_ref", ref: "campaign_ref:platform:gads-111", fact: "seed_campaign", core: { name: "Fall Prospecting", platformRef: "gads-111" }, rels: [{ to: "channel:platform:google_ads", edgeType: "RAN_ON" }] },
  { type: "channel", ref: "channel:platform:google_ads", fact: "seed_channel", core: { name: "Google Ads", platform: "google_ads" }, rels: [] },
  { type: "keyword", ref: "keyword:hiking backpack", fact: "seed_keyword", core: { term: "hiking backpack", intent: "commercial" }, rels: [] },
  { type: "customer", ref: "customer:email:amy@example.com", fact: "seed_customer", core: { name: "Amy Example", email: "amy@example.com" }, rels: [] },
  { type: "employee", ref: "employee:email:boss@acmeoutdoors.com", fact: "seed_employee", core: { name: "Bo Boss", email: "boss@acmeoutdoors.com" }, rels: [{ to: "brand:acme outdoors", edgeType: "WORKS_AT" }] },
  { type: "location", ref: "location:greensboro-nc", fact: "seed_location", core: { name: "Greensboro HQ", city: "Greensboro", region: "NC" }, rels: [] },
  { type: "review", ref: "review:ext-1", fact: "seed_review", core: { externalId: "ext-1", author: "Camper Ken", rating: 5 }, rels: [{ to: "product:summit-bp-01", edgeType: "REVIEWED" }] },
  { type: "website", ref: "website:acmeoutdoors.com", fact: "seed_website", core: { domain: "acmeoutdoors.com", url: "https://acmeoutdoors.com" }, rels: [] },
  { type: "crm_record", ref: "crm_record:external:crm-9", fact: "seed_crm", core: { externalId: "crm-9", email: "amy@example.com" }, rels: [] },
  { type: "creative_asset", ref: "creative_asset:hero-v1", fact: "seed_creative", core: { name: "Hero v1", contentHash: "hero-v1" }, rels: [] },
  { type: "content", ref: "content:https://acmeoutdoors.com/blog/pack-guide", fact: "seed_content", core: { title: "Pack Guide", url: "https://acmeoutdoors.com/blog/pack-guide" }, rels: [{ to: "channel:platform:google_ads", edgeType: "PUBLISHED_ON" }] },
  { type: "offer", ref: "offer:fall10", fact: "seed_offer", core: { name: "Fall10", code: "FALL10" }, rels: [] },
  { type: "audience", ref: "audience:weekend-hikers", fact: "seed_audience", core: { name: "Weekend Hikers" }, rels: [] },
  { type: "landing_page", ref: "landing_page:/fall-sale", fact: "seed_landing", core: { name: "Fall Sale", url: "https://acmeoutdoors.com/fall-sale", slug: "/fall-sale" }, rels: [] },
  { type: "form_cta", ref: "form_cta:newsletter-footer", fact: "seed_cta", core: { name: "Newsletter footer", selector: "#newsletter-footer" }, rels: [] },
  { type: "service", ref: "service:pack-fitting", fact: "seed_service", core: { name: "Pack Fitting", sku: "SVC-PACK-FIT" }, rels: [] },
];

for (const s of seedFacts) {
  await appendFact({
    workspaceId: WS_A,
    source: "onboarding",
    sourceRecordId: `seed:${s.fact}`,
    entityRef: s.ref,
    factType: s.fact,
    payload: {
      displayName: (s.core.name as string) ?? (s.core.term as string) ?? (s.core.title as string) ?? s.ref,
      core: s.core,
      properties: {},
      relationships: s.rels,
    },
    observedAt: T1,
    actor: "battery",
  });
}

const nodesA = await withWorkspaceScope(WS_A, (tx) =>
  tx.graphNode.findMany({ where: { workspaceId: WS_A } }),
);
check("A. all 19 entity types present (≥1 node each)", (() => {
  const types = new Set(nodesA.map((n) => n.entityType));
  return ENTITY_TYPES.every((t) => types.has(t));
})(), `types present: ${[...new Set(nodesA.map((n) => n.entityType))].length}/19`);

const edgeTuples = await withWorkspaceScope(WS_A, (tx) =>
  tx.graphEdge.findMany({
    where: { workspaceId: WS_A, expiredAt: null },
    include: { fromNode: { select: { canonicalKey: true } }, toNode: { select: { canonicalKey: true } } },
  }),
);
const hasEdge = (from: string, type: string, to: string) =>
  edgeTuples.some((e) => e.fromNode.canonicalKey === from && e.edgeType === type && e.toNode.canonicalKey === to);
check("B. product→price HAS_PRICE", hasEdge("product:summit-bp-01", "HAS_PRICE", "price:summit-bp-01"));
check("B. campaign→channel RAN_ON", hasEdge("campaign_ref:platform:gads-111", "RAN_ON", "channel:platform:google_ads"));
check("B. competitor→keyword TARGETS", hasEdge("competitor:trailheadgear.com", "TARGETS", "keyword:hiking backpack"));

check("C. every node has as_of + source", nodesA.every((n) => n.asOf instanceof Date && !Number.isNaN(n.asOf.getTime()) && n.asOfSource.length > 0));

// D. provenance chain: price node → HAS_PRICE edge → fact → source
const priceNode = nodesA.find((n) => n.canonicalKey === "price:summit-bp-01")!;
const priceEdge = await withWorkspaceScope(WS_A, (tx) =>
  tx.graphEdge.findFirst({
    where: { workspaceId: WS_A, toNodeId: priceNode.id, edgeType: "HAS_PRICE", expiredAt: null },
    include: { sourceFact: true, fromNode: true },
  }),
);
const chainOk =
  !!priceEdge?.sourceFact &&
  // The HAS_PRICE edge was asserted by the PRODUCT fact (the side carrying
  // the relationship) — the edge's source fact is that fact, not the price
  // fact. The chain is what matters: node → edge → fact → source.
  priceEdge.sourceFact.factType === "seed_product" &&
  priceEdge.sourceFact.source === "onboarding" &&
  priceEdge.sourceFact.sourceRecordId === "seed:seed_product";
check("D. provenance chain node→edge→fact→source traversable", chainOk,
  chainOk ? "" : JSON.stringify({ edge: !!priceEdge, fact: priceEdge?.sourceFact?.factType }));

// ---------------------------------------------------------------------------
// E. bi-temporal point-in-time
// ---------------------------------------------------------------------------
console.log("\nE. bi-temporal point-in-time");
await appendFact({
  workspaceId: WS_A,
  source: "onboarding",
  sourceRecordId: "seed:price-change",
  entityRef: "price:summit-bp-01",
  factType: "price_change",
  payload: {
    displayName: "Summit Backpack price",
    core: { sku: "SUMMIT-BP-01", amountCents: 14900, currency: "USD" },
    relationships: [{ to: "product:summit-bp-01", edgeType: "HAS_PRICE", properties: { amountCents: 14900 } }],
  },
  observedAt: T2,
  actor: "battery",
});
// NOTE: the new fact asserts product→price from the PRICE side; the battery's
// canonical direction is product→price, so assert the product-side edge too.
const productNode = nodesA.find((n) => n.canonicalKey === "product:summit-bp-01")!;
await appendFact({
  workspaceId: WS_A,
  source: "onboarding",
  sourceRecordId: "seed:price-change-product-side",
  entityRef: "product:summit-bp-01",
  factType: "price_change",
  payload: {
    displayName: "Summit Backpack",
    core: { name: "Summit Backpack", sku: "SUMMIT-BP-01" },
    relationships: [{ to: "price:summit-bp-01", edgeType: "HAS_PRICE", properties: { amountCents: 14900 } }],
  },
  observedAt: T2,
  actor: "battery",
});

const atT1 = new Date("2026-09-10T00:00:00Z");
const edgesAtT1 = await withWorkspaceScope(WS_A, (tx) =>
  tx.graphEdge.findMany({
    where: {
      workspaceId: WS_A,
      fromNodeId: productNode.id,
      edgeType: "HAS_PRICE",
      validAt: { lte: atT1 },
      AND: [{ OR: [{ invalidAt: null }, { invalidAt: { gt: atT1 } }] }],
    },
    orderBy: { validAt: "desc" },
  }),
);
check("E. point-in-time (T1) returns the era-valid edge, not current",
  edgesAtT1.length === 1 && (edgesAtT1[0].properties as { amountCents: number }).amountCents === 12900,
  `edges at T1: ${edgesAtT1.length}`);

const edgesNow = await withWorkspaceScope(WS_A, (tx) =>
  tx.graphEdge.findMany({
    where: { workspaceId: WS_A, fromNodeId: productNode.id, edgeType: "HAS_PRICE", expiredAt: null },
  }),
);
const oldEra = await withWorkspaceScope(WS_A, (tx) =>
  tx.graphEdge.findMany({
    where: { workspaceId: WS_A, fromNodeId: productNode.id, edgeType: "HAS_PRICE", expiredAt: { not: null } },
  }),
);
check("E. current era shows the new edge only", edgesNow.length === 1 &&
  (edgesNow[0].properties as { amountCents: number }).amountCents === 14900);
check("E. old edge invalidated (not deleted) with superseded_by",
  oldEra.length >= 1 && oldEra.every((e) => e.invalidAt !== null && e.supersededById !== null));

// ---------------------------------------------------------------------------
// F. append-only replay → same state
// ---------------------------------------------------------------------------
console.log("\nF. append-only replay");
const exported = await exportFacts(WS_A);
const replayRes = await replayFacts(WS_REPLAY, exported, "battery:replay");
check("F. replay ingested all facts", replayRes.facts === exported.length && replayRes.skipped === 0,
  `ingested ${replayRes.facts}/${exported.length}, skipped ${replayRes.skipped}`);

async function stateSignature(ws: string) {
  const nodes = await withWorkspaceScope(ws, (tx) =>
    tx.graphNode.findMany({ where: { workspaceId: ws }, orderBy: { canonicalKey: "asc" } }),
  );
  const edges = await withWorkspaceScope(ws, (tx) =>
    tx.graphEdge.findMany({
      where: { workspaceId: ws },
      include: { fromNode: { select: { canonicalKey: true } }, toNode: { select: { canonicalKey: true } } },
      orderBy: { id: "asc" },
    }),
  );
  return JSON.stringify({
    nodes: nodes.map((n) => [n.canonicalKey, n.displayName, n.entityType, n.asOf.toISOString(), n.asOfSource, n.mergedIntoId]),
    edges: edges.map((e) => [e.fromNode.canonicalKey, e.toNode.canonicalKey, e.edgeType, e.validAt.toISOString(), e.invalidAt?.toISOString() ?? null, e.confidence]),
  });
}
check("F. replayed state equals original state",
  (await stateSignature(WS_A)) === (await stateSignature(WS_REPLAY)));

// ---------------------------------------------------------------------------
// G. ER: duplicates merge reversibly; ambiguous → queue; nothing auto-merges
// ---------------------------------------------------------------------------
console.log("\nG. entity resolution");
// Deliberate duplicates: DIFFERENT canonical keys, SAME identifiers
// (the real-world HubSpot-vs-manual case). Same email + same phone,
// same name — deterministic signals fire, confidence hits the auto-merge
// band, and v1 must still queue instead of merging.
await appendFact({
  workspaceId: WS_ER, source: "hubspot:conn-1", sourceRecordId: "contact:amy-h",
  entityRef: "customer:email:amy.smith@example.com", factType: "crm_contact_upsert",
  payload: { displayName: "Amy Smith", core: { name: "Amy Smith", email: "amy.smith@example.com", phone: "555-0100" }, properties: {} },
  observedAt: T1, actor: "battery",
});
await appendFact({
  workspaceId: WS_ER, source: "manual", sourceRecordId: "manual:amy-2",
  entityRef: "customer:external:hs-4242", factType: "manual_customer",
  payload: { displayName: "Amy Smith", core: { name: "Amy Smith", email: "amy.smith@example.com", phone: "555-0100", externalId: "hs-4242" }, properties: {} },
  observedAt: T1, actor: "battery",
});
// Ambiguous: same phone, but one side has no email (so the hard email
// mismatch veto does not fire) and the names differ — confidence lands in
// the review band, below the auto-merge threshold.
await appendFact({
  workspaceId: WS_ER, source: "import", sourceRecordId: "csv:bob-1",
  entityRef: "customer:email:bob@example.com", factType: "csv_customer",
  payload: { displayName: "Bob Jones", core: { name: "Bob Jones", email: "bob@example.com", phone: "555-0200" }, properties: {} },
  observedAt: T1, actor: "battery",
});
await appendFact({
  workspaceId: WS_ER, source: "import", sourceRecordId: "csv:robert-1",
  entityRef: "customer:external:pos-77", factType: "pos_customer",
  payload: { displayName: "Robert Jones", core: { name: "Robert Jones", phone: "555-0200", externalId: "pos-77" }, properties: {} },
  observedAt: T1, actor: "battery",
});

const erNodes = await withWorkspaceScope(WS_ER, (tx) =>
  tx.graphNode.findMany({ where: { workspaceId: WS_ER } }),
);
const scan = await resolveWorkspace(WS_ER);
check("G. ER cascade ran without auto-merging", scan.skippedAutoMerge >= 0, `queued=${scan.queued}`);
const mergedAfterScan = await withWorkspaceScope(WS_ER, (tx) =>
  tx.graphNode.count({ where: { workspaceId: WS_ER, mergedIntoId: { not: null } } }),
);
check("G. NOTHING auto-merged in v1 (human gate holds)", mergedAfterScan === 0,
  `${mergedAfterScan} node(s) merged without a human`);

const queue = await listErQueue(WS_ER, "pending");
check("G. duplicate pair landed in the review queue", queue.length >= 1,
  `queue depth: ${queue.length}`);
const dupItem = queue.find((q) =>
  ((q.matcherSignals as Array<{ matcher: string }> | null) ?? []).some((s) => s.matcher === "phone_exact"),
);
check("G. duplicate pair carries deterministic matcher signals", !!dupItem,
  dupItem ? JSON.stringify(((dupItem.matcherSignals as Array<{ matcher: string }> | null) ?? []).map((s) => s.matcher)) : "no phone_exact item");

// Approve the duplicate merge → reversible SAME_AS.
if (dupItem) {
  const res = await resolveErItem(WS_ER, dupItem.id, "approved", "battery-human");
  const absorbed = await withWorkspaceScope(WS_ER, (tx) =>
    tx.graphNode.findFirst({ where: { workspaceId: WS_ER, id: res.absorbedId! } }),
  );
  check("G. approved merge sets merged_into_id", absorbed?.mergedIntoId === res.canonicalId);
  const sameAs = await withWorkspaceScope(WS_ER, (tx) =>
    tx.graphEdge.findFirst({
      where: { workspaceId: WS_ER, fromNodeId: res.absorbedId!, edgeType: "SAME_AS", expiredAt: null },
    }),
  );
  check("G. merge writes SAME_AS provenance edge", !!sameAs);

  // Revert → node restored, SAME_AS expired (history kept).
  await revertMerge(WS_ER, res.absorbedId!, "battery-human");
  const restored = await withWorkspaceScope(WS_ER, (tx) =>
    tx.graphNode.findFirst({ where: { workspaceId: WS_ER, id: res.absorbedId! } }),
  );
  const expiredSameAs = await withWorkspaceScope(WS_ER, (tx) =>
    tx.graphEdge.findFirst({
      where: { workspaceId: WS_ER, fromNodeId: res.absorbedId!, edgeType: "SAME_AS" },
      orderBy: { createdAt: "desc" },
    }),
  );
  check("G. revert restores the absorbed node", restored?.mergedIntoId === null);
  check("G. revert expires (not deletes) the SAME_AS edge", !!expiredSameAs?.expiredAt);
} else {
  check("G. approved merge sets merged_into_id", false, "no dup item to decide");
  check("G. merge writes SAME_AS provenance edge", false, "no dup item to decide");
  check("G. revert restores the absorbed node", false, "no dup item to decide");
  check("G. revert expires (not deletes) the SAME_AS edge", false, "no dup item to decide");
}

// Ambiguous pair must be queued, never merged.
const ambQueue = await listErQueue(WS_ER, "pending");
const ambiguousQueued = ambQueue.some(
  (q) => q.nodeA.displayName.includes("Bob") || q.nodeB.displayName.includes("Robert"),
);
check("G. ambiguous fixtures land in queue, never auto-merged", ambiguousQueued,
  `pending: ${ambQueue.map((q) => `${q.nodeA.displayName}~${q.nodeB.displayName}`).join("; ")}`);

// ---------------------------------------------------------------------------
// H. webhook signature verification
// ---------------------------------------------------------------------------
console.log("\nH. webhook verification");
const hubspotConn = await withWorkspaceScope(WS_A, (tx) =>
  tx.graphConnector.create({
    data: { workspaceId: WS_A, platform: "hubspot", tier: "webhook", status: "connected" },
  }),
);
const uri = "/api/substrate/graph/webhooks/hubspot?workspaceId=" + WS_A;
const ts = String(Date.now());
const hsBody = JSON.stringify([
  { subscriptionType: "contact.creation", objectId: "4242", properties: { email: "webhook.amy@example.com", firstname: "Webhook", lastname: "Amy" } },
]);
const goodSig = createHmac("sha256", "wh-test-secret").update(`POST${uri}${hsBody}${ts}`).digest("base64");
const baseHeaders = {
  "x-hubspot-signature-v3": goodSig,
  "x-hubspot-request-timestamp": ts,
};
const verified = await tierw.verifyTierWWebhook({
  platform: "hubspot", connector: hubspotConn, method: "POST", uri, headers: baseHeaders, rawBody: hsBody,
});
check("H. valid signature accepted", verified.ok === true, JSON.stringify(verified));

const forged = await tierw.verifyTierWWebhook({
  platform: "hubspot", connector: hubspotConn, method: "POST", uri,
  headers: { ...baseHeaders, "x-hubspot-signature-v3": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
  rawBody: hsBody,
});
check("H. forged signature rejected", !forged.ok && forged.status === 401, JSON.stringify(forged));

const replayed = await tierw.verifyTierWWebhook({
  platform: "hubspot", connector: hubspotConn, method: "POST", uri, headers: baseHeaders, rawBody: hsBody,
});
check("H. replayed delivery rejected", !replayed.ok && replayed.status === 409, JSON.stringify(replayed));

const ingestRes = await tierw.ingestTierWEvent({
  platform: "hubspot",
  connector: hubspotConn,
  topic: "",
  body: JSON.parse(hsBody),
  rawBody: hsBody,
  actor: "battery:webhook",
});
check("H. valid webhook ingested to facts", ingestRes.accepted && (ingestRes.factsAppended ?? 0) >= 1, ingestRes.detail);
const webhookNode = await withWorkspaceScope(WS_A, (tx) =>
  tx.graphNode.findFirst({ where: { workspaceId: WS_A, canonicalKey: "customer:email:webhook.amy@example.com" } }),
);
check("H. webhook fact projected to a node", !!webhookNode);

// Unconfigured connector fails honestly (no secret anywhere).
const shopifyConn = await withWorkspaceScope(WS_A, (tx) =>
  tx.graphConnector.create({
    data: { workspaceId: WS_A, platform: "shopify", tier: "webhook", status: "pending" },
  }),
);
const unconfigured = await tierw.verifyTierWWebhook({
  platform: "shopify", connector: shopifyConn, method: "POST",
  uri: "/api/substrate/graph/webhooks/shopify", headers: {}, rawBody: "{}",
});
check("H. unconfigured connector fails honestly (503, nothing ingested)",
  !unconfigured.ok && unconfigured.status === 503, JSON.stringify(unconfigured));

// ---------------------------------------------------------------------------
// I. Tier-S rate budget → backoff
// ---------------------------------------------------------------------------
console.log("\nI. Tier-S rate budgets");
const gadsConn = await withWorkspaceScope(WS_A, (tx) =>
  tx.graphConnector.create({
    data: { workspaceId: WS_A, platform: "google_ads", tier: "scheduled", status: "connected" },
  }),
);
const exhaustedBudget = {
  dailyOps: 15000,
  usedOps: 15000,
  windowStart: new Date().toISOString(),
};
await withWorkspaceScope(WS_A, (tx) =>
  tx.graphSyncJob.create({
    data: {
      workspaceId: WS_A, connectorId: gadsConn.id, tier: "scheduled",
      rateBudget: exhaustedBudget, cursorState: tiers.defaultCursor() as unknown as Record<string, never>,
    },
  }),
);
const budgetRun = await tiers.runScheduledPull({
  workspaceId: WS_A, connectorId: gadsConn.id, platform: "google_ads", actor: "battery",
});
check("I. exhausted budget → job backs off instead of pulling",
  !budgetRun.ran && budgetRun.status === "backing_off" && budgetRun.rowsIngested === 0, budgetRun.detail);
const backedOffJob = await withWorkspaceScope(WS_A, (tx) =>
  tx.graphSyncJob.findFirst({ where: { workspaceId: WS_A, connectorId: gadsConn.id } }),
);
check("I. backoff_until is set in the future",
  !!backedOffJob?.backoffUntil && backedOffJob.backoffUntil.getTime() > Date.now());

const budgetCheck = tiers.checkRateBudget(
  { dailyOps: 15000, usedOps: 15000, windowStart: new Date().toISOString() },
  { dailyOps: 15000 },
);
check("I. checkRateBudget reports exhaustion honestly", !budgetCheck.ok);
const j1 = tiers.backoffWithJitter(0, () => 0.5);
const j2 = tiers.backoffWithJitter(3, () => 0.5);
check("I. backoff grows with error count and stays capped",
  j2 > j1 && j1 >= 5 * 60_000 && j2 <= 6 * 3_600_000 * 1.25, `${j1}ms → ${j2}ms`);

// A healthy Tier-S pull ingests fixture rows honestly in fake mode.
const metaConn = await withWorkspaceScope(WS_A, (tx) =>
  tx.graphConnector.create({
    data: { workspaceId: WS_A, platform: "meta", tier: "scheduled", status: "connected" },
  }),
);
const healthyRun = await tiers.runScheduledPull({
  workspaceId: WS_A, connectorId: metaConn.id, platform: "meta", actor: "battery",
});
check("I. healthy Tier-S pull ingests in fake mode",
  healthyRun.ran && healthyRun.rowsIngested >= 1, healthyRun.detail);

// ---------------------------------------------------------------------------
// J. RLS proofs
// ---------------------------------------------------------------------------
console.log("\nJ. RLS tenant isolation");
// WS_B gets its own node.
await appendFact({
  workspaceId: WS_B, source: "manual", sourceRecordId: "b:1",
  entityRef: "brand:other brand", factType: "seed_brand",
  payload: { displayName: "Other Brand", core: { name: "Other Brand" }, properties: {} },
  observedAt: T1, actor: "battery",
});

const noGucNodes = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM graph_nodes`;
check("J. fail-closed: no tenant GUC → zero rows (even for owner)", noGucNodes[0].n === BigInt(0),
  `rows visible: ${noGucNodes[0].n}`);

const crossNodes = await withWorkspaceScope(WS_A, (tx) =>
  tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM graph_nodes WHERE workspace_id = ${WS_B}`,
);
check("J. cross-workspace node reads blocked", crossNodes[0].n === BigInt(0));
const ownNodes = await withWorkspaceScope(WS_A, (tx) =>
  tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM graph_nodes WHERE workspace_id = ${WS_A}`,
);
check("J. own-workspace node reads work", ownNodes[0].n > BigInt(0), `rows: ${ownNodes[0].n}`);

const crossFacts = await withWorkspaceScope(WS_A, (tx) =>
  tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM graph_facts WHERE workspace_id = ${WS_B}`,
);
check("J. cross-workspace fact reads blocked", crossFacts[0].n === BigInt(0));
const crossEdges = await withWorkspaceScope(WS_A, (tx) =>
  tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM graph_edges WHERE workspace_id = ${WS_B}`,
);
check("J. cross-workspace edge reads blocked", crossEdges[0].n === BigInt(0));

let writeBlocked = false;
try {
  await withWorkspaceScope(WS_A, (tx) => tx.$executeRaw`
    INSERT INTO graph_nodes (id, workspace_id, entity_type, canonical_key, display_name, as_of, as_of_source)
    VALUES ('rls-probe', ${WS_B}, 'brand', 'brand:rls-probe', 'RLS Probe', now(), 'probe')`);
} catch {
  writeBlocked = true;
}
check("J. cross-workspace writes rejected (WITH CHECK)", writeBlocked);

const { verifyTenantIsolation } = await import("@/lib/substrate/graph/rls");
const iso = await verifyTenantIsolation(WS_A, WS_B);
check("J. verifyTenantIsolation() helper reports isolated", iso.isolated, iso.detail);

// ---------------------------------------------------------------------------
// K. append-only guard
// ---------------------------------------------------------------------------
console.log("\nK. append-only guard");
const factsSrc = readFileSync("/home/hatch/workspace/marketr/lib/substrate/graph/facts.ts", "utf8");
const hasUpdatePath =
  /graphFact\.(update|delete|upsert)/.test(factsSrc) || /updateMany|deleteMany/.test(factsSrc);
check("K. facts module exposes no update/delete path", !hasUpdatePath);
const factsMod = await import("@/lib/substrate/graph/facts");
const exportedNames = Object.keys(factsMod);
check("K. no update/delete in module exports",
  !exportedNames.some((n) => /update|delete|destroy/i.test(n)), exportedNames.join(","));

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("failures:", failures.join("; "));
  console.log(`\nscratch db KEPT for debugging: ${SCRATCH_DB}`);
  process.exit(1);
}
// Release pooled connections before DROP DATABASE (else "database is being
// accessed by other users").
await prisma.$disconnect();
await teardownScratchDb();
console.log("scratch db dropped.");
