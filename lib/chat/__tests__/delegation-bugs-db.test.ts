// ShapesOS — Phase 16: the two delegation bugs, proven against Postgres.
//
//   BUG 1 (lease loss): a worker that loses its lease while a sub-agent is
//     mid-call must leave that sub-agent RESUMABLE — on the base code the
//     delegate tool fell through to finishAgentRun(…, "succeeded") with an
//     empty result. After the fix the sub-agent stays `running`, a worker
//     picks it up again from its saved transcript, and the lead finishes once.
//   BUG 2 (continuation): "yes" on a proposal a SUB-AGENT made must resume
//     that sub-agent (its role, its narrower tools, its run) — on the base
//     code the sub-agent's transcript was continued under the LEAD's context
//     (the lead's tools, the lead's run).
//   (and) a sub-agent waiting for the user's OK is `awaiting_confirmation`,
//     never `succeeded`.
//
// This file only uses entry points that exist on the base code
// (runTrackedAgentTurn, AgentWorker, delegate_to_subagent), so the same file
// was run against the base first: it FAILED there (see the Phase 16 report)
// and passes on the fix.
//
// MOCK: the model is the scripted fake Responses API (./fake-responses.ts).
// Run: DATABASE_URL=… npx tsx --test lib/chat/__tests__/delegation-bugs-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getAgentRun } from "@/lib/agents/runs/service";
import { AgentWorker } from "@/lib/agents/queue/worker";
import { runTrackedAgentTurn, type ChatToolCall } from "../agent";
import { allText, deferred, offered, startFakeModel, toolOutputs, waitFor, type FakeModel } from "./fake-responses";

const RUN = `p16b-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
const USER = `${RUN}-user`;
let projectId = "";
let model: FakeModel;

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

before(async () => {
  model = await startFakeModel({ agentWorker: "external" });
  await prisma.workspace.create({ data: { id: WS, name: `P16 bugs ${WS}`, ownerUserId: USER } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS, domain: `${RUN}.example` } })).id;
});

after(async () => {
  await model.close();
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

async function leadThread() {
  return prisma.aiChatThread.create({ data: { projectId, userId: USER, title: "New chat", agentKey: "lead", allowedTools: [] } });
}

function turn(threadId: string, userContent: string, inlineBudgetMs?: number | null) {
  return runTrackedAgentTurn(
    { projectId, workspaceId: WS, userId: USER, role: "editor", threadId, userContent },
    inlineBudgetMs === undefined ? {} : { inlineBudgetMs },
  );
}

/** Tick the worker until nothing is due and nothing is running (bounded). */
async function pump(worker: AgentWorker, rounds = 40): Promise<void> {
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

async function childRuns(threadId: string, agentKey: string) {
  return withWorkspaceScope(WS, (tx) =>
    tx.agentRun.findMany({ where: { workspaceId: WS, threadId, agentKey, parentRunId: { not: null } }, orderBy: { createdAt: "asc" } }),
  );
}

async function lastAssistant(threadId: string) {
  return prisma.aiChatMessage.findFirst({ where: { threadId, role: "assistant" }, orderBy: { createdAt: "desc" } });
}

describe("Phase 16 delegation bugs (fake Responses API, real loop + queue)", () => {
  it("BUG 1: losing the worker's lease mid sub-agent keeps the sub-agent resumable (never `succeeded`)", async () => {
    const t = await leadThread();
    const held = deferred();
    const analystInFlight = deferred();
    let analystCalls = 0;
    model.script = (b) => {
      const text = allText(b);
      if (text.includes("Analyst sub-agent")) {
        analystCalls++;
        if (analystCalls === 1) {
          analystInFlight.resolve();
          return { text: "too late", hold: held.promise };
        }
        return { text: "Analyst report: conversions up 12%." };
      }
      // The lead: delegate once, then merge what came back.
      return toolOutputs(b).length > 0
        ? { text: "Lead merged the analyst's report." }
        : { calls: [{ tool: "delegate_to_subagent", args: { agent: "analyst", task: "Read last month's numbers" } }] };
    };

    // Inline budget 0: the turn goes to the worker before its first step.
    const out = await turn(t.id, "What worked last month?", 0);
    assert.equal(out.queued, true);

    const worker = new AgentWorker({ log: quiet, leaseMs: 5_000, heartbeatMs: 1_000, concurrency: 4 });
    // Drive the worker until the sub-agent's first model call is in flight.
    const ticking = (async () => {
      for (let i = 0; i < 400 && analystCalls === 0; i++) {
        await worker.tick();
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    await analystInFlight.promise;
    await ticking;
    const [child] = await childRuns(t.id, "analyst");
    assert.ok(child, "the sub-agent runs as its own child run");

    // Another worker "takes" every running job: this worker's next heartbeat
    // fails and it must stop its local work without finishing anything.
    await withWorkspaceScope(WS, (tx) =>
      tx.$executeRaw`UPDATE "agent_jobs" SET "locked_by" = 'thief' WHERE "workspace_id" = ${WS} AND "status" = 'running'`,
    );
    const outcomes = await worker.drain();
    assert.ok(outcomes.some((o) => o.status === "lease_lost"), `the worker noticed the lost lease: ${JSON.stringify(outcomes)}`);
    assert.ok(model.requests.some((r) => allText(r.body).includes("Analyst sub-agent") && r.aborted), "the in-flight sub-agent call was aborted");

    const afterLoss = await getAgentRun(WS, child!.id);
    assert.notEqual(afterLoss?.status, "succeeded", "BUG 1: a sub-agent cut off by a lease loss must never be finished as succeeded");
    assert.equal(afterLoss?.status, "running", "it stays resumable");

    // The thief "dies": its lease passes, a worker claims the job again and
    // continues the sub-agent from its saved transcript.
    held.resolve();
    await withWorkspaceScope(WS, (tx) =>
      tx.$executeRaw`UPDATE "agent_jobs" SET "lease_until" = now() - interval '1 second' WHERE "workspace_id" = ${WS} AND "locked_by" = 'thief' AND "status" = 'running'`,
    );
    await pump(worker);

    assert.equal((await getAgentRun(WS, child!.id))?.status, "succeeded");
    assert.equal(analystCalls, 2, "the cut-off call was made again, once");
    assert.equal((await getAgentRun(WS, out.runId))?.status, "succeeded");
    const last = await lastAssistant(t.id);
    assert.equal(last?.content, "Lead merged the analyst's report.");
    const merged = await prisma.aiChatMessage.count({ where: { threadId: t.id, role: "assistant", content: "Lead merged the analyst's report." } });
    assert.equal(merged, 1, "the lead answered exactly once");
    const leadSaw = model.requests.filter((r) => !allText(r.body).includes("Analyst sub-agent") && toolOutputs(r.body).length > 0);
    assert.ok(leadSaw.some((r) => toolOutputs(r.body).some((o) => o.includes("conversions up 12%"))), "the lead got the sub-agent's real report");
  });

  it("BUG 2: \"yes\" on a sub-agent's proposal resumes THAT sub-agent (its tools, its run), not the lead", async () => {
    const t = await leadThread();
    model.script = (b) => {
      const text = allText(b);
      if (text.includes("Operator sub-agent")) {
        return toolOutputs(b).length > 0
          ? { text: "Operator: the weekly workflow was started." }
          : { calls: [{ tool: "run_workflow", args: { workflowId: "wf-weekly" } }] };
      }
      return toolOutputs(b).length > 0
        ? { text: "Lead: the Operator ran the workflow." }
        : { calls: [{ tool: "delegate_to_subagent", args: { agent: "actor", task: "Start the weekly workflow" } }] };
    };
    const worker = new AgentWorker({ log: quiet, leaseMs: 60_000, heartbeatMs: 10_000, concurrency: 4 });

    await turn(t.id, "Kick off the weekly workflow");
    await pump(worker);

    const proposal = await lastAssistant(t.id);
    const pending = ((proposal?.toolCalls ?? []) as unknown as ChatToolCall[]).filter((c) => c.status === "pending_confirmation");
    assert.equal(pending.length, 1, `the sub-agent's proposal is waiting: ${proposal?.content}`);
    assert.equal(pending[0]!.tool, "run_workflow");
    assert.equal(pending[0]!.agentKey, "actor");
    const [child] = await childRuns(t.id, "actor");
    assert.ok(child);

    const before = model.requests.length;
    const yes = await turn(t.id, "yes");
    await pump(worker);
    assert.ok(!yes.cancelled);

    const next = model.requests.slice(before)[0];
    assert.ok(next, "the model was called again after the OK");
    assert.match(next!.body.instructions ?? "", /Operator sub-agent/, "the continuation runs as the Operator");
    assert.ok(
      !offered(next!.body).includes("research_question"),
      "BUG 2: the continuation must keep the Operator's tools (web research is not one of them) — not the lead's",
    );
    assert.ok(toolOutputs(next!.body).some((o) => !/waiting for the user's OK/.test(o)), "the real result replaced the placeholder");

    // The continuation is recorded on the sub-agent's own run.
    const childEvents = await withWorkspaceScope(WS, (tx) =>
      tx.agentRunEvent.findMany({ where: { workspaceId: WS, runId: child!.id }, orderBy: { seq: "asc" } }),
    );
    assert.ok(
      childEvents.some((e) => e.type === "text" && /weekly workflow was started/.test(e.summary)),
      "the sub-agent's own run carries its continued work",
    );
    assert.equal((await getAgentRun(WS, child!.id))?.status, "succeeded");
    const last = await lastAssistant(t.id);
    assert.equal(last?.content, "Lead: the Operator ran the workflow.", "the lead merged and answered once the sub-agent finished");
  });

  it("a sub-agent waiting for the user's OK is `awaiting_confirmation`, not `succeeded`", async () => {
    const t = await leadThread();
    model.script = (b) => {
      if (allText(b).includes("Operator sub-agent")) return { calls: [{ tool: "run_workflow", args: { workflowId: "wf-2" } }] };
      return toolOutputs(b).length > 0 ? { text: "unused" } : { calls: [{ tool: "delegate_to_subagent", args: { agent: "actor", task: "Start workflow two" } }] };
    };
    const worker = new AgentWorker({ log: quiet, leaseMs: 60_000, heartbeatMs: 10_000, concurrency: 4 });
    await turn(t.id, "Kick off workflow two");
    await pump(worker);
    const [child] = await childRuns(t.id, "actor");
    assert.ok(child);
    assert.equal((await getAgentRun(WS, child!.id))?.status, "awaiting_confirmation");
  });
});
