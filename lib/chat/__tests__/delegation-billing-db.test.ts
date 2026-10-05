// ShapesOS Phase 15.2 — delegated sub-agents' model calls are charged
// through the SAME token path as the lead's (llm_tokens at 1.5× cost, once
// per provider response), and the Phase 16 orchestration fee
// (subagent_spawn) stays a separate, once-per-child charge — nothing is
// counted twice. Fake Responses API (MOCK), real loop + queue + worker +
// metering, against Postgres as the app role. Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… MARKETR_CREDENTIALS_KEY=… npx tsx --test lib/chat/__tests__/delegation-billing-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { AgentWorker } from "@/lib/agents/queue/worker";
import { creditsFor, llmTokenCredits } from "@/lib/metering/credits";
import { runTrackedAgentTurn } from "../agent";
import { allText, startFakeModel, toolOutputs, type FakeModel, type ResponsesBody } from "./fake-responses";

const RUN = `p15db-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
const USER = `${RUN}-user`;
let projectId = "";
let model: FakeModel;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
// gpt-5.5 (single-key OpenAI mode): 1000 × $5 + 100 × $30 per M = 8,000 micro-USD.
const USAGE = { input_tokens: 1000, output_tokens: 100 };
const PER_CALL = llmTokenCredits(8_000);

before(async () => {
  model = await startFakeModel({ agentWorker: "external" });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: USER, plan: "starter" } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS, domain: `${RUN}.example` } })).id;
});

after(async () => {
  await model.close();
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

function childTask(b: ResponsesBody): string | null {
  return allText(b).match(/Task ([A-Za-z0-9_-]+) of the plan/)?.[1] ?? null;
}
const deliverable = (summary: string) =>
  `Done.\n\n\`\`\`deliverable\n${JSON.stringify({ summary, outputs: summary, artifacts: [], openIssues: [], confidence: "high" })}\n\`\`\``;

async function pump(worker: AgentWorker, rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const started = await worker.tick();
    if (worker.busy > 0) await worker.drain();
    if (started === 0 && worker.busy === 0) {
      const due = await withWorkspaceScope(WS, (tx) =>
        tx.agentJob.count({ where: { workspaceId: WS, status: "queued", runAfter: { lte: new Date() } } }),
      );
      if (due === 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

describe("delegated model calls are billed once, through the token path", () => {
  it("every model call (lead and children) is one llm_tokens charge; spawn fees are separate", async () => {
    const t = await prisma.aiChatThread.create({ data: { projectId, userId: USER, title: "New chat", agentKey: "lead", allowedTools: [] } });
    model.requests.length = 0;
    model.script = (b) => {
      const id = childTask(b);
      if (id) return { text: deliverable(`${id} done`), usage: USAGE };
      return toolOutputs(b).length
        ? { text: "Merged.", usage: USAGE }
        : {
            calls: [
              {
                tool: "delegate_tasks",
                args: {
                  goal: "Two lookups",
                  tasks: [
                    { id: "a", agent: "researcher", brief: "Look up a", deliverable: "a facts" },
                    { id: "b", agent: "researcher", brief: "Look up b", deliverable: "b facts" },
                  ],
                  mergeInstructions: "Merge.",
                },
              },
            ],
            usage: USAGE,
          };
    };
    const out = await runTrackedAgentTurn({ projectId, workspaceId: WS, userId: USER, role: "editor", threadId: t.id, userContent: "Look up a and b" });
    assert.equal(out.queued, true);
    await pump(new AgentWorker({ log: quiet, leaseMs: 60_000, heartbeatMs: 10_000, concurrency: 8 }));

    const served = model.requests.filter((r) => !r.aborted).length;
    assert.ok(served >= 4, `lead + 2 children + merge (saw ${served})`);
    const tokens = await prisma.usageEvent.findMany({ where: { workspaceId: WS, action: "llm_tokens" } });
    assert.equal(tokens.length, served, "one llm_tokens row per model call — none missed, none doubled");
    assert.equal(new Set(tokens.map((e) => e.idempotencyKey)).size, tokens.length);
    assert.ok(tokens.every((e) => e.credits === PER_CALL && e.keySource === "platform"), "each call charged ceil(cost × 1.5)");
    const kids = await withWorkspaceScope(WS, (tx) => tx.agentRun.findMany({ where: { workspaceId: WS, parentRunId: out.runId } }));
    assert.equal(kids.length, 2);
    for (const k of kids) {
      assert.ok(tokens.some((e) => e.evidenceRef === `agent_run:${k.id}`), "the child's own calls are on the token ledger, attributed to its run");
    }
    const spawns = await prisma.usageEvent.findMany({ where: { workspaceId: WS, action: "subagent_spawn" } });
    assert.equal(spawns.length, 2, "one orchestration fee per child");
    const bal = await prisma.creditBalance.findUniqueOrThrow({ where: { workspaceId: WS } });
    assert.equal(bal.usedCredits, served * PER_CALL + 2 * creditsFor("subagent_spawn"), "the pool carries exactly tokens + spawn fees");
  });
});
