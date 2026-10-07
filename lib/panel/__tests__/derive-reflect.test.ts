// Phase 19B (WS=panel) — persona derivation and the 4 reflection lenses.
// Ported from the prototype's test/derive.test.ts (4 derivation cases; its
// 3 founder-edit cases are in persona.test.ts) and test/reflections.test.ts
// (4). The model is a scripted MockLlmProvider (the router's own boundary
// fake), never a network call. Added: citations are enforced in code.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockLlmProvider, type MockChatStep } from "@/lib/llm/mock";
import type { ChatRequest } from "@/lib/llm/types";
import { PanelLedger } from "../budget";
import { derivePersonaSpec } from "../derive";
import { InMemoryMemoryStore } from "../memory";
import { RouterPanelModel } from "../model";
import { FRAGMENTS, validatePersonaSpec } from "../persona";
import { MAX_OBSERVATIONS_PER_LENS, REFLECTION_LENSES, runReflections } from "../reflections";
import { INTERVIEW_TEXT } from "./fixtures";

const DERIVED = {
  identity: { name: "Priya Nair", role: "Ops Manager", company: "logistics company" },
  goals: ["cut Monday reporting from 3 hours", "connect warehouse system without a consultant"],
  occupation: "Operations Manager",
  bigFive: { openness: 0.6, conscientiousness: 0.8, extraversion: 0.4, agreeableness: 0.5, neuroticism: 0.3 },
  preferences: { likes: ["direct integrations"], dislikes: ["spreadsheet stitching"], interests: ["warehouse automation"] },
  skills: ["spreadsheet reporting"],
  beliefs: ["Vendor claims about setup time are lies until proven otherwise"],
  behaviors: { general: ["does reporting manually on Mondays"], routines: ["reviews metrics weekly"] },
  budget: { currency: "USD", monthlyMax: 100, hardCap: false, notes: "CFO sign-off above $100/mo" },
  skepticism: 0.8,
  knownObjections: [
    { text: "Don't believe setup-time claims — last vendor promised 5 minutes, took 3 weeks.", severity: "high", sourceTranscriptId: "t-derive" },
    { text: "Per-seat pricing is a non-starter at team scale.", severity: "high", sourceTranscriptId: "t-derive" },
  ],
  sourceTranscriptIds: ["t-derive"],
};

function tool(name: string, input: unknown): MockChatStep {
  return { content: [{ type: "tool_use", id: "x", name, input: input as Record<string, unknown> }], model: "claude-haiku-4-5", usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } };
}

async function setup(script: MockChatStep[], withTranscript = true) {
  const store = new InMemoryMemoryStore();
  if (withTranscript) await store.addTranscript({ id: "t-derive", text: INTERVIEW_TEXT, interviewee: "Priya Nair", createdAt: Date.now() });
  const provider = new MockLlmProvider({ chatScript: script });
  const ledger = new PanelLedger();
  ledger.beginRun("derive", 1000);
  return { store, provider, ledger, model: new RouterPanelModel(provider, "claude-haiku-4-5", ledger) };
}

describe("derivePersonaSpec", () => {
  it("derives a valid spec whose objections cite the transcript", async () => {
    const { store, model, ledger } = await setup([tool("submit_persona", DERIVED)]);
    const { spec, droppedObjections } = await derivePersonaSpec({ model, store, transcriptId: "t-derive", runId: "derive" });
    assert.deepEqual(validatePersonaSpec(spec), []);
    assert.equal(spec.identity.name, "Priya Nair");
    assert.equal(spec.skepticism, 0.8);
    assert.equal(spec.knownObjections.length, 2);
    assert.ok(spec.knownObjections.every((o) => o.sourceTranscriptId === "t-derive"));
    assert.deepEqual(spec.sourceTranscriptIds, ["t-derive"]);
    assert.deepEqual(droppedObjections, []);
    assert.equal(ledger.spend("derive").callCount, 1);
  });

  it("composes fragments onto the derived base", async () => {
    const { store, model } = await setup([tool("submit_persona", DERIVED)]);
    const { spec } = await derivePersonaSpec({ model, store, transcriptId: "t-derive", fragments: [FRAGMENTS["hostile-cfo"]!], runId: "derive" });
    assert.equal(spec.occupation, "Chief Financial Officer");
    assert.equal(spec.skepticism, 0.95);
    assert.ok(spec.goals.includes("cut Monday reporting from 3 hours"));
  });

  it("throws when the transcript does not exist", async () => {
    const { store, model } = await setup([tool("submit_persona", DERIVED)], false);
    await assert.rejects(derivePersonaSpec({ model, store, transcriptId: "nope", runId: "derive" }), /No transcript/);
  });

  it("fails honestly when the model never returns a valid persona", async () => {
    const { store, model } = await setup([{ content: [{ type: "text", text: "not json at all" }], model: "claude-haiku-4-5" }]);
    await assert.rejects(derivePersonaSpec({ model, store, transcriptId: "t-derive", runId: "derive" }), /did not match its schema twice/);
  });

  it("drops an objection the interview never voiced, and cites only the given transcript", async () => {
    const invented = { ...DERIVED, knownObjections: [...DERIVED.knownObjections, { text: "Your mobile app crashes on Android tablets constantly.", severity: "high" }], sourceTranscriptIds: ["t-derive", "t-someone-else"] };
    const { store, model } = await setup([tool("submit_persona", invented)]);
    const { spec, droppedObjections } = await derivePersonaSpec({ model, store, transcriptId: "t-derive", runId: "derive" });
    assert.deepEqual(droppedObjections, ["Your mobile app crashes on Android tablets constantly."]);
    assert.equal(spec.knownObjections.length, 2);
    assert.deepEqual(spec.sourceTranscriptIds, ["t-derive"]);
  });

  it("shows the model only this transcript's evidence (no other interview leaks in)", async () => {
    let seen = "";
    const { store, model } = await setup([(req: ChatRequest) => ((seen = String(req.messages[0]!.content)), tool("submit_persona", DERIVED) as never)]);
    await store.addTranscript({ id: "t-other", text: "Zebra-striped invoices are my one and only pricing concern.", createdAt: Date.now() });
    await derivePersonaSpec({ model, store, transcriptId: "t-derive", runId: "derive" });
    assert.match(seen, /warehouse system/);
    assert.doesNotMatch(seen, /Zebra-striped/);
  });
});

describe("runReflections", () => {
  const many = { observations: Array.from({ length: 25 }, (_, i) => `Observation ${i + 1}: price and trust matter more than features.`) };

  it("runs all four lenses and caps each at 20 observations", async () => {
    const { store, model, ledger } = await setup([tool("submit_observations", many)]);
    const results = await runReflections({ model, store, transcriptId: "t-derive", runId: "derive" });
    assert.deepEqual(results.map((r) => r.lensId), ["price-skeptic", "workflow-fit", "trust-auditor", "competitor-comparer"]);
    for (const r of results) {
      assert.equal(r.nodes.length, 20);
      for (const n of r.nodes) {
        assert.equal(n.kind, "reflection");
        assert.equal(n.transcriptId, "t-derive");
        assert.equal(n.lens, r.lensId);
      }
    }
    assert.equal(MAX_OBSERVATIONS_PER_LENS, 20);
    assert.equal(ledger.spend("derive").callCount, 4);
  });

  it("stores reflections retrievable by kind", async () => {
    const { store, model } = await setup([tool("submit_observations", { observations: ["Budget hard cap at $100/mo.", "Distrusts setup-time claims."] })]);
    await runReflections({ model, store, transcriptId: "t-derive", runId: "derive" });
    const hits = await store.retrieve("budget trust skepticism", { k: 10, kinds: ["reflection"] });
    assert.equal(hits.length, 8);
    assert.ok(hits.every((h) => h.node.kind === "reflection"));
  });

  it("honors a custom maxPerLens and skips blank observations", async () => {
    const { store, model, ledger } = await setup([tool("submit_observations", { observations: ["one", "  ", "two", "three"] })]);
    const results = await runReflections({ model, store, transcriptId: "t-derive", lenses: [REFLECTION_LENSES[0]!], runId: "derive", maxPerLens: 2 });
    assert.deepEqual(results[0]!.nodes.map((n) => n.content), ["one", "two"]);
    assert.equal(ledger.spend("derive").callCount, 1);
  });

  it("throws when the transcript does not exist", async () => {
    const { store, model } = await setup([tool("submit_observations", many)], false);
    await assert.rejects(runReflections({ model, store, transcriptId: "nope", runId: "derive" }), /No transcript/);
  });
});
