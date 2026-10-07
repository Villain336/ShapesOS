// Phase 19B (WS=panel) — the hard per-run credit cap and the model seam.
// Ported from the prototype's test/costs.test.ts (11), test/backend.test.ts
// (10) and test/cache.test.ts (5). The prototype's own HTTP backends are
// gone (every call goes through the ShapesOS router), so the backend cases
// now test RouterPanelModel over a MockLlmProvider — the boundary fake the
// router itself ships — and the cases that only checked the prototype's env
// selection (DR_MODEL_BACKEND) and its missing-API-key errors are replaced by
// the router's equivalents: the model is told which tool to call, refusals
// and invalid answers are retried once and then fail honestly.
//
// Worked examples (claude-haiku-4-5: $1 / 1M input, $5 / 1M output; credits =
// ceil(USD × 100 × 1.5)):
//   10,000 in + 2,000 out = $0.01 + $0.01 = $0.02 → 2 × 1.5 = 3 credits
//   worst case of a 30,000-char prompt with maxTokens 1,000:
//     in = ceil(30,000 / 3 × 1.2) = 12,000 → $0.012; out $0.005 → $0.017 → 2.55 → 3 credits

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { MockLlmProvider, type MockChatStep } from "@/lib/llm/mock";
import { creditsForUsage, isCapReached, PanelCapReachedError, PanelLedger, worstCaseCallCredits } from "../budget";
import { CachedPanelModel, PanelModelOutputError, RouterPanelModel, toolInputSchema } from "../model";

const HAIKU = "claude-haiku-4-5";
const TOOL = { name: "submit_answer", description: "Submit the answer.", schema: z.object({ verdict: z.enum(["buy", "no-buy", "maybe"]) }) };
const REQ = { purpose: "verdict", system: "You judge.", user: "verdict?", tool: TOOL, maxTokens: 200 };
const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: 0, cacheWriteTokens: 0 });
const answer = (input: Record<string, unknown>, model = HAIKU, u = usage(1000, 50)): MockChatStep => ({ content: [{ type: "tool_use", id: "t1", name: "submit_answer", input }], model, usage: u });

function modelWith(script: MockChatStep[], cap = 1000) {
  const provider = new MockLlmProvider({ chatScript: script });
  const ledger = new PanelLedger();
  ledger.beginRun("run", cap);
  return { provider, ledger, model: new RouterPanelModel(provider, HAIKU, ledger) };
}

describe("credits (the router's billing rule)", () => {
  it("prices from the router's tables: 10k in + 2k out on haiku = 3 credits", () => {
    assert.equal(creditsForUsage(HAIKU, { inputTokens: 10_000, outputTokens: 2_000 }), 3);
  });

  it("zero usage costs nothing", () => {
    assert.equal(creditsForUsage(HAIKU, { inputTokens: 0, outputTokens: 0 }), 0);
  });

  it("an unknown model is billed at the most expensive known rate, never 0", () => {
    assert.ok(creditsForUsage("some-future-model", { inputTokens: 100_000, outputTokens: 10_000 }) > creditsForUsage(HAIKU, { inputTokens: 100_000, outputTokens: 10_000 }));
  });

  it("the worst case of a call is input from its characters × 1.2 plus maxTokens out", () => {
    assert.equal(worstCaseCallCredits(HAIKU, 30_000, 1_000), 3);
  });
});

describe("PanelLedger (hard cap)", () => {
  it("tracks running totals per run", () => {
    const l = new PanelLedger();
    l.beginRun("walk-1", 100);
    l.settle(l.reserve("walk-1", 5), HAIKU, { inputTokens: 10_000, outputTokens: 2_000 }, "step");
    l.settle(l.reserve("walk-1", 5), HAIKU, { inputTokens: 10_000, outputTokens: 2_000 }, "step");
    assert.deepEqual(l.spend("walk-1"), { runId: "walk-1", capCredits: 100, spentCredits: 6, reservedCredits: 0, callCount: 2, inputTokens: 20_000, outputTokens: 4_000, refusedCalls: 0 });
    assert.deepEqual(l.spendByPurpose("walk-1"), { step: { calls: 2, credits: 6 } });
  });

  it("refuses a call BEFORE it is sent when its worst case would pass the cap", () => {
    const l = new PanelLedger();
    l.beginRun("walk-2", 10);
    l.settle(l.reserve("walk-2", 8), HAIKU, { inputTokens: 10_000, outputTokens: 2_000 });
    assert.throws(() => l.reserve("walk-2", 8), (e: unknown) => e instanceof PanelCapReachedError && e.spentCredits === 3 && e.neededCredits === 8);
    assert.equal(l.spend("walk-2").refusedCalls, 1);
  });

  it("spent never passes the cap: reservations of parallel calls count together", () => {
    const l = new PanelLedger();
    l.beginRun("walk-3", 10);
    const a = l.reserve("walk-3", 6);
    assert.throws(() => l.reserve("walk-3", 6), PanelCapReachedError);
    l.settle(a, HAIKU, { inputTokens: 10_000, outputTokens: 2_000 });
    assert.doesNotThrow(() => l.reserve("walk-3", 6));
  });

  it("a released reservation gives its credits back", () => {
    const l = new PanelLedger();
    l.beginRun("walk-4", 10);
    const r = l.reserve("walk-4", 10);
    l.release(r);
    assert.equal(l.spend("walk-4").reservedCredits, 0);
    assert.doesNotThrow(() => l.reserve("walk-4", 10));
  });

  it("rejects unknown runs, duplicate beginRun and a negative cap", () => {
    const l = new PanelLedger();
    assert.throws(() => l.reserve("nope", 1), /Unknown run/);
    l.beginRun("walk-5", 1);
    assert.throws(() => l.beginRun("walk-5", 1), /already begun/);
    assert.throws(() => l.beginRun("walk-6", -1), /capCredits/);
  });

  it("isCapReached recognises the cap error (and nothing else)", () => {
    assert.equal(isCapReached(new PanelCapReachedError("r", 1, 1, 1)), true);
    assert.equal(isCapReached(new Error("other")), false);
  });
});

describe("RouterPanelModel (structured output through the router)", () => {
  it("returns the validated tool input and charges the run", async () => {
    const { model, ledger } = modelWith([answer({ verdict: "maybe" })]);
    const res = await model.structured("run", REQ);
    assert.deepEqual(res.value, { verdict: "maybe" });
    // 1,000 in + 50 out on haiku = $0.00125 → 0.1875 → 1 credit.
    assert.equal(res.credits, 1);
    assert.equal(ledger.spend("run").spentCredits, 1);
  });

  it("forces the named tool (not JSON mode) and names it in the system prompt", async () => {
    const { model, provider } = modelWith([answer({ verdict: "buy" })]);
    await model.structured("run", REQ);
    const req = provider.chatCalls[0]!;
    assert.deepEqual(req.toolChoice, { name: "submit_answer" });
    assert.deepEqual(req.tools?.map((t) => t.name), ["submit_answer"]);
    assert.match(String(req.system), /calling the submit_answer tool/);
  });

  it("retries once with the reason when the answer fails its schema, then succeeds", async () => {
    const { model, provider, ledger } = modelWith([answer({ verdict: "definitely" }), answer({ verdict: "no-buy" })]);
    const res = await model.structured("run", REQ);
    assert.equal(res.value.verdict, "no-buy");
    assert.equal(provider.chatCalls.length, 2);
    assert.equal(ledger.spend("run").callCount, 2, "both attempts are charged");
  });

  it("throws PanelModelOutputError after two bad answers (never a guess)", async () => {
    const { model } = modelWith([{ content: [{ type: "text", text: '{"verdict":"buy"}' }], model: HAIKU, usage: usage(10, 10) }]);
    await assert.rejects(model.structured("run", REQ), PanelModelOutputError);
  });

  it("does not send a call that would pass the cap", async () => {
    const { model, provider } = modelWith([answer({ verdict: "buy" })], 0);
    await assert.rejects(model.structured("run", REQ), PanelCapReachedError);
    assert.equal(provider.chatCalls.length, 0);
  });

  it("a provider error gives the reservation back and propagates", async () => {
    const { model, ledger } = modelWith([new Error("provider down")]);
    await assert.rejects(model.structured("run", REQ), /provider down/);
    assert.equal(ledger.spend("run").reservedCredits, 0);
  });

  it("prices on the model the router actually used (failover)", async () => {
    const { model } = modelWith([answer({ verdict: "buy" }, "claude-sonnet-5-5", usage(10_000, 2_000))]);
    // sonnet 5.5: 10,000 × $2/M + 2,000 × $10/M = $0.04 → 4 × 1.5 = 6 credits (haiku would be 3).
    const res = await model.structured("run", REQ);
    assert.equal(res.model, "claude-sonnet-5-5");
    assert.equal(res.credits, 6);
  });

  it("toolInputSchema turns a zod object into a JSON schema object", () => {
    const s = toolInputSchema(TOOL.schema);
    assert.equal(s.type, "object");
    assert.deepEqual(s.required, ["verdict"]);
  });
});

describe("CachedPanelModel", () => {
  it("dedupes identical calls — the inner model runs once, a hit costs 0", async () => {
    const { model, provider } = modelWith([answer({ verdict: "buy" })]);
    const cached = new CachedPanelModel(model);
    const r1 = await cached.structured("run", REQ);
    const r2 = await cached.structured("run", REQ);
    assert.equal(provider.chatCalls.length, 1);
    assert.deepEqual(r2.value, r1.value);
    assert.equal(r2.credits, 0);
    assert.equal(r2.cached, true);
    assert.deepEqual(cached.stats(), { hits: 1, misses: 1, savedCredits: 1 });
  });

  it("misses when system, prompt or maxTokens differ", async () => {
    const { model, provider } = modelWith([answer({ verdict: "buy" })]);
    const cached = new CachedPanelModel(model);
    await cached.structured("run", REQ);
    await cached.structured("run", { ...REQ, system: "different" });
    await cached.structured("run", { ...REQ, user: "different" });
    await cached.structured("run", { ...REQ, maxTokens: 100 });
    assert.equal(provider.chatCalls.length, 4);
    assert.equal(cached.stats().hits, 0);
  });

  it("a different model is always a miss", async () => {
    const a = modelWith([answer({ verdict: "buy" })]);
    const b = new RouterPanelModel(a.provider, "claude-sonnet-5-5", a.ledger);
    const ca = new CachedPanelModel(a.model);
    const cb = new CachedPanelModel(b);
    await ca.structured("run", REQ);
    await cb.structured("run", REQ);
    assert.equal(a.provider.chatCalls.length, 2);
  });

  it("clear() empties the cache and resets stats", async () => {
    const { model, provider } = modelWith([answer({ verdict: "buy" })]);
    const cached = new CachedPanelModel(model);
    await cached.structured("run", REQ);
    await cached.structured("run", REQ);
    cached.clear();
    assert.deepEqual(cached.stats(), { hits: 0, misses: 0, savedCredits: 0 });
    await cached.structured("run", REQ);
    assert.equal(provider.chatCalls.length, 2);
  });
});
