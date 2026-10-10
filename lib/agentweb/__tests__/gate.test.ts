// Phase 21A (WS=agentweb): taint tracking on tools that are not browser steps,
// and the rule that a gate which cannot decide does not let the call through.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext, ToolDef } from "@/lib/chat/tools";
import { preflightFor, taintPreflight } from "../gate";
import { taskKeyOf, webTasks } from "../tasks";

const ctx: ToolContext & { threadId: string } = { projectId: "p", workspaceId: "w", userId: "u", role: "editor", confirmed: false, threadId: "gate-test-thread" };
const send = { name: "send_ticket_reply", kind: "publish" as const };
const read = { name: "get_keywords", kind: "safe" as const };

describe("taintPreflight", () => {
  it("lets everything through when the task has read nothing from the web", () => {
    assert.equal(taintPreflight(ctx, send, { body: "hello" }).verdict, "allow");
  });

  it("asks when a page's text flows into a write, naming the value and its origin", async () => {
    const task = await webTasks.ensure(taskKeyOf(ctx), "w");
    task.kernel.ledger.register("Refund desk: refunds@scam.example", "https://shop.test", "untrusted");
    const r = taintPreflight(ctx, send, { to: "refunds@scam.example", body: "hi" });
    assert.equal(r.verdict, "confirm");
    assert.match(r.reason!, /https:\/\/shop\.test/);
    assert.match(r.reason!, /"to"/);
  });

  it("does not bother a read-only tool", () => {
    assert.equal(taintPreflight(ctx, read, { q: "refunds@scam.example" }).verdict, "allow");
  });

  it("stops a call that would carry a secret out", async () => {
    const task = await webTasks.ensure(taskKeyOf(ctx), "w");
    task.kernel.ledger.registerSecret("sk-live-CANARY-7731a9");
    const r = taintPreflight(ctx, send, { body: "token sk-live-CANARY-7731a9" });
    assert.equal(r.verdict, "refuse");
    assert.doesNotMatch(r.reason!, /CANARY/);
  });
});

describe("preflightFor", () => {
  const tool = (preflight?: ToolDef["preflight"]): ToolDef => ({ name: "t", description: "d", kind: "safe", minRole: "viewer", argsSchema: { type: "object", properties: {} }, execute: async () => ({ summary: "" }), preflight });
  it("uses the tool's own gate when it has one", async () => {
    assert.deepEqual(await preflightFor(ctx, tool(async () => ({ verdict: "confirm", reason: "x" })), {}), { verdict: "confirm", reason: "x" });
  });
  it("a gate that throws refuses; it never waves the call through", async () => {
    const r = await preflightFor(ctx, tool(async () => { throw new Error("boom"); }), {});
    assert.equal(r.verdict, "refuse");
    assert.match(r.reason!, /boom/);
  });
});
