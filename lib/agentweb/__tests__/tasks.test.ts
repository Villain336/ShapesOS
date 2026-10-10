// Phase 21A (WS=agentweb): per-task browsing state.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskRegistry, taskKeyOf } from "../tasks";

describe("taskKeyOf", () => {
  it("prefers the thread, then the run, then the person", () => {
    assert.equal(taskKeyOf({ threadId: "t1", runId: "r1", workspaceId: "w", userId: "u" }), "t:t1");
    assert.equal(taskKeyOf({ runId: "r1", workspaceId: "w", userId: "u" }), "r:r1");
    assert.equal(taskKeyOf({ workspaceId: "w", userId: "u" }), "u:w:u");
  });
});

describe("TaskRegistry", () => {
  it("creates unscoped state once per key", async () => {
    const r = new TaskRegistry();
    const a = await r.ensure("k", "w");
    assert.equal(a.scoped, false);
    assert.equal(await r.ensure("k", "w"), a);
  });

  it("closes the session of an idle task", async () => {
    let t = 0;
    const r = new TaskRegistry({ idleMs: 1000, now: () => t });
    const task = await r.ensure("k", "w");
    let closed = 0;
    task.session = { close: async () => void closed++ } as never;
    t = 999;
    assert.equal(await r.reap(), 0);
    t = 1500;
    assert.equal(await r.reap(), 1);
    assert.equal(closed, 1);
    assert.equal(r.get("k"), undefined);
  });

  it("makes room by closing the least recently used task", async () => {
    let t = 0;
    const r = new TaskRegistry({ max: 2, idleMs: 1e9, now: () => t });
    await r.ensure("a", "w");
    t = 1;
    await r.ensure("b", "w");
    t = 2;
    r.get("a");
    t = 3;
    await r.ensure("c", "w");
    assert.deepEqual([r.get("a") !== undefined, r.get("b") !== undefined, r.get("c") !== undefined], [true, false, true]);
  });
});
