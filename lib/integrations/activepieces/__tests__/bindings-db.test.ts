// ShapesOS — Phase 1 (H6) DB test: the MCP automation tools only reach flows
// bound to the token's workspace (automation_flow_bindings), against the
// real Prisma store. The engine is a mocked fetch.
// Run: npx tsx --test lib/integrations/activepieces/__tests__/bindings-db.test.ts
// Requires DATABASE_URL (listed in scripts/test/db-tests.txt).

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { getTool, ToolError } from "@/lib/mcp/tools";
import type { McpAuthContext } from "@/lib/mcp/auth";
import { bindFlowToWorkspace, FlowBindingConflictError, prismaFlowBindingStore } from "../bindings";

const WS_A = "p1b-ap-a";
const WS_B = "p1b-ap-b";
const FLOW_A = "p1b-flow-a";
const FLOW_B = "p1b-flow-b";
const REAL_FETCH = globalThis.fetch;
const calls: string[] = [];

function flowRow(id: string) {
  return {
    id, displayName: id, status: "ENABLED", publishedVersionId: "v1",
    version: { trigger: { type: "TRIGGER", settings: { pieceName: "@activepieces/piece-webhook", triggerName: "catch_webhook" } } },
  };
}

before(async () => {
  process.env.ACTIVEPIECES_URL = "http://ap.test";
  process.env.ACTIVEPIECES_API_KEY = "k";
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    const m = u.match(/\/flows\/([^/?]+)$/);
    if (m) return new Response(JSON.stringify({ data: flowRow(decodeURIComponent(m[1]!)) }));
    if (u.includes("/flow-runs/")) {
      const id = u.split("/flow-runs/")[1]!;
      return new Response(JSON.stringify({ id, flowId: id === "run-b" ? FLOW_B : FLOW_A, status: "SUCCEEDED" }));
    }
    if (u.includes("/webhooks/")) return new Response(JSON.stringify({ runId: "run-new" }));
    return new Response(JSON.stringify({ data: [] }));
  }) as typeof fetch;
  await prisma.automationFlowBinding.deleteMany({ where: { flowId: { in: [FLOW_A, FLOW_B] } } });
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({ data: { id, name: id, ownerUserId: `${id}-owner` } });
  }
  await bindFlowToWorkspace(WS_A, FLOW_A, "op");
  await bindFlowToWorkspace(WS_B, FLOW_B, "op");
});

after(async () => {
  globalThis.fetch = REAL_FETCH;
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

const ctx = (workspaceId: string): McpAuthContext => ({
  workspaceId,
  credential: { kind: "api_key", keyId: "k1", keyPrefix: "mk_" },
  scopes: ["*"],
  userId: "u1",
});

describe("Activepieces tenant binding (H6, real store)", () => {
  it("MCP trigger: another tenant's flow is not found and never fired", async () => {
    calls.length = 0;
    await assert.rejects(
      () => getTool("automation_trigger_flow")!.handler(ctx(WS_A), { flowId: FLOW_B, payload: { evil: true } }),
      (e: unknown) => e instanceof ToolError && e.code === "flow_not_found",
    );
    assert.equal(calls.filter((u) => u.includes("/webhooks/")).length, 0);
  });

  it("MCP trigger: the workspace's own flow fires", async () => {
    const res = await getTool("automation_trigger_flow")!.handler(ctx(WS_A), { flowId: FLOW_A });
    assert.equal(res.data.accepted, true);
  });

  it("MCP status: another tenant's run is not found", async () => {
    await assert.rejects(
      () => getTool("automation_flow_status")!.handler(ctx(WS_A), { runId: "run-b" }),
      (e: unknown) => e instanceof ToolError && e.code === "flow_not_found",
    );
    const own = await getTool("automation_flow_status")!.handler(ctx(WS_A), { runId: "run-a" });
    assert.equal((own.data.run as { flowId: string }).flowId, FLOW_A);
  });

  it("a bound flow cannot be re-bound to another workspace", async () => {
    await assert.rejects(() => bindFlowToWorkspace(WS_A, FLOW_B, "op"), (e: unknown) => e instanceof FlowBindingConflictError);
    assert.equal(await prismaFlowBindingStore().ownerOf(FLOW_B), WS_B);
    assert.deepEqual(await prismaFlowBindingStore().listFlowIds(WS_A), [FLOW_A]);
  });
});
