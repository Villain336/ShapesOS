// ShapesOS — Dataset Builder slices 3–4 follow-through against Postgres
// (Phase 4b): version rollback / roll-forward, OS grounding across published
// datasets (chat + MCP), BriefNow live MCP pull, staleness alerts that fire
// once per version, record search.
// Run: DATABASE_URL=… npx tsx --test lib/datasetbuilder/__tests__/datasets-activate-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

delete process.env.BRIEFNOW_ADAPTERS_ROOT; // MCP pull only: no file drop in tests

import { prisma } from "../../prisma";
import { PrismaDatasetBuilderStore } from "../prisma-store";
import { ingestPaste } from "../ingest";
import { compileDataset } from "../build";
import {
  askPublishedDatasets,
  getLiveBriefNowPackage,
  getPublishStatus,
  publishDataset,
} from "../activate";
import { sweepDatasetStaleness } from "../stale-sweep";
import { DatasetBuilderError, type DatasetType } from "../types";
import { getTool } from "../../mcp/tools";
import type { McpAuthContext } from "../../mcp/auth";
import { searchRecords } from "../../search/records";
import type { TriggerInput } from "../../alerts/evaluate";

const store = new PrismaDatasetBuilderStore(prisma);
const OWNER = "p4b-datasets-owner";
const WS = `p4b-ds-${Date.now()}`;
const OTHER = `p4b-ds-other-${Date.now()}`;

async function seed(ws: string, entries: { text: string; type: DatasetType }[], label = "seed") {
  for (const [i, e] of entries.entries()) {
    const r = await ingestPaste(store, { workspaceId: ws, label: `${label}-${i}`, text: e.text });
    const chunks = await store.listChunksByDocument(r.document.id);
    await store.upsertClassification({
      workspaceId: ws,
      chunkId: chunks[0]!.id,
      datasetType: e.type,
      confidence: 0.9,
      engine: "rules",
      engineVersion: "rules-v1",
      status: "applied",
    });
  }
}

async function code(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof DatasetBuilderError ? e.code : `other:${String(e)}`;
  }
}

function mcpCtx(workspaceId: string): McpAuthContext {
  return { workspaceId, credential: { kind: "api_key", keyId: "k", keyPrefix: "mk_" }, scopes: [], userId: OWNER };
}

let pricingId = "";
let faqId = "";

before(async () => {
  for (const id of [WS, OTHER]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: OWNER } });
  await prisma.workspace.create({ data: { id: OTHER, name: OTHER, ownerUserId: OWNER } });
  await seed(WS, [
    { text: "The Starter plan costs $29 per month and includes two seats.", type: "pricing" },
    { text: "Refunds are available within 30 days of purchase for annual plans.", type: "faq" },
  ]);
  pricingId = (await compileDataset(store, WS, "pricing")).dataset.id;
  faqId = (await compileDataset(store, WS, "faq")).dataset.id;
  await seed(WS, [{ text: "The Growth plan costs $99 per month with unlimited projects.", type: "pricing" }], "more");
  await compileDataset(store, WS, "pricing"); // pricing v2
  await seed(OTHER, [{ text: "Zephyrine secret pricing: $1 forever.", type: "pricing" }], "other");
  await compileDataset(store, OTHER, "pricing");
});

after(async () => {
  for (const id of [WS, OTHER]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("publish: rollback and roll-forward (db)", () => {
  it("latest by default; an older version becomes live; republishing the live one is a no-op", async () => {
    const first = await publishDataset(store, { workspaceId: WS, datasetId: pricingId, target: "rag" });
    assert.equal(first.record.version, 2);
    assert.equal(first.rollback, false);
    assert.equal(first.alreadyLive, false);

    const back = await publishDataset(store, { workspaceId: WS, datasetId: pricingId, target: "rag", version: 1 });
    assert.equal(back.record.version, 1);
    assert.equal(back.rollback, true);
    assert.equal((await store.getLatestPublishRecord(pricingId, "rag"))!.version, 1);
    const status = await getPublishStatus(store, WS, pricingId);
    const rag = status.targets.find((t) => t.target === "rag")!;
    assert.equal(rag.version, 1);
    assert.equal(rag.stale, true); // v2 is compiled but not live

    const again = await publishDataset(store, { workspaceId: WS, datasetId: pricingId, target: "rag", version: 1 });
    assert.equal(again.alreadyLive, true);
    assert.equal(again.record.id, back.record.id);

    const forward = await publishDataset(store, { workspaceId: WS, datasetId: pricingId, target: "rag" });
    assert.equal(forward.record.version, 2);
    assert.equal(forward.record.id, first.record.id); // same (target, version) row, now live again
    assert.equal((await store.getLatestPublishRecord(pricingId, "rag"))!.version, 2);
    assert.equal(await prisma.datasetPublish.count({ where: { datasetId: pricingId, target: "rag" } }), 2);
  });

  it("rejects unknown versions and foreign datasets", async () => {
    assert.equal(
      await code(publishDataset(store, { workspaceId: WS, datasetId: pricingId, target: "rag", version: 9 })),
      "UNKNOWN_DATASET_VERSION",
    );
    assert.equal(await code(publishDataset(store, { workspaceId: OTHER, datasetId: pricingId, target: "rag" })), "UNKNOWN_DATASET");
  });
});

describe("OS grounding across published datasets (db)", () => {
  it("searches only datasets live on RAG, cites lineage, refuses to guess", async () => {
    // faq is compiled but not published: not searched yet.
    const before = await askPublishedDatasets(store, WS, "refunds annual plans");
    assert.equal(before.grounded, false);
    assert.deepEqual(before.searched.map((s) => s.type), ["pricing"]);

    await publishDataset(store, { workspaceId: WS, datasetId: faqId, target: "rag" });
    const res = await askPublishedDatasets(store, WS, "Are refunds available for annual plans?");
    assert.equal(res.grounded, true);
    assert.equal(res.citations[0]!.datasetType, "faq");
    assert.match(res.citations[0]!.sourceName, /seed-1/);
    assert.ok(res.citations[0]!.documentId && res.citations[0]!.chunkId);

    const none = await askPublishedDatasets(store, WS, "quantum blockchain llamas");
    assert.equal(none.grounded, false);
    assert.equal(none.citations.length, 0);

    // The other workspace never sees this workspace's data.
    const other = await askPublishedDatasets(store, OTHER, "refunds annual plans");
    assert.equal(other.grounded, false);
    assert.deepEqual(other.searched, []);
  });

  it("MCP ask_business_data answers from the caller's workspace only", async () => {
    const tool = getTool("ask_business_data")!;
    const out = await tool.handler(mcpCtx(WS), { question: "How much is the Growth plan per month?" });
    const data = out.data as { grounded: boolean; answer: string };
    assert.equal(data.grounded, true);
    assert.match(data.answer, /\$99/);
    const foreign = await tool.handler(mcpCtx(OTHER), { question: "How much is the Growth plan per month?" });
    assert.doesNotMatch(JSON.stringify(foreign.data), /\$99/);
  });
});

describe("BriefNow live pull (db)", () => {
  it("publishes as an MCP pull ref and serves the live package with lineage, paged", async () => {
    const pub = await publishDataset(store, { workspaceId: WS, datasetId: pricingId, target: "briefnow" });
    assert.equal(pub.record.artifactRef, "mcp://get_dataset_adapter?type=pricing&version=2");
    const live = await getLiveBriefNowPackage(store, WS, "pricing", { limit: 1 });
    assert.ok(live);
    assert.equal(live.package.contract, "briefnow-dataset-adapter/v1");
    assert.equal(live.package.datasetVersion, 2);
    assert.equal(live.page.total, 2);
    assert.equal(live.package.entries.length, 1);
    assert.equal(live.page.nextOffset, 1);
    const e = live.package.entries[0]!;
    assert.ok(e.sourceId && e.documentId && e.chunkId && e.classification.engine);

    // Rollback is reflected immediately in the pull.
    await publishDataset(store, { workspaceId: WS, datasetId: pricingId, target: "briefnow", version: 1 });
    const rolled = await getLiveBriefNowPackage(store, WS, "pricing");
    assert.equal(rolled!.package.datasetVersion, 1);
    assert.equal(rolled!.page.total, 1);

    // MCP tool: tenant-scoped, and unpublished types are a clear error.
    const tool = getTool("get_dataset_adapter")!;
    const out = await tool.handler(mcpCtx(WS), { type: "pricing" });
    assert.equal((out.data as { package: { datasetVersion: number } }).package.datasetVersion, 1);
    await assert.rejects(() => tool.handler(mcpCtx(OTHER), { type: "pricing" }), /not been published/);
    await assert.rejects(() => tool.handler(mcpCtx(WS), { type: "policy" }), /not been published/);
  });
});

describe("staleness alerts (db)", () => {
  it("fires once per compiled version, re-arms after a recompile", async () => {
    const old = new Date(Date.now() - 200 * 86_400_000);
    await prisma.datasetChunk.updateMany({ where: { workspaceId: WS }, data: { createdAt: old } });
    const alerts: TriggerInput[] = [];
    const emitAlert = async (i: TriggerInput) => {
      alerts.push(i);
    };

    const first = await sweepDatasetStaleness(prisma, WS, { emitAlert, staleAfterDays: 90 });
    assert.deepEqual(first.fired.map((f) => f.type).sort(), ["faq", "pricing"]);
    assert.ok(first.fired.every((f) => f.ageDays >= 199));
    assert.match(first.fired.find((f) => f.type === "pricing")!.message, /^Your pricing dataset is \d+ days old$/);
    assert.equal(alerts.length, 2);
    assert.ok(alerts.every((a) => a.trigger === "dataset_stale" && a.link === "/dashboard/datasets?tab=build"));
    const notes = await prisma.notification.findMany({ where: { workspaceId: WS, sourceType: "dataset" } });
    assert.equal(notes.length, 2);
    assert.ok(notes.every((n) => n.userId === OWNER && n.kind === "alert_fired"));

    const second = await sweepDatasetStaleness(prisma, WS, { emitAlert, staleAfterDays: 90 });
    assert.equal(second.fired.length, 0);
    assert.equal(second.skipped, 2);
    assert.equal(alerts.length, 2);

    // Recompile with the same (still old) data → new version → alerts again for that dataset.
    await compileDataset(store, WS, "faq");
    const third = await sweepDatasetStaleness(prisma, WS, { emitAlert, staleAfterDays: 90 });
    assert.deepEqual(third.fired.map((f) => [f.type, f.version]), [["faq", 2]]);

    // Fresh data is not stale.
    const fresh = await sweepDatasetStaleness(prisma, OTHER, { emitAlert, staleAfterDays: 90 });
    assert.equal(fresh.fired.length, 0);
  });
});

describe("record search (db)", () => {
  it("finds datasets in the caller's workspace only", async () => {
    const hits = await searchRecords(WS, "viewer", "pricing", { kinds: ["dataset"] });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.title, "Pricing dataset");
    assert.match(hits[0]!.subtitle ?? "", /latest v2/);
    assert.equal(hits[0]!.href, "/dashboard/datasets?tab=build");
    const theirs = await searchRecords(OTHER, "viewer", "faq", { kinds: ["dataset"] });
    assert.equal(theirs.length, 0);
  });
});
