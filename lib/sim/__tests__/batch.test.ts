// Phase 19B (WS=engine) — the Batch API path for "deep" runs (Message
// Batches, 50 % of standard prices), behind the router's Anthropic provider.
// Tested against a FAKE Message Batches client with the documented shapes:
//   create({ requests: [{ custom_id, params }] }) → { id, processing_status }
//   retrieve(id) → { processing_status: "in_progress" | "canceling" | "ended" }
//   results(id)  → JSONL lines { custom_id, result: { type: "succeeded", message }
//                   | { type: "errored", error } | { type: "canceled" } | { type: "expired" } }
// (claude-api skill: shared Message Batches reference; results come in ANY
// order and are keyed by custom_id). The live call is UNVERIFIED-LIVE.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AnthropicLlmProvider, type AnthropicClientLike, type BatchesLike } from "@/lib/llm/anthropic";
import { __setChatSpendGate, __setChatUsageRecorder, type ChatUsageRecord } from "@/lib/llm/usage";
import { PanelLedger, creditsForUsage } from "@/lib/panel/budget";
import { BatchTownDecider } from "../batch";
import { DecisionCache, decisionKey, RulesDecider, type DecisionFacts, type DecisionRequest } from "../decisions";

type CreateParams = Parameters<BatchesLike["create"]>[0];
type ResultLine = { custom_id: string; result: { type: string; message?: unknown; error?: unknown } };

function fakeBatches(answer: (customId: string, params: CreateParams["requests"][number]["params"]) => ResultLine["result"], polls = 1) {
  const created: CreateParams[] = [];
  let retrieves = 0;
  const batches: BatchesLike = {
    async create(p) {
      created.push(structuredClone(p));
      return { id: "msgbatch_1", processing_status: "in_progress" };
    },
    async retrieve() {
      retrieves += 1;
      return { id: "msgbatch_1", processing_status: retrieves > polls ? "ended" : "in_progress" };
    },
    async results() {
      const reqs = created.at(-1)!.requests;
      // Any order: reversed.
      const lines: ResultLine[] = [...reqs].reverse().map((r) => ({ custom_id: r.custom_id, result: answer(r.custom_id, r.params) }));
      return (async function* () {
        for (const l of lines) yield l as never;
      })();
    },
  };
  const client = { messages: { create: async () => { throw new Error("not used"); }, stream: () => { throw new Error("not used"); }, batches } } as unknown as AnthropicClientLike;
  return { client, created, retrieves: () => retrieves };
}

const toolMessage = (params: { tools?: Array<{ name: string }> }, input: Record<string, unknown>) => ({
  id: `msg_${Math.random().toString(36).slice(2)}`,
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5",
  content: [{ type: "tool_use", id: "toolu_1", name: params.tools![0]!.name, input }],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 600, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: "batch" },
});

function facts(id: string, interest = 0.6): DecisionFacts {
  return {
    residentId: id,
    residentName: id,
    segment: "s",
    persona: null,
    calibrated: false,
    traits: { priceSensitivity: 0.5, adOpenness: 0.5, sociability: 0.5, skepticism: 0.5 },
    moneyCents: 10_000,
    productBudgetLeftCents: 5_000,
    interest,
    adopted: false,
    product: { name: "Lamp", category: "home", priceCents: 4_000, description: "" },
    effectivePriceCents: 4_000,
    discountPct: 0,
    weather: "sunny",
    when: "Monday (day 1) 23:00",
    stimulus: { experiences: [`${id} saw an ad.`] },
    memories: [],
  };
}
const reflect = (id: string): DecisionRequest => ({ point: "reflect", residentId: id, key: decisionKey("reflect", facts(id)), facts: facts(id) });

beforeEach(() => {
  // Unit tests: no database — the spend gate allows, the recorder is a no-op unless a test captures it.
  __setChatSpendGate(async () => ({ allowed: true }));
  __setChatUsageRecorder(async () => {});
});

afterEach(() => {
  __setChatUsageRecorder(null);
  __setChatSpendGate(null);
});

function setup(model = "claude-haiku-4-5", answer?: Parameters<typeof fakeBatches>[0]) {
  const fake = fakeBatches(answer ?? ((_, p) => ({ type: "succeeded", message: toolMessage(p as never, { summary: "Saw the lamp ad.", plan: "visit_store" }) })));
  const provider = new AnthropicLlmProvider("sk-test", model, { client: fake.client, workload: "copy" });
  const ledger = new PanelLedger();
  ledger.beginRun("run", 10_000);
  const sleeps: number[] = [];
  const decider = new BatchTownDecider({ provider, ledger, cache: new DecisionCache(), direct: new RulesDecider(), minBatch: 2, usage: { workspaceId: "ws1", actorId: null, billing: "tokens" }, sleep: async (ms) => void sleeps.push(ms), pollFirstMs: 1_000, pollMaxMs: 4_000 });
  return { fake, ledger, decider, sleeps };
}

describe("BatchTownDecider — request mapping", () => {
  it("one Message Batch per decision round: custom_id per request, structured tool, forced tool_choice where the model allows it", async () => {
    const { fake, decider } = setup();
    await decider.decideMany("run", [reflect("r001"), reflect("r002")]);
    assert.equal(fake.created.length, 1);
    const reqs = fake.created[0]!.requests;
    assert.equal(reqs.length, 2);
    assert.ok(reqs.every((r) => /^d\d+$/.test(r.custom_id)) && new Set(reqs.map((r) => r.custom_id)).size === 2);
    const p = reqs[0]!.params as unknown as { model: string; max_tokens: number; tools: Array<{ name: string; input_schema: { type: string; properties: Record<string, unknown> } }>; tool_choice: unknown; messages: Array<{ role: string }>; system: unknown };
    assert.equal(p.model, "claude-haiku-4-5");
    assert.equal(p.max_tokens, 360);
    assert.equal(p.tools[0]!.name, "nightly_reflection");
    assert.deepEqual(Object.keys(p.tools[0]!.input_schema.properties).sort(), ["plan", "summary"]);
    assert.deepEqual(p.tool_choice, { type: "tool", name: "nightly_reflection" });
    assert.equal(p.messages[0]!.role, "user");
  });

  it("never forces tool_choice on a model that rejects it (claude-opus-5-5)", async () => {
    const { fake, decider } = setup("claude-opus-5-5");
    await decider.decideMany("run", [reflect("r001"), reflect("r002")]);
    const p = fake.created[0]!.requests[0]!.params as unknown as { tool_choice?: { type: string }; system: unknown };
    assert.equal(p.tool_choice, undefined, "no forced choice: the API default (auto) applies");
    assert.match(JSON.stringify(p.system), /Answer ONLY by calling the nightly_reflection tool/);
  });

  it("a round smaller than minBatch goes direct (no batch)", async () => {
    const { fake, decider } = setup();
    const [d] = await decider.decideMany("run", [reflect("r001")]);
    assert.equal(fake.created.length, 0);
    assert.equal(d!.source, "rules");
  });
});

describe("BatchTownDecider — results mapping", () => {
  it("polls with backoff until ended, maps results by custom_id (any order), meters each at the batch tier (50 %)", async () => {
    const recorded: ChatUsageRecord[] = [];
    __setChatUsageRecorder(async (rec) => void recorded.push(rec));
    const { decider, sleeps, ledger, fake } = setup("claude-haiku-4-5", (id, p) =>
      ({ type: "succeeded", message: toolMessage(p as never, { summary: `answer for ${id}`, plan: id === "d1" ? "visit_store" : "nothing" }) }),
    );
    const out = await decider.decideMany("run", [reflect("r001"), reflect("r002")]);
    assert.deepEqual(sleeps, [1_000, 2_000]);
    assert.equal(fake.retrieves(), 2);
    assert.deepEqual(out.map((d) => [d.source, (d.value as { summary: string }).summary]), [
      ["model", "answer for d1"],
      ["model", "answer for d2"],
    ]);
    assert.equal(recorded.length, 2);
    assert.ok(recorded.every((r) => r.serviceTier === "batch" && r.context.workspaceId === "ws1"));
    const spent = ledger.spend("run").spentCredits;
    assert.equal(spent, 2 * creditsForUsage("claude-haiku-4-5", { inputTokens: 600, outputTokens: 40 }, { serviceTier: "batch" }));
    assert.equal(ledger.spend("run").reservedCredits, 0, "every reservation settled");
  });

  it("errored / expired / canceled results and schema failures fall back to rules, labelled; their reservation is released", async () => {
    const { decider, ledger } = setup("claude-haiku-4-5", (id, p) =>
      id === "d1" ? { type: "errored", error: { type: "invalid_request_error", message: "bad" } } : id === "d2" ? { type: "expired" } : { type: "succeeded", message: toolMessage(p as never, { summary: 42 }) },
    );
    const out = await decider.decideMany("run", [reflect("r001"), reflect("r002"), reflect("r003")]);
    assert.deepEqual(out.map((d) => d.source), ["rules", "rules", "rules"]);
    assert.match(out[0]!.note!, /errored/);
    assert.match(out[1]!.note!, /expired/);
    assert.match(out[2]!.note!, /schema/);
    assert.equal(ledger.spend("run").reservedCredits, 0);
    assert.equal(ledger.spend("run").callCount, 1, "only the answered (invalid) one was charged");
  });

  it("a cached decision is never put in a batch", async () => {
    const { fake, decider } = setup();
    await decider.decideMany("run", [reflect("r001"), reflect("r002")]);
    await decider.decideMany("run", [reflect("r001"), reflect("r002")]);
    assert.equal(fake.created.length, 1);
  });
});
