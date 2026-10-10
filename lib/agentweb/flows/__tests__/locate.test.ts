// Phase 21A round 2 (WS=agentweb): self-healing locators (PURE). Order: stable attribute, then role
// and name, then a close name match in the same role, then the text alone. Two equally good matches
// is never a guess: the run stops for a person (a "human check").
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveLocator } from "../locate";
import type { ElementInfo } from "../../types";

const el = (over: Partial<ElementInfo>): ElementInfo => ({ ref: "e1", role: "button", name: "Go", ...over });

describe("resolveLocator", () => {
  it("finds a field by its stable attribute even when the label changed", () => {
    const r = resolveLocator({ role: "textbox", name: "Search", fieldName: "q" }, [el({ ref: "e1", role: "textbox", name: "Find products", fieldName: "q" }), el({ ref: "e2", role: "textbox", name: "Email", fieldName: "email" })]);
    assert.equal(r.ok && r.element.ref, "e1");
    assert.equal(r.ok && r.how, "attribute");
  });
  it("finds a link by its address (no query string)", () => {
    const r = resolveLocator({ role: "link", name: "Pricing", href: "https://a.test/pricing" }, [el({ ref: "e1", role: "link", name: "Plans", href: "https://a.test/pricing?x=1" }), el({ ref: "e2", role: "link", name: "Home", href: "https://a.test/" })]);
    assert.equal(r.ok && r.element.ref, "e1");
    assert.equal(r.ok && r.how, "attribute");
  });
  it("falls back to role and name (case and spacing do not matter)", () => {
    const r = resolveLocator({ role: "button", name: "Add to  cart" }, [el({ ref: "e1", name: "Buy later" }), el({ ref: "e2", name: "add to cart" })]);
    assert.equal(r.ok && r.element.ref, "e2");
    assert.equal(r.ok && r.how, "role-name");
  });
  it("falls back to a close name in the same role", () => {
    const r = resolveLocator({ role: "button", name: "Add to cart" }, [el({ ref: "e1", name: "Add item to cart now" }), el({ ref: "e2", role: "link", name: "Help" })]);
    assert.equal(r.ok && r.element.ref, "e1");
    assert.equal(r.ok && r.how, "fuzzy");
  });
  it("falls back to the text alone when the role changed (a link became a button)", () => {
    const r = resolveLocator({ role: "link", name: "Contact sales" }, [el({ ref: "e1", role: "button", name: "Contact sales" })]);
    assert.equal(r.ok && r.element.ref, "e1");
    assert.equal(r.ok && r.how, "text");
  });
  it("two equally good matches is a human check, not a guess", () => {
    const r = resolveLocator({ role: "button", name: "Delete row" }, [el({ ref: "e1", name: "Delete row" }), el({ ref: "e2", name: "Delete row" })]);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "ambiguous");
    assert.equal(!r.ok && r.candidates.length, 2);
  });
  it("nothing close is a human check", () => {
    const r = resolveLocator({ role: "button", name: "Checkout" }, [el({ ref: "e1", name: "Home" })]);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "not_found");
  });
  it("prefers an enabled control over a disabled twin", () => {
    const r = resolveLocator({ role: "button", name: "Save" }, [el({ ref: "e1", name: "Save", disabled: true }), el({ ref: "e2", name: "Save" })]);
    assert.equal(r.ok && r.element.ref, "e2");
  });
  it("a typing locator never matches a button by text", () => {
    const r = resolveLocator({ role: "textbox", name: "Name", fieldName: "name" }, [el({ ref: "e1", role: "button", name: "Name" })], { needs: "field" });
    assert.equal(r.ok, false);
  });
  it("an unrelated one-word overlap does not count as a close match", () => {
    const r = resolveLocator({ role: "button", name: "Add to cart" }, [el({ ref: "e1", name: "Cart settings and billing" })]);
    assert.equal(r.ok, false);
  });
});
