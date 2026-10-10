// Phase 21A (WS=agentweb): taint tracking. Values carry {origin, trust}; an
// untrusted page value may not reach a sensitive sink without a person's
// confirmation, and a secret may not reach any sink that is not its owner's.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaintLedger, checkFlow, type Sink } from "../taint";

const PAGE = "https://shop.test";

function ledger() {
  const l = new TaintLedger();
  l.register("Contact sales at deals@promo.example or call +44 20 7946 0958. Visit https://promo.example/offer today.", PAGE, "untrusted");
  l.registerSecret("sk-live-CANARY-7731a9");
  return l;
}

const sink = (kind: Sink["kind"], extra: Partial<Sink> = {}): Sink => ({ name: `t_${kind}`, kind, ...extra });

describe("checkFlow table (untrusted page data)", () => {
  const l = ledger();
  it("reading sinks take anything", () => {
    assert.equal(checkFlow(l, sink("read"), { q: "deals@promo.example" }).verdict, "allow");
  });
  for (const kind of ["send", "post", "file_write", "delete", "money", "fetch"] as const) {
    it(`an untrusted email address in a ${kind} sink needs confirmation`, () => {
      const r = checkFlow(l, sink(kind), { to: "deals@promo.example" });
      assert.equal(r.verdict, "confirm");
      assert.deepEqual(r.hits.map((h) => [h.arg, h.origin, h.trust]), [["to", PAGE, "untrusted"]]);
    });
  }
  it("a new-origin navigation built from page data needs confirmation", () => {
    assert.equal(checkFlow(l, sink("navigate"), { url: "https://promo.example/offer" }).verdict, "confirm");
  });
  it("typing page-provided data back into a page needs confirmation", () => {
    assert.equal(checkFlow(l, sink("type"), { value: "+44 20 7946 0958" }).verdict, "confirm");
  });
  it("arguments with no page-derived value flow freely", () => {
    assert.equal(checkFlow(l, sink("send"), { to: "me@mycompany.test", body: "hello" }).verdict, "allow");
  });
  it("finds the value however the case, spacing or zero-width characters are changed", () => {
    assert.equal(checkFlow(l, sink("send"), { to: "DEALS@promo.example" }).verdict, "confirm");
    assert.equal(checkFlow(l, sink("send"), { to: "deals@pro​mo.example" }).verdict, "confirm");
  });
  it("finds a long verbatim run copied out of a page value", () => {
    assert.equal(checkFlow(l, sink("post"), { text: "FYI: Contact sales at deals@promo.example or call" }).verdict, "confirm");
  });
  it("looks inside nested arguments", () => {
    assert.equal(checkFlow(l, sink("send"), { message: { cc: ["deals@promo.example"] } }).hits[0]?.arg, "message.cc.0");
  });
});

describe("secrets", () => {
  const l = ledger();
  it("a secret is refused at every outward sink", () => {
    for (const kind of ["send", "post", "file_write", "fetch", "navigate", "type", "money"] as const) {
      assert.equal(checkFlow(l, sink(kind), { v: "sk-live-CANARY-7731a9" }).verdict, "refuse", kind);
    }
  });
  it("is found url-encoded, base64 and hex encoded, and with punctuation removed", () => {
    const s = "sk-live-CANARY-7731a9";
    for (const v of [encodeURIComponent(s), Buffer.from(s).toString("base64"), Buffer.from(s).toString("base64url"), Buffer.from(s).toString("hex"), "sk live CANARY 7731a9", `?t=${s}&x=1`]) {
      assert.equal(checkFlow(l, sink("fetch"), { u: v }).verdict, "refuse", v);
    }
  });
  it("a secret is fine in a read sink (it goes nowhere)", () => {
    assert.equal(checkFlow(l, sink("read"), { v: "sk-live-CANARY-7731a9" }).verdict, "allow");
  });
  it("a short secret is not invented out of a coincidence", () => {
    const l2 = new TaintLedger();
    l2.registerSecret("abc");
    assert.equal(checkFlow(l2, sink("send"), { v: "abc" }).verdict, "allow");
  });
});

describe("TaintLedger", () => {
  it("ignores trusted values", () => {
    const l = new TaintLedger();
    l.register("deals@promo.example", "user", "trusted");
    assert.equal(checkFlow(l, sink("send"), { to: "deals@promo.example" }).verdict, "allow");
  });
  it("is bounded: an enormous page cannot grow it without limit", () => {
    const l = new TaintLedger({ maxChars: 5_000 });
    for (let i = 0; i < 100; i++) l.register(`${i} ${"lorem ipsum dolor ".repeat(40)}`, PAGE, "untrusted");
    assert.ok(l.size() <= 5_000 * 2);
  });
});
