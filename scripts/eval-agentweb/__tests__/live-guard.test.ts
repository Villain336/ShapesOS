// Phase 21A (WS=agentweb): the live run's guards. No model is called here: the
// budget arithmetic, the argument rules and the reply parser are tested; the live
// calls themselves are UNVERIFIED-LIVE (the owner has not approved a paid run).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Budget, BudgetExceeded, parseActorReply, worstCaseMicroUsd } from "../live";
import { parseArgs, runAgentwebEval, renderMarkdown } from "../runner";
import { controlsFromHtml } from "../fake-models";
import type { ChatResponse } from "../../../lib/llm/types";

describe("Budget", () => {
  it("lets calls through until the next one could pass the cap, then refuses without spending", () => {
    const b = new Budget(1_000_000); // $1.00
    b.reserve(400_000);
    b.record(350_000, 400_000);
    b.reserve(600_000); // 350k + 600k = 950k <= 1M
    b.record(null, 600_000); // unknown price: charged at the worst case
    assert.equal(b.spentMicroUsd, 950_000);
    assert.throws(() => b.reserve(100_000), BudgetExceeded);
    assert.equal(b.spentMicroUsd, 950_000);
  });
  it("refuses a cap of zero", () => {
    assert.throws(() => new Budget(0), /greater than zero/);
  });
  it("prices a worst case from characters, max output and the model's list price", () => {
    // 3,000 chars = 1,000 input tokens at $2/M = $0.002; 800 output tokens at $10/M = $0.008 -> $0.010
    assert.equal(worstCaseMicroUsd(3000, 800, { inputPerMTok: 2, outputPerMTok: 10 }), 10_000);
  });
});

describe("arguments", () => {
  it("a dry run needs nothing; a live run needs a positive cap", () => {
    assert.deepEqual(parseArgs(["--dry-run"]), { mode: "dry", maxUsd: 0, out: null });
    assert.throws(() => parseArgs(["--live"]), /--max-usd/);
    assert.throws(() => parseArgs(["--live", "--max-usd", "0"]), /--max-usd/);
    assert.deepEqual(parseArgs(["--live", "--max-usd", "5", "--out", "x"]), { mode: "live", maxUsd: 5, out: "x" });
  });
  it("refuses a key on the command line", () => {
    assert.throws(() => parseArgs(["--api-key", "sk-ant-x"]), /environment variable/);
    assert.throws(() => parseArgs(["--key=sk-ant-x"]), /environment variable/);
  });
  it("a live run without ANTHROPIC_API_KEY in the environment does not start", async () => {
    await assert.rejects(() => runAgentwebEval({ mode: "live", maxUsd: 1, out: null }, {}), /ANTHROPIC_API_KEY/);
  });
});

describe("a live run that hits the cap", () => {
  it("stops with a partial result and says why", async () => {
    const calls: string[] = [];
    const b = new Budget(100);
    const out = await runAgentwebEval(
      { mode: "live", maxUsd: 0.0001, out: null },
      { ANTHROPIC_API_KEY: "test" },
      {
        budget: b,
        models: {
          reader: { read: async () => { calls.push("read"); throw new BudgetExceeded(0, 100); } },
          actor: { propose: async () => [], compose: async () => "" },
        },
      },
    );
    assert.equal(out.passBar, false);
    assert.match(out.stopped!, /would pass its/);
    assert.match(renderMarkdown(out), /Stopped early/);
  });
});

describe("parseActorReply", () => {
  const html = `<form action="/x" method="post"><input name="q" placeholder="Search"><button>Send</button></form>`;
  const controls = controlsFromHtml(html, "https://a.test/");
  const input = { task: "t", view: "", controls, page: { url: "https://a.test/", origin: "https://a.test" }, secret: "s" };
  it("maps refs to the controls it was shown and drops refs it was not", () => {
    const r = parseActorReply(JSON.stringify({ steps: [{ kind: "type", ref: "e1", text: "shoes" }, { kind: "click", ref: "e2" }, { kind: "click", ref: "e99" }, { kind: "navigate", url: "https://a.test/y" }], answer: "done" }), input);
    assert.deepEqual(r.steps.map((s) => s.kind), ["type", "click", "navigate"]);
    assert.equal(r.answer, "done");
  });
  it("treats an unknown tool effect as a send (the strictest ordinary class)", () => {
    const r = parseActorReply(JSON.stringify({ steps: [{ kind: "tool", tool: "x", effect: "weird", args: {} }] }), input);
    assert.equal((r.steps[0] as { effect: string }).effect, "send");
  });
  it("keeps prose when the reply is not JSON", () => {
    assert.deepEqual(parseActorReply("The hours are 9-5.", input), { steps: [], answer: "The hours are 9-5." });
  });
});

void ({} as ChatResponse);
