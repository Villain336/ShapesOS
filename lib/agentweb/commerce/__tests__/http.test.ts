// Phase 21A round 2 (WS=agentweb): the guard in front of cart signing. A person's click on this
// app's own page passes; everything else (another site, a script, a voice assistant, an agent's HTTP
// tool, a body that does not say ui_click) does not.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { humanClickGuard } from "../http";

const URL_ = "https://app.shapesos.test/api/agentweb/mandates/man_1/sign";
const req = (headers: Record<string, string>, body: unknown = { channel: "ui_click" }) => new Request(URL_, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("humanClickGuard", () => {
  it("accepts a same-origin fetch from the app's own page naming ui_click", async () => {
    assert.deepEqual(await humanClickGuard(req({ "sec-fetch-site": "same-origin", origin: "https://app.shapesos.test" }), { requireChannel: true }), { ok: true, body: { channel: "ui_click" } });
  });

  it("refuses another site, another origin, and a non-JSON body", async () => {
    assert.equal((await humanClickGuard(req({ "sec-fetch-site": "cross-site" }), { requireChannel: true })).ok, false);
    assert.equal((await humanClickGuard(req({ "sec-fetch-site": "same-site" }), { requireChannel: true })).ok, false);
    assert.equal((await humanClickGuard(req({ origin: "https://evil.test" }), { requireChannel: true })).ok, false);
    const r = await humanClickGuard(req({ "content-type": "text/plain" }), { requireChannel: true });
    assert.deepEqual(r.ok ? null : r.status, 415);
  });

  it("refuses any body that does not name the channel ui_click", async () => {
    for (const body of [{}, { channel: "voice" }, { channel: "spoken" }, { channel: "api_key" }, { channel: "UI_CLICK" }, { channel: ["ui_click"] }, "not json", "[]"]) {
      const r = await humanClickGuard(req({}, body), { requireChannel: true });
      assert.equal(r.ok, false, JSON.stringify(body));
    }
  });

  it("rejecting does not need the channel", async () => {
    assert.equal((await humanClickGuard(req({}, {}), { requireChannel: false })).ok, true);
  });

  it("refuses an oversized body", async () => {
    assert.equal((await humanClickGuard(req({}, JSON.stringify({ channel: "ui_click", pad: "x".repeat(3000) })), { requireChannel: true })).ok, false);
  });
});
