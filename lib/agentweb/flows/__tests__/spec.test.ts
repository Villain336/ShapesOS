// Phase 21A round 2 (WS=agentweb): "teach once" — a recorded session becomes a parameterised flow
// (PURE). The recording keeps WHAT was clicked or typed into (role, name, stable attributes), never
// the typed text: typed values become parameters, and sensitive fields are marked "asked at run time".
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFlow, locatorOf, validateFlow, FlowError } from "../spec";
import type { ElementInfo } from "../../types";

const el = (over: Partial<ElementInfo>): ElementInfo => ({ ref: "e1", role: "button", name: "Go", ...over });
const ev = (payload: Record<string, unknown>) => ({ type: "browser", payload });

describe("locatorOf", () => {
  it("keeps role, name and stable attributes; strips query strings and fragments from links", () => {
    assert.deepEqual(locatorOf(el({ role: "link", name: "Pricing", href: "https://a.test/pricing?utm=abc&session=zzz#top" })), { role: "link", name: "Pricing", href: "https://a.test/pricing" });
    assert.deepEqual(locatorOf(el({ role: "textbox", name: "Email", fieldName: "email", type: "email" })), { role: "textbox", name: "Email", fieldName: "email", inputType: "email" });
  });
  it("clips long names", () => {
    assert.ok(locatorOf(el({ name: "x".repeat(500) })).name.length <= 120);
  });
});

describe("buildFlow", () => {
  const events = [
    ev({ tool: "browser_navigate", url: "https://shop.test/" }),
    ev({ tool: "browser_snapshot", url: "https://shop.test/" }),
    ev({ tool: "browser_type", locator: { role: "textbox", name: "Search", fieldName: "q" }, chars: 5 }),
    ev({ tool: "browser_click", locator: { role: "button", name: "Go" } }),
    ev({ tool: "browser_type", locator: { role: "textbox", name: "Password", fieldName: "pw", inputType: "password" }, chars: 8 }),
    ev({ tool: "browser_click", locator: { role: "link", name: "Pricing", href: "https://shop.test/pricing" } }),
  ];

  it("turns navigate, type and click into steps and ignores reads", () => {
    const f = buildFlow(events, { name: "Search the shop" });
    assert.equal(f.origin, "https://shop.test");
    assert.deepEqual(f.steps.map((s) => s.kind), ["navigate", "type", "click", "type", "click"]);
  });

  it("typed text becomes a parameter; its value is never recorded", () => {
    const f = buildFlow(events, { name: "x" });
    assert.deepEqual(f.params.map((p) => [p.key, p.label, p.sensitive]), [["p1", "Search", false], ["p2", "Password", true]]);
    assert.ok(!JSON.stringify(f).includes("hunter"));
    const typed = f.steps.filter((s) => s.kind === "type");
    assert.deepEqual(typed.map((s) => s.kind === "type" && s.param), ["p1", "p2"]);
  });

  it("stops at the first step on another site, and says so", () => {
    const f = buildFlow([...events, ev({ tool: "browser_navigate", url: "https://other.test/" }), ev({ tool: "browser_click", locator: { role: "button", name: "Elsewhere" } })], { name: "x" });
    assert.equal(f.steps.length, 5);
    assert.equal(f.truncated, "The session left https://shop.test; the flow stops there.");
  });

  it("skips steps the safety gate stopped (a refused or handed-off click is not part of the flow)", () => {
    const f = buildFlow([...events, ev({ tool: "browser_click", locator: { role: "button", name: "Place order" }, decision: "handoff" }), ev({ tool: "browser_click", locator: { role: "button", name: "Delete" }, decision: "refuse" })], { name: "x" });
    assert.ok(!f.steps.some((s) => s.kind === "click" && s.locator.name === "Place order"));
    assert.ok(!f.steps.some((s) => s.kind === "click" && s.locator.name === "Delete"));
  });

  it("a session with nothing to repeat is refused", () => {
    assert.throws(() => buildFlow([ev({ tool: "browser_navigate", url: "https://shop.test/" })], { name: "x" }), FlowError);
    assert.throws(() => buildFlow([], { name: "x" }), FlowError);
  });
});

describe("validateFlow", () => {
  it("accepts what buildFlow makes and rejects what a hand edit could break", () => {
    const f = buildFlow([ev({ tool: "browser_navigate", url: "https://shop.test/" }), ev({ tool: "browser_click", locator: { role: "button", name: "Go" } })], { name: "x" });
    assert.deepEqual(validateFlow(f), f);
    assert.throws(() => validateFlow({ ...f, steps: [{ kind: "navigate", url: "javascript:alert(1)" }] }), FlowError);
    assert.throws(() => validateFlow({ ...f, steps: [{ kind: "type", locator: { role: "textbox", name: "x" }, param: "nope" }] }), FlowError);
    assert.throws(() => validateFlow({ ...f, steps: [{ kind: "teleport" }] }), FlowError);
    assert.throws(() => validateFlow({ ...f, steps: Array.from({ length: 80 }, () => ({ kind: "click", locator: { role: "button", name: "x" } })) }), FlowError);
  });
});
