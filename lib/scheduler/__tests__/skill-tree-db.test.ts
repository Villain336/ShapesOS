// ShapesOS — Phase 16 item 10: a scheduled skill's fan-out joins the run tree.
//
// A live skill run gets ONE AgentRun (kind playbook) and each subtask's
// AgentRun hangs under it (parentRunId), so the Runs page / sidebar show one
// tree and one Stop reaches every subtask — and each subtask's own abort
// controller interrupts its in-flight model call.
//
// MOCK: the model is the scripted fake Responses API
// (lib/chat/__tests__/fake-responses.ts); the scheduler executor, the
// subtask runner and the agent loop are the real ones.
// Run: DATABASE_URL=… npx tsx --test lib/scheduler/__tests__/skill-tree-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { requestAgentRunCancel } from "@/lib/agents/runs/service";
import { abortRun } from "@/lib/agents/runs/abort";
import { executeSkillRun } from "../runner";
import { runSkillSubtaskLive } from "../live";
import { allText, deferred, startFakeModel, waitFor, type FakeModel } from "@/lib/chat/__tests__/fake-responses";

const RUN = `p16s-${Date.now().toString(36)}`;
const WS = `${RUN}-ws`;
let projectId = "";
let model: FakeModel;

const memoryStore = {
  async writeReport(_ws: string, runId: string, filename: string) {
    return { logicalPath: `/artifacts/runs/${runId}/${filename}` };
  },
  async readReport() {
    return null;
  },
};

before(async () => {
  model = await startFakeModel({ agentWorker: "external" });
  await prisma.workspace.create({ data: { id: WS, name: `P16 skills ${WS}`, ownerUserId: `${RUN}-u` } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS, domain: `${RUN}.example` } })).id;
});

after(async () => {
  await model.close();
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

async function skillRun() {
  const skill = await prisma.skill.create({
    data: { workspaceId: WS, name: "Weekly digest", slug: `digest-${Math.random().toString(36).slice(2, 8)}`, description: "d", source: "upload", skillMd: "# Digest", declaredTools: ["get_keywords"], trustTier: "built_in" },
  });
  return prisma.skillRun.create({ data: { workspaceId: WS, projectId, skillId: skill.id, trigger: "manual" } });
}

const subtasks = [
  { label: "gather", tool: "get_keywords", detail: "Gather the numbers." },
  { label: "summarize", tool: null, detail: "Summarize them." },
];

async function agentRunsFor(skillRunId: string) {
  return withWorkspaceScope(WS, (tx) =>
    tx.agentRun.findMany({ where: { workspaceId: WS, agentState: { path: ["skillRunId"], equals: skillRunId } }, orderBy: { createdAt: "asc" } }),
  );
}

describe("Phase 16: skill fan-out in the run tree", () => {
  it("every live subtask run hangs under one run for the skill run", async () => {
    model.script = (b) => ({ text: `report for ${/gather/.test(allText(b)) ? "gather" : "summarize"}` });
    const sr = await skillRun();
    await executeSkillRun(prisma, sr.id, { runSubtask: runSkillSubtaskLive, subtasks, outputStore: memoryStore });
    const runs = await agentRunsFor(sr.id);
    const parent = runs.find((r) => r.parentRunId === null)!;
    const kids = runs.filter((r) => r.parentRunId === parent?.id);
    assert.ok(parent, "one run for the skill run");
    assert.equal(parent.kind, "playbook");
    assert.equal(kids.length, 2, "both subtasks under it");
    assert.ok(kids.every((k) => k.status === "succeeded"));
    assert.equal(parent.status, "succeeded");
    assert.equal((await prisma.skillRun.findUnique({ where: { id: sr.id } }))?.status, "succeeded");
  });

  it("Stop on the skill's run reaches every subtask and interrupts their in-flight calls", async () => {
    const hold = deferred();
    model.requests.length = 0;
    model.script = () => ({ text: "late", hold: hold.promise });
    const sr = await skillRun();
    const running = executeSkillRun(prisma, sr.id, { runSubtask: runSkillSubtaskLive, subtasks, outputStore: memoryStore, workspaceConcurrency: 4 });
    await waitFor(() => model.requests.length === 2, "both subtasks calling the model");
    const parent = (await agentRunsFor(sr.id)).find((r) => r.parentRunId === null)!;
    // What POST /api/agent-runs/[id]/cancel does for a run without a thread.
    const res = await requestAgentRunCancel(WS, parent.id, "tester");
    assert.equal(res?.runIds.length, 3, "the skill run and its two subtasks");
    for (const id of res!.runIds) abortRun(id);
    await waitFor(() => model.requests.every((r) => r.aborted), "both in-flight calls interrupted", 5_000);
    hold.resolve();
    await running;
    const runs = await agentRunsFor(sr.id);
    assert.ok(runs.filter((r) => r.parentRunId === parent.id).every((k) => k.status === "cancelled"));
    assert.equal(runs.find((r) => r.id === parent.id)?.status, "cancelled");
  });
});
