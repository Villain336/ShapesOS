// ShapesOS — Phase 17 (latency, A7): run-event pagination for the run page.
// Newest first, cursor by seq, every timeline event exactly once across the
// pages, streamed text and usage bookkeeping excluded, RLS-scoped. App role.
// Run: DATABASE_URL=<app role> npx tsx --test lib/agents/runs/__tests__/events-page-db.test.ts

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { appendAgentRunEvent, createAgentRun, listAgentRunEventsPage, listAgentRunEventsWhere } from "../service";
import { eventSteps } from "@/lib/aos/runs";

const RUN = randomUUID().slice(0, 8);
const WS = `p17ev-${RUN}`;
const WS_B = `p17ev-b-${RUN}`;
let runId = "";
const timelineSeqs: number[] = [];

before(async () => {
  for (const id of [WS, WS_B]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: `o-${RUN}` } });
  runId = (await createAgentRun({ workspaceId: WS, kind: "chat", startedBy: `o-${RUN}` })).id;
  for (let i = 0; i < 260; i++) {
    const type = i % 5 === 0 ? "text" : i % 7 === 0 ? "usage" : i % 3 === 0 ? "gate" : "agui";
    const ev = await appendAgentRunEvent(WS, runId, {
      type,
      summary: `event ${i}`,
      payload: type === "usage" ? { kind: "llm_usage", costMicroUsd: 10 } : i % 11 === 0 ? { kind: "sandbox.checkpoint", snapshotId: `s${i}` } : { kind: "tool_result", tool: "t" },
    });
    if (type !== "text" && type !== "usage") timelineSeqs.push(ev.seq);
  }
});

after(async () => {
  for (const id of [WS, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("run events, paged newest first", () => {
  it("pages through every timeline event exactly once, newest first, with a seq cursor", async () => {
    const first = await listAgentRunEventsPage(WS, runId, { limit: 100 });
    assert.equal(first.total, timelineSeqs.length);
    assert.equal(first.events.length, 100);
    assert.deepEqual(first.events.map((e) => e.seq), [...timelineSeqs].reverse().slice(0, 100), "the newest 100, newest first");
    const seen = [...first.events.map((e) => e.seq)];
    let before = first.before;
    let pages = 1;
    while (before !== null) {
      const page = await listAgentRunEventsPage(WS, runId, { beforeSeq: before, limit: 100 });
      assert.ok(page.events.every((e) => e.seq < before!), "strictly older than the cursor");
      seen.push(...page.events.map((e) => e.seq));
      before = page.before;
      pages++;
    }
    assert.equal(pages, Math.ceil(timelineSeqs.length / 100));
    assert.deepEqual(seen, [...timelineSeqs].reverse(), "all of them, once each, in order");
    assert.ok(!seen.some((s) => !timelineSeqs.includes(s)), "no text or usage event is a step");
  });

  it("the last page says there is nothing older", async () => {
    const all = await listAgentRunEventsPage(WS, runId, { limit: 500 });
    assert.equal(all.before, null);
    assert.equal(all.events.length, timelineSeqs.length);
  });

  it("usage and sandbox events are read on their own (the page's cost facts and console)", async () => {
    const usage = await listAgentRunEventsWhere(WS, runId, { types: ["usage"] });
    assert.ok(usage.length > 0 && usage.every((e) => e.type === "usage"));
    const sandbox = await listAgentRunEventsWhere(WS, runId, { payloadKindPrefix: "sandbox." });
    assert.ok(sandbox.length > 0 && sandbox.every((e) => String((e.payload as { kind?: string }).kind).startsWith("sandbox.")));
  });

  it("an older page maps to steps oldest first (what the client prepends)", async () => {
    const first = await listAgentRunEventsPage(WS, runId, { limit: 50 });
    const older = await listAgentRunEventsPage(WS, runId, { beforeSeq: first.before!, limit: 50 });
    const steps = eventSteps(older.events.map((e) => ({ id: e.id, seq: e.seq, type: e.type, summary: e.summary, payload: e.payload, createdAt: e.createdAt.toISOString() })));
    assert.equal(steps[0]!.key, older.events[older.events.length - 1]!.id, "oldest first");
  });

  it("another workspace sees no page (RLS)", async () => {
    const other = await listAgentRunEventsPage(WS_B, runId, { limit: 100 });
    assert.equal(other.events.length, 0);
    assert.equal(other.total, 0);
  });
});
