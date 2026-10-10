// Phase 21A round 2 (WS=agentweb): running a taught flow (PURE over an actor). The runner finds each
// control again with self-healing locators, never types a sensitive value, and STOPS for a person
// (a "human check") instead of guessing, retrying around a block or pushing through a gate.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runFlow, type ActorResult, type FlowActor } from "../run";
import type { FlowSpec } from "../spec";
import type { ElementInfo } from "../../types";

const el = (over: Partial<ElementInfo>): ElementInfo => ({ ref: "e1", role: "button", name: "Go", ...over });

const spec: FlowSpec = {
  v: 1,
  name: "Search",
  origin: "https://shop.test",
  params: [
    { key: "p1", label: "Search", sensitive: false },
    { key: "p2", label: "Password", sensitive: true },
  ],
  steps: [
    { kind: "navigate", url: "https://shop.test/" },
    { kind: "type", locator: { role: "textbox", name: "Search", fieldName: "q" }, param: "p1" },
    { kind: "click", locator: { role: "button", name: "Go" } },
  ],
};

function fakeActor(pages: ElementInfo[][], over: Partial<Record<"navigate" | "click" | "type", ActorResult>> = {}) {
  const calls: string[] = [];
  let page = 0;
  const actor: FlowActor = {
    async navigate(url) {
      calls.push(`navigate ${url}`);
      return over.navigate ?? { ok: true };
    },
    async controls() {
      return pages[Math.min(page, pages.length - 1)];
    },
    async click(ref) {
      calls.push(`click ${ref}`);
      page += 1;
      return over.click ?? { ok: true };
    },
    async type(ref, text) {
      calls.push(`type ${ref} ${text}`);
      return over.type ?? { ok: true };
    },
  };
  return { actor, calls };
}

describe("runFlow", () => {
  it("runs every step and fills the parameter", async () => {
    const { actor, calls } = fakeActor([[el({ ref: "e1", role: "textbox", name: "Search", fieldName: "q" }), el({ ref: "e2", name: "Go" })]]);
    const out = await runFlow(spec, { p1: "boots" }, actor);
    assert.equal(out.status, "done");
    assert.deepEqual(calls, ["navigate https://shop.test/", "type e1 boots", "click e2"]);
  });
  it("heals a relabelled control and says how", async () => {
    const { actor, calls } = fakeActor([[el({ ref: "e7", role: "textbox", name: "Find products", fieldName: "q" }), el({ ref: "e8", name: "Go" })]]);
    const out = await runFlow(spec, { p1: "boots" }, actor);
    assert.equal(out.status, "done");
    assert.deepEqual(calls[1], "type e7 boots");
    assert.deepEqual(out.status === "done" && out.healed, [{ step: 1, how: "attribute" }]);
  });
  it("stops with a human check when a control cannot be found, and does nothing after", async () => {
    const { actor, calls } = fakeActor([[el({ ref: "e1", role: "textbox", name: "Search", fieldName: "q" })]]);
    const out = await runFlow(spec, { p1: "boots" }, actor);
    assert.equal(out.status, "stopped");
    assert.equal(out.status === "stopped" && out.reason, "not_found");
    assert.equal(out.status === "stopped" && out.at, 2);
    assert.equal(calls.length, 2);
  });
  it("stops on two equal matches and lists them", async () => {
    const { actor } = fakeActor([[el({ ref: "e1", role: "textbox", name: "Search", fieldName: "q" }), el({ ref: "e2", name: "Go" }), el({ ref: "e3", name: "Go" })]]);
    const out = await runFlow(spec, { p1: "boots" }, actor);
    assert.equal(out.status === "stopped" && out.reason, "ambiguous");
    assert.equal(out.status === "stopped" && out.candidates?.length, 2);
  });
  it("refuses to start when a required value is missing, before touching the page", async () => {
    const { actor, calls } = fakeActor([[]]);
    const out = await runFlow(spec, {}, actor);
    assert.equal(out.status === "stopped" && out.reason, "missing_param");
    assert.equal(calls.length, 0);
  });
  it("never types a sensitive value, even when one is supplied: the person types it", async () => {
    const withPw: FlowSpec = { ...spec, steps: [spec.steps[0], { kind: "type", locator: { role: "textbox", name: "Password", fieldName: "pw", inputType: "password" }, param: "p2" }] };
    const { actor, calls } = fakeActor([[el({ ref: "e1", role: "textbox", name: "Password", fieldName: "pw", type: "password" })]]);
    const out = await runFlow(withPw, { p2: "hunter2" }, actor);
    assert.equal(out.status === "stopped" && out.reason, "sensitive_field");
    assert.ok(!calls.some((c) => c.includes("hunter2")));
    assert.equal(calls.length, 1);
  });
  it("a gate that asks or refuses ends the run for a person; it is not retried or worked around", async () => {
    const { actor, calls } = fakeActor([[el({ ref: "e1", role: "textbox", name: "Search", fieldName: "q" }), el({ ref: "e2", name: "Go" })]], { click: { ok: false, kind: "needs_person", message: "Sending asks first." } });
    const out = await runFlow(spec, { p1: "x" }, actor);
    assert.equal(out.status === "stopped" && out.reason, "needs_person");
    assert.equal(calls.filter((c) => c.startsWith("click")).length, 1);
  });
  it("a site that says no is reported as such, with no second attempt", async () => {
    const { actor, calls } = fakeActor([[]], { navigate: { ok: false, kind: "blocked_by_site", message: "challenge" } });
    const out = await runFlow(spec, { p1: "x" }, actor);
    assert.equal(out.status === "stopped" && out.reason, "blocked_by_site");
    assert.equal(calls.length, 1);
  });
  it("a stopped run (abort signal) runs nothing more", async () => {
    const ac = new AbortController();
    ac.abort();
    const { actor, calls } = fakeActor([[]]);
    const out = await runFlow(spec, { p1: "x" }, actor, { signal: ac.signal });
    assert.equal(out.status === "stopped" && out.reason, "aborted");
    assert.equal(calls.length, 0);
  });
  it("a value that leaves the flow's own site is not followed: navigate steps are only the taught ones", async () => {
    const bad = { ...spec, steps: [{ kind: "navigate" as const, url: "https://evil.test/" }, spec.steps[2]] };
    const { actor, calls } = fakeActor([[]]);
    const out = await runFlow(bad, { p1: "x" }, actor);
    assert.equal(out.status, "stopped");
    assert.equal(calls.length, 0);
  });
});
