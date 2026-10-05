// ShapesOS — Phase 8: mission executors' allow-lists as tool groups; the plan's
// steps as mission tasks (PURE).
// Run: env -u DATABASE_URL npx tsx --test lib/orchestrator/__tests__/executor-grants.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EXECUTOR_ALLOW_LISTS, EXECUTOR_TOOL_GROUPS, executorGrant, executorGroups } from "../executor-grants";
import { AGENT_MAX_GROUPS } from "@/lib/agents/grants";
import { missionInitialTasks } from "@/lib/agents/mission-runtime";
import { ROUTING_TABLE } from "../orchestrator";
import { MISSION_TEMPLATES } from "@/lib/missions/templates";

describe("executor grants", () => {
  it("every frozen allow-list tool maps to a tool group", () => {
    for (const [executor, tools] of Object.entries(EXECUTOR_ALLOW_LISTS)) {
      for (const t of tools) assert.ok(EXECUTOR_TOOL_GROUPS[t], `${executor}: ${t} has no group`);
    }
  });

  it("grants stay inside both the allow-list and the agent's maximum", () => {
    for (const executor of Object.keys(EXECUTOR_ALLOW_LISTS) as Array<keyof typeof EXECUTOR_ALLOW_LISTS>) {
      const g = executorGrant(executor).groups;
      for (const group of g) {
        assert.ok(group === "workspace" || executorGroups(executor).includes(group), `${executor}: ${group} not in its allow-list`);
        assert.ok(AGENT_MAX_GROUPS[executor].includes(group), `${executor}: ${group} beyond its maximum`);
      }
      assert.ok(!g.includes("delegate"), "mission steps never hand off");
    }
    assert.deepEqual(executorGrant("researcher").groups, ["workspace"], "the researcher only reads");
    assert.deepEqual(executorGrant("drafter").groups, ["workspace", "content"]);
    assert.deepEqual(executorGrant("scheduler").groups, ["workspace", "calendar"]);
    assert.deepEqual(executorGrant("actor").groups, ["workspace", "connectors"]);
  });
});

describe("missionInitialTasks", () => {
  it("runs the plan in order up to the first human approval step", () => {
    const tpl = MISSION_TEMPLATES.find((t) => t.id === "home-services.booked-job-growth")!;
    const { tasks, waitingOn } = missionInitialTasks({ steps: tpl.plan }, { workspaceId: "w", missionId: "m" });
    assert.deepEqual(tasks.map((t) => t.kind), ["research", "plan", "draft"]);
    assert.ok(tasks.every((t) => ROUTING_TABLE[t.kind]), "every task routes");
    assert.equal(waitingOn?.key, "approve-offer");
    assert.equal((tasks[0]!.payload as { stepId: string }).stepId, "audit-local-presence");
  });

  it("an empty or malformed plan yields no tasks", () => {
    assert.deepEqual(missionInitialTasks(null, { workspaceId: "w", missionId: "m" }).tasks, []);
    assert.deepEqual(missionInitialTasks({ steps: [{ executor: "nobody" }] }, { workspaceId: "w", missionId: "m" }).tasks, []);
  });
});
