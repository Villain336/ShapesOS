// ShapesOS — Phase 8 (ship), end to end against Postgres (as the app role):
//   1. Repo profiles are stored per workspace under FORCE RLS.
//   2. The ship tools record run events (with the patch) and keep the branch /
//      PR on the run's agentState.ship.
//   3. Diff review: the Changes data comes from the stored patch; Approve
//      forwards the pending push through the REAL chat confirmation path (the
//      push runs, against a local bare remote, in a new tracked run); Ask for
//      changes posts into the thread and runs a turn; Reject stops and drops
//      the proposal; only the chat's owner can approve.
// Git runs for real in the TEST-ONLY fake Sandbox (no network); the model is
// off (mock mode), which the confirmation path never needs.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/ship/__tests__/ship-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { prisma } from "@/lib/prisma";
import { countWithoutScope, withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createAgentRun, listAgentRunEvents } from "@/lib/agents/runs/service";
import { isStreamEvent } from "@/lib/agents/runs/usage";
import { getRepoProfile, saveRepoProfile } from "@/lib/sandbox/repo-profile";
import { MockGitHubConnector } from "@/lib/connectors/mock-github";
import { createShipTools, defaultShipDeps, type ShipDeps } from "../tools";
import { loadShipState, readShipState } from "../state";
import { CHANGES_PREFIX, ReviewError, loadRunReview, reviewRun } from "../review";
import type { RepoAccess } from "../access";
import type { ToolContext, ToolDef } from "@/lib/chat/tools";
import { createFakeSandbox, remoteRef, seedRemote, type FakeSandbox } from "./fake-sandbox";

const RUN = `p8s-${Date.now().toString(36)}`;
const WS_A = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const USER = `${RUN}-user`;
const OTHER = `${RUN}-other`;
const TOKEN = "ghp_dbTestToken0123456789abcdefgh";
let projectId = "";
let sb: FakeSandbox;
let bare = "";

const ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "LLM_MODEL_BULK", "LLM_MODEL", "LLM_API_KEY", "ANTHROPIC_API_KEY", "LLM_SELF_HOST"];
const savedEnv: Record<string, string | undefined> = {};
const savedDeps = { ...defaultShipDeps };

const access: RepoAccess = {
  owner: "acme",
  repo: "site",
  fullName: "acme/site",
  mode: "pat",
  // The labelled mock answers repo / PR calls; git itself runs for real.
  connector: new MockGitHubConnector(),
  token: async () => TOKEN,
};

before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  sb = createFakeSandbox();
  bare = await seedRemote(sb, "acme", "site", {
    "package.json": JSON.stringify({ name: "site", scripts: { test: "vitest run", lint: "eslint ." } }),
    "yarn.lock": "",
    "index.js": "console.log('v1');\n",
  });
  // The registered tools (which the confirmation path runs) use these deps.
  defaultShipDeps.getSandbox = async () => sb;
  defaultShipDeps.resolveAccess = async () => access;
  for (const id of [WS_A, WS_B]) await prisma.workspace.create({ data: { id, name: `P8 ${id}`, ownerUserId: USER } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS_A, domain: `${RUN}.example` } })).id;
});

after(async () => {
  Object.assign(defaultShipDeps, savedDeps);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await sb.destroy();
  await prisma.$disconnect();
});

const deps: ShipDeps = { ...defaultShipDeps, getSandbox: async () => sb, resolveAccess: async () => access };
const tools = new Map<string, ToolDef>(createShipTools(deps).map((t) => [t.name, t]));

let threadId = "";
let runId = "";

function ctx(): ToolContext & { threadId: string } {
  return { projectId, workspaceId: WS_A, userId: USER, role: "editor", confirmed: true, runId, threadId, agentKey: "actor", grant: ["workspace", "code", "ship"] };
}

async function proposePush(): Promise<void> {
  await prisma.aiChatMessage.create({
    data: {
      threadId,
      role: "assistant",
      content: "I'd like to run git_push_branch.",
      toolCalls: [{ tool: "git_push_branch", args: {}, status: "pending_confirmation", agentKey: "actor", grant: ["workspace", "code", "ship"] }] as unknown as object,
    },
  });
}

describe("repo profiles (FORCE RLS)", () => {
  it("are per workspace and invisible without the tenant scope", async () => {
    await saveRepoProfile(WS_B, "Acme/Other", { packageManager: "npm", language: "javascript", commands: { test: "npm test" }, detectedFrom: ["package.json"] });
    const b = await getRepoProfile(WS_B, "acme/other");
    assert.equal(b?.commands.test, "npm test");
    assert.equal(await getRepoProfile(WS_A, "acme/other"), null, "another workspace can't read it");
    assert.equal(await countWithoutScope("repo_profiles"), 0, "fail-closed without the GUC");
    // Upsert keeps one row.
    await saveRepoProfile(WS_B, "acme/other", { packageManager: "pnpm", language: "javascript", commands: {}, detectedFrom: [] });
    const rows = await withWorkspaceScope(WS_B, (tx) => tx.repoProfile.count({ where: { workspaceId: WS_B } }));
    assert.equal(rows, 1);
    assert.equal((await getRepoProfile(WS_B, "acme/other"))?.packageManager, "pnpm");
    // A cross-workspace write is rejected by WITH CHECK.
    await assert.rejects(() =>
      withWorkspaceScope(WS_A, (tx) => tx.repoProfile.create({ data: { workspaceId: WS_B, repoFullName: "x/y" } })),
    );
  });
});

describe("ship tools on a real run", () => {
  it("clone → edit → diff → commit record run events and the ship state", async () => {
    threadId = (
      await prisma.aiChatThread.create({ data: { projectId, userId: USER, title: "Ship it", agentKey: "actor", allowedTools: ["workspace", "code", "ship"] } })
    ).id;
    runId = (await createAgentRun({ workspaceId: WS_A, kind: "chat", startedBy: USER, threadId, agentKey: "actor", allowedTools: ["workspace", "code", "ship"] })).id;

    await tools.get("git_clone")!.execute(ctx(), { repo: "acme/site" });
    const state = await loadShipState({ workspaceId: WS_A, runId });
    assert.equal(state?.branch, `shapes/${runId}`);
    assert.equal((await getRepoProfile(WS_A, "acme/site"))?.commands.test, "yarn test", "profile stored on first clone");

    await sb.writeFile(path.join(state!.dir, "index.js"), "console.log('v2');\n");
    await tools.get("git_diff")!.execute(ctx(), {});
    await tools.get("git_commit")!.execute(ctx(), { message: "Say v2" });

    const events = await listAgentRunEvents(WS_A, runId);
    const byTool = (t: string) => events.filter((e) => (e.payload as { tool?: string } | null)?.tool === t);
    assert.equal(byTool("git_clone").length, 1);
    assert.match(String((byTool("git_diff")[0]!.payload as { patch: string }).patch), /\+console\.log\('v2'\);/);
    assert.equal(byTool("git_commit").length, 1);
    assert.ok(!JSON.stringify(events).includes(TOKEN), "no token in run events");
  });

  it("the review reads the stored patch (server-side) and the pending push", async () => {
    await proposePush();
    const review = await loadRunReview(WS_A, runId);
    assert.ok(review?.changes);
    assert.equal(review!.changes!.source.tool, "git_commit");
    assert.deepEqual(review!.changes!.files.map((f) => [f.path, f.additions, f.deletions]), [["index.js", 1, 1]]);
    assert.equal(review!.pending?.tool, "git_push_branch");
    assert.equal(review!.ship?.branch, `shapes/${runId}`);
    assert.equal(await loadRunReview(WS_B, runId), null, "another workspace sees nothing");
  });

  it("only the chat's owner can approve", async () => {
    await assert.rejects(
      () => reviewRun({ workspaceId: WS_A, runId, userId: OTHER, role: "admin", action: "approve" }),
      (e: unknown) => e instanceof ReviewError && e.status === 403,
    );
  });

  it("Approve forwards the pending push through the chat confirmation path", async () => {
    const out = await reviewRun({ workspaceId: WS_A, runId, userId: USER, role: "editor", action: "approve" });
    assert.ok(out.followUpRunId && out.followUpRunId !== runId);
    assert.match(out.reply ?? "", /Pushed 1 commit to shapes\//);
    // It really pushed — to the run's branch only.
    assert.ok(await remoteRef(bare, `refs/heads/shapes/${runId}`));
    const follow = await withWorkspaceScope(WS_A, (tx) => tx.agentRun.findFirst({ where: { id: out.followUpRunId! } }));
    assert.equal(follow?.threadId, threadId);
    assert.equal(readShipState(follow?.agentState)?.branchUrl, `https://github.com/acme/site/tree/shapes/${runId}`);
    const pushed = (await listAgentRunEvents(WS_A, out.followUpRunId!)).filter((e) => (e.payload as { tool?: string } | null)?.tool === "git_push_branch");
    // One timeline event (the tool's own); the loop's tool_result for the same
    // call is kept for the live stream only and hidden from the timeline.
    assert.equal(pushed.filter((e) => !isStreamEvent(e)).length, 1, "one timeline event (the tool's own, not a duplicate)");
    assert.ok(pushed.filter(isStreamEvent).every((e) => (e.payload as { recorded?: unknown }).recorded === true));
    // The Changes review still finds the patch (not the newer patch-less stream event).
    const after = await loadRunReview(WS_A, out.followUpRunId!);
    assert.ok(after?.changes && after.changes.files.length > 0, "Changes review reads the tool's own event");
    const gate = (await listAgentRunEvents(WS_A, runId)).find((e) => e.type === "gate" && /Approved git push branch/.test(e.summary));
    assert.ok(gate, "the approval is on the reviewed run's timeline");
    const msgs = await prisma.aiChatMessage.findMany({ where: { threadId, role: "user" }, select: { content: true } });
    assert.ok(msgs.some((m) => m.content === "Approved."));
    // Nothing pending any more → a second approve is refused.
    await assert.rejects(
      () => reviewRun({ workspaceId: WS_A, runId, userId: USER, role: "editor", action: "approve" }),
      (e: unknown) => e instanceof ReviewError && e.status === 409,
    );
  });

  it("Ask for changes posts the note into the thread and the agent continues", async () => {
    const out = await reviewRun({ workspaceId: WS_A, runId, userId: USER, role: "editor", action: "changes", message: "Keep v1 in a comment." });
    const msg = await prisma.aiChatMessage.findFirst({ where: { threadId, role: "user" }, orderBy: { createdAt: "desc" } });
    assert.equal(msg?.content, `${CHANGES_PREFIX}\nKeep v1 in a comment.`);
    const follow = await withWorkspaceScope(WS_A, (tx) => tx.agentRun.findFirst({ where: { id: out.followUpRunId! } }));
    assert.equal(follow?.threadId, threadId);
    assert.equal(follow?.status, "succeeded");
    await assert.rejects(
      () => reviewRun({ workspaceId: WS_A, runId, userId: USER, role: "editor", action: "changes", message: "  " }),
      (e: unknown) => e instanceof ReviewError && e.status === 400,
    );
  });

  it("Reject stops and drops the pending proposal (a later yes runs nothing)", async () => {
    await proposePush();
    const out = await reviewRun({ workspaceId: WS_A, runId, userId: USER, role: "editor", action: "reject" });
    assert.equal(out.action, "reject");
    const last = await prisma.aiChatMessage.findFirst({ where: { threadId, role: "assistant" }, orderBy: { createdAt: "desc" } });
    assert.equal((last?.toolCalls as Array<{ status: string }>)[0]!.status, "cancelled");
    assert.equal((await loadRunReview(WS_A, runId))?.pending, null);
    assert.ok((await listAgentRunEvents(WS_A, runId)).some((e) => /Changes rejected/.test(e.summary)));
  });
});
