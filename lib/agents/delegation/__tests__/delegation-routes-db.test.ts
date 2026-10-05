// ShapesOS — Phase 16: the delegation routes against Postgres (session stubbed
// with node:test mock.module).
//   GET/PUT /api/agents/delegation-settings — viewers read, editors change;
//     every limit bounded; null = back to the default; RLS-scoped per workspace.
//   GET /api/agent-runs/[runId]/delegation — the plan view of a run in the
//     caller's workspace; another workspace's run is 404.
// Run: DATABASE_URL=… npx tsx --test --experimental-test-module-mocks \
//        lib/agents/delegation/__tests__/delegation-routes-db.test.ts

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createAgentRun } from "@/lib/agents/runs/service";

const RUN = randomUUID().slice(0, 8);
const WS = `p16r${RUN}`;
const WS2 = `p16r2${RUN}`;
const EDITOR = `p16r-editor-${RUN}`;
const VIEWER = `p16r-viewer-${RUN}`;

let actor = { id: EDITOR, email: "editor@deleg.test" };
let currentWs = WS;

mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => actor,
    getOrCreateWorkspace: async () => prisma.workspace.findUniqueOrThrow({ where: { id: currentWs } }),
  },
});

type SettingsRoute = typeof import("@/app/api/agents/delegation-settings/route");
type ViewRoute = typeof import("@/app/api/agent-runs/[runId]/delegation/route");
let settings: SettingsRoute;
let viewRoute: ViewRoute;

const put = (b: unknown) => new Request("http://localhost:3000/api/agents/delegation-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

before(async () => {
  settings = await import("@/app/api/agents/delegation-settings/route");
  viewRoute = await import("@/app/api/agent-runs/[runId]/delegation/route");
  for (const id of [WS, WS2]) await prisma.workspace.create({ data: { id, name: id, ownerUserId: `owner-${id}` } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: EDITOR, role: "editor" },
      { workspaceId: WS, userId: VIEWER, role: "viewer" },
      { workspaceId: WS2, userId: EDITOR, role: "editor" },
    ],
  });
});

after(async () => {
  for (const id of [WS, WS2]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("Phase 16 delegation routes", () => {
  it("settings: defaults on GET; an editor saves bounded values; null resets; viewers can't change them", async () => {
    actor = { id: EDITOR, email: "editor@deleg.test" };
    currentWs = WS;
    const first = await (await settings.GET()).json();
    assert.equal(first.autoDelegation, true);
    assert.deepEqual(first.limits, { maxParallelPerRun: 4, maxLivePerWorkspace: 6, maxWidth: 8, maxDepth: 2 });

    const saved = await settings.PUT(put({ autoDelegation: false, maxParallelPerRun: 2, maxDepth: 1 }));
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.equal(body.autoDelegation, false);
    assert.equal(body.limits.maxParallelPerRun, 2);
    assert.equal(body.limits.maxDepth, 1);
    assert.equal(body.stored.maxWidth, null);

    for (const bad of [{ maxParallelPerRun: 9 }, { maxDepth: 3 }, { maxWidth: 0 }, { maxLivePerWorkspace: 2.5 }, { autoDelegation: "yes" }, { spend: 1 }]) {
      const res = await settings.PUT(put(bad));
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    const reset = await (await settings.PUT(put({ maxParallelPerRun: null }))).json();
    assert.equal(reset.limits.maxParallelPerRun, 4, "null = back to the default");
    assert.equal(reset.autoDelegation, false, "untouched fields stay");

    actor = { id: VIEWER, email: "viewer@deleg.test" };
    assert.equal((await settings.GET()).status, 200, "viewers may read");
    assert.equal((await settings.PUT(put({ autoDelegation: true }))).status, 403, "viewers can't change it");

    // Another workspace is untouched (RLS-scoped row).
    actor = { id: EDITOR, email: "editor@deleg.test" };
    currentWs = WS2;
    assert.equal((await (await settings.GET()).json()).autoDelegation, true);
    const rows = await withWorkspaceScope(WS2, (tx) => tx.agentDelegationSetting.count({ where: { workspaceId: WS } }));
    assert.equal(rows, 0, "a workspace can't see another's settings");
    currentWs = WS;
  });

  it("plan view: a run in the caller's workspace; 404 for another workspace's run", async () => {
    actor = { id: EDITOR, email: "editor@deleg.test" };
    currentWs = WS;
    const run = await createAgentRun({
      workspaceId: WS,
      kind: "chat",
      startedBy: EDITOR,
      agentKey: "lead",
      agentState: {
        delegation: {
          v: 1,
          continuation: { kind: "chat_turn", payload: { projectId: "p", workspaceId: WS, userId: EDITOR, role: "editor", threadId: "t", userContent: "", agentKey: "lead", grant: [], mode: "default" } },
          plans: [
            {
              planId: "plan_v",
              toolUseId: "tu",
              goal: "Seeded plan",
              mergeInstructions: "m",
              depth: 1,
              round: 0,
              createdAt: new Date().toISOString(),
              armed: true,
              reserve: { costMicroUsd: 1, steps: 1, ms: 1 },
              tasks: [
                { id: "a", agent: "researcher", brief: "A", deliverableSpec: "a", dependsOn: [], requestedTools: null, grant: ["workspace"], dropped: [], budgetShare: 1, budget: { costMicroUsd: 5, steps: 2, ms: 60_000 }, status: "running" },
              ],
            },
          ],
        },
      },
    });
    const ok = await viewRoute.GET(new Request("http://localhost/x"), { params: Promise.resolve({ runId: run.id }) });
    assert.equal(ok.status, 200);
    const view = await ok.json();
    assert.equal(view.plans[0].goal, "Seeded plan");
    assert.equal(view.plans[0].tasks[0].aos, "running");

    currentWs = WS2;
    const foreign = await viewRoute.GET(new Request("http://localhost/x"), { params: Promise.resolve({ runId: run.id }) });
    assert.equal(foreign.status, 404);
    currentWs = WS;
  });
});
