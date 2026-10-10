// Phase 21A round 2 (WS=agentweb): who may take the next browser step in a session (PURE).
// A person can pause, take over and hand back, require approval of every step, and the session
// has step, time and credit caps. Reads are stopped too when a person says stop, because
// "paused" means the agent does nothing until told.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { creditsOf, fingerprint, gate, READ_TOOLS, transition, type SessionState } from "../control";

const T0 = Date.parse("2026-10-10T12:00:00.000Z");
const base = (over: Partial<SessionState> = {}): SessionState => ({
  control: "agent",
  stepMode: "auto",
  steps: 3,
  maxSteps: 60,
  startedAt: T0,
  maxSeconds: 1800,
  costMicroUsd: 0,
  maxCredits: 150,
  pending: null,
  lastNote: null,
  ...over,
});
const NOW = T0 + 60_000;

describe("gate", () => {
  it("lets the agent through when nothing is wrong", () => {
    assert.deepEqual(gate(base(), "browser_click", { ref: "e3" }, NOW), { allow: true });
  });

  it("paused and human-controlled sessions stop every tool, reads included", () => {
    for (const control of ["paused", "human"] as const) {
      for (const tool of ["browser_click", "browser_snapshot", "browser_navigate"]) {
        const g = gate(base({ control }), tool, {}, NOW);
        assert.equal(g.allow, false);
        if (!g.allow) assert.equal(g.reason, control === "paused" ? "paused" : "human_control");
      }
    }
  });

  it("the step, time and credit caps stop the session and ask for a person", () => {
    const steps = gate(base({ steps: 60 }), "browser_click", {}, NOW);
    assert.deepEqual(steps.allow === false && [steps.reason, steps.needs], ["cap_steps", "cap_steps"]);
    const time = gate(base(), "browser_snapshot", {}, T0 + 1801_000);
    assert.deepEqual(time.allow === false && [time.reason, time.needs], ["cap_time", "cap_time"]);
    // 150 credits = 150 / 1.5 / 100 USD = $1.00 = 1,000,000 micro-USD
    const credits = gate(base({ costMicroUsd: 1_000_000 }), "browser_click", {}, NOW);
    assert.deepEqual(credits.allow === false && [credits.reason, credits.needs], ["cap_credits", "cap_credits"]);
    assert.equal(gate(base({ costMicroUsd: 990_000 }), "browser_click", {}, NOW).allow, true);
  });

  it("approve-each: a click, type or navigate waits as a proposal; reads still run", () => {
    const s = base({ stepMode: "approve_each" });
    const g = gate(s, "browser_click", { ref: "e3" }, NOW);
    assert.equal(g.allow, false);
    if (!g.allow) {
      assert.equal(g.reason, "proposal");
      assert.deepEqual(g.propose, { tool: "browser_click", args: { ref: "e3" } });
    }
    for (const tool of READ_TOOLS) assert.equal(gate(s, tool, {}, NOW).allow, true, tool);
  });

  it("an unchanged pending proposal does not propose again; a different step replaces it", () => {
    const pending = { id: "p1", tool: "browser_click", args: { ref: "e3" }, summary: "Click e3", proposedAt: "2026-10-10T12:00:30.000Z" };
    const same = gate(base({ stepMode: "approve_each", pending }), "browser_click", { ref: "e3" }, NOW);
    assert.equal(same.allow === false && same.propose, undefined);
    const other = gate(base({ stepMode: "approve_each", pending }), "browser_click", { ref: "e9" }, NOW);
    assert.deepEqual(other.allow === false && other.propose, { tool: "browser_click", args: { ref: "e9" } });
  });

  it("a note for the agent (the person rejected its step, or ran it themselves) is delivered once, on the next non-read step", () => {
    const s = base({ lastNote: "The person rejected your proposed step. Do not repeat it." });
    const g = gate(s, "browser_click", { ref: "e3" }, NOW);
    assert.equal(g.allow, false);
    if (!g.allow) assert.deepEqual([g.reason, g.message, g.consumeNote], ["note", "The person rejected your proposed step. Do not repeat it.", true]);
    assert.equal(gate(s, "browser_snapshot", {}, NOW).allow, true, "reads are not blocked by a note");
  });

  it("a control change beats a note: paused is reported first", () => {
    const g = gate(base({ control: "paused", lastNote: "x" }), "browser_click", {}, NOW);
    assert.equal(g.allow === false && g.reason, "paused");
  });
});

describe("transition", () => {
  it("pause and resume", () => {
    assert.deepEqual(transition("agent", "pause"), { ok: true, to: "paused" });
    assert.deepEqual(transition("paused", "resume"), { ok: true, to: "agent" });
    assert.equal(transition("agent", "resume").ok, false);
    assert.equal(transition("human", "pause").ok, false);
  });
  it("take over from the agent or from a pause; hand back only from human", () => {
    assert.deepEqual(transition("agent", "takeover"), { ok: true, to: "human" });
    assert.deepEqual(transition("paused", "takeover"), { ok: true, to: "human" });
    assert.deepEqual(transition("human", "handback"), { ok: true, to: "agent" });
    assert.equal(transition("agent", "handback").ok, false);
    assert.equal(transition("human", "takeover").ok, false);
  });
});

describe("helpers", () => {
  it("fingerprint ignores key order", () => {
    assert.equal(fingerprint("browser_type", { ref: "e1", text: "x" }), fingerprint("browser_type", { text: "x", ref: "e1" }));
    assert.notEqual(fingerprint("browser_type", { ref: "e1" }), fingerprint("browser_click", { ref: "e1" }));
  });
  it("credits follow the 1.5x model-cost rule used everywhere else", () => {
    assert.equal(creditsOf(0), 0);
    assert.equal(creditsOf(1_000_000), 150);
    assert.equal(creditsOf(1), 1);
  });
});
