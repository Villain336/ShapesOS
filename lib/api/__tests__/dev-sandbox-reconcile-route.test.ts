// ShapesOS — /api/cron/dev-sandbox-reconcile tenant scoping: a user session
// reconciles ONLY its own workspace, even though the cron secret may sweep
// all of them. Cross-tenant denial is pinned: the session path must never
// enumerate workspaces.
// Run: npx tsx --test --experimental-test-module-mocks lib/api/__tests__/dev-sandbox-reconcile-route.test.ts

import { before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

const reconciled: string[] = [];
let workspaceFindManyCalls = 0;
let gateResult: unknown;

mock.module("@/lib/cron/gate", {
  namedExports: { cronGate: async () => gateResult },
});
mock.module("@/lib/prisma", {
  namedExports: {
    prisma: {
      workspace: {
        findMany: async () => {
          workspaceFindManyCalls++;
          return [{ id: "ws-other" }, { id: "ws-third" }];
        },
      },
    },
  },
});
mock.module("@/lib/sandbox/dev-sandbox", {
  namedExports: {
    reconcileDevSandboxes: async (ws: string) => {
      reconciled.push(ws);
      return { markedPaused: 0, ceilingDestroyed: 0 };
    },
  },
});

let POST: typeof import("@/app/api/cron/dev-sandbox-reconcile/route").POST;
before(async () => {
  ({ POST } = await import("@/app/api/cron/dev-sandbox-reconcile/route"));
});

const req = () => new Request("https://app.test/api/cron/dev-sandbox-reconcile", { method: "POST" });

describe("dev-sandbox-reconcile route scoping", () => {
  it("a user session reconciles ONLY its own workspace (no enumeration)", async () => {
    reconciled.length = 0;
    workspaceFindManyCalls = 0;
    gateResult = { isCron: false, userId: "u1", workspaceId: "ws-own" };
    const res = await POST(req() as never);
    assert.equal(res.status, 200);
    assert.deepEqual(reconciled, ["ws-own"], "session sweeps its own workspace only");
    assert.equal(workspaceFindManyCalls, 0, "session path must never enumerate workspaces");
  });

  it("the cron secret may sweep all workspaces", async () => {
    reconciled.length = 0;
    gateResult = { isCron: true, userId: null, workspaceId: null };
    const res = await POST(req() as never);
    assert.equal(res.status, 200);
    assert.deepEqual(reconciled, ["ws-other", "ws-third"]);
  });

  it("a rejected gate passes through untouched", async () => {
    reconciled.length = 0;
    gateResult = Response.json({ error: "Unauthorized" }, { status: 401 });
    const res = await POST(req() as never);
    assert.equal(res.status, 401);
    assert.deepEqual(reconciled, [], "no reconcile on a rejected gate");
  });
});
