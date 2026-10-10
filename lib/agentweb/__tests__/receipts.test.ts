// Phase 21A (WS=agentweb): receipts. Each browser step and each cited answer
// source stores a capture (URL, time, content hash, excerpt) that is signed and
// chained into the audit log, so a claim or action can be checked later.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { captureOf, signCapture, verifyCapture, receiptSecret, recordReceipt, type ReceiptDeps } from "../receipts";

const AT = new Date("2026-10-10T12:00:00.000Z");

describe("captureOf", () => {
  it("hashes the content with sha256 (known vector) and keeps a short excerpt", () => {
    const c = captureOf({ url: "https://a.test/x", html: "hello", fetchedAt: AT });
    // sha256("hello")
    assert.equal(c.domHash, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    assert.equal(c.fetchedAt, "2026-10-10T12:00:00.000Z");
    assert.equal(c.url, "https://a.test/x");
    assert.match(c.id, /^cap_[0-9a-f]{20}$/);
  });
  it("the text hash ignores markup and whitespace noise", () => {
    const a = captureOf({ url: "https://a.test/", html: "<p>Opening   hours</p>", fetchedAt: AT });
    const b = captureOf({ url: "https://a.test/", html: "<div>Opening hours</div>", fetchedAt: AT });
    assert.equal(a.textHash, b.textHash);
    assert.notEqual(a.domHash, b.domHash);
  });
  it("the excerpt is visible text only, clipped, with credentials redacted", () => {
    const html = `<style>x{}</style><p>${"word ".repeat(400)}</p><p>password=hunter2 card 4242 4242 4242 4242</p>`;
    const c = captureOf({ url: "https://a.test/", html, fetchedAt: AT, excerptChars: 100 });
    assert.equal(c.excerpt.length <= 100, true);
    const c2 = captureOf({ url: "https://a.test/", html: `<p>password=hunter2 card 4242 4242 4242 4242</p>`, fetchedAt: AT });
    assert.doesNotMatch(c2.excerpt, /hunter2|4242 4242/);
  });
  it("the id is stable for the same page at the same time and differs otherwise", () => {
    const a = captureOf({ url: "https://a.test/", html: "x", fetchedAt: AT });
    assert.equal(a.id, captureOf({ url: "https://a.test/", html: "x", fetchedAt: AT }).id);
    assert.notEqual(a.id, captureOf({ url: "https://a.test/", html: "y", fetchedAt: AT }).id);
  });
  it("records the screenshot only when one was taken", () => {
    assert.equal(captureOf({ url: "https://a.test/", html: "x", fetchedAt: AT }).screenshotRef, undefined);
    assert.equal(captureOf({ url: "https://a.test/", html: "x", fetchedAt: AT, screenshotRef: "blob:web-captures/w/a.png" }).screenshotRef, "blob:web-captures/w/a.png");
  });
});

describe("sign and verify", () => {
  const cap = captureOf({ url: "https://a.test/", html: "hello", fetchedAt: AT });
  it("a signed capture verifies and any change breaks it", () => {
    const s = signCapture(cap, "k".repeat(32));
    assert.equal(s.alg, "hmac-sha256");
    assert.equal(verifyCapture(s, "k".repeat(32)), true);
    assert.equal(verifyCapture({ ...s, url: "https://evil.test/" }, "k".repeat(32)), false);
    assert.equal(verifyCapture({ ...s, domHash: "0".repeat(64) }, "k".repeat(32)), false);
    assert.equal(verifyCapture(s, "j".repeat(32)), false);
  });
  it("without a secret the capture says it is unsigned and never verifies", () => {
    const s = signCapture(cap, null);
    assert.deepEqual([s.alg, s.signature], ["none", null]);
    assert.equal(verifyCapture(s, "k".repeat(32)), false);
  });
});

describe("receiptSecret", () => {
  it("takes the first long-enough secret and never invents one", () => {
    assert.equal(receiptSecret({ AUTH_SECRET: "a".repeat(20) }) !== null, true);
    assert.equal(receiptSecret({ AUTH_SECRET: "short" }), null);
    assert.equal(receiptSecret({}), null);
  });
  it("derives a different key from the raw secret", () => {
    assert.notEqual(receiptSecret({ AUTH_SECRET: "a".repeat(20) }), "a".repeat(20));
  });
});

describe("recordReceipt", () => {
  it("stores the capture and chains an audit entry that names it, without credentials", async () => {
    const stored: unknown[] = [];
    const audits: Array<Record<string, unknown>> = [];
    const deps: ReceiptDeps = {
      secret: "k".repeat(32),
      store: async (c) => void stored.push(c),
      audit: async (e) => void audits.push(e as never),
    };
    const out = await recordReceipt(deps, {
      workspaceId: "w1",
      actor: "agent:lead",
      html: "<p>hello</p>",
      url: "https://a.test/x",
      fetchedAt: AT,
      step: { action: "click", ref: "e3", name: "Menu", klass: "benign", tier: 0, decision: "allow" },
    });
    assert.equal(stored.length, 1);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.entityId, out.id);
    assert.equal(audits[0]!.action, "agentweb.step");
    const detail = audits[0]!.detail as Record<string, unknown>;
    assert.deepEqual([detail.url, detail.domHash, detail.klass, detail.decision], ["https://a.test/x", out.domHash, "benign", "allow"]);
    assert.equal(typeof detail.signature, "string");
  });
  it("an audit failure does not lose the stored capture and is reported", async () => {
    const stored: unknown[] = [];
    const deps: ReceiptDeps = { secret: null, store: async (c) => void stored.push(c), audit: async () => { throw new Error("db down"); } };
    const out = await recordReceipt(deps, { workspaceId: "w1", actor: "a", html: "x", url: "https://a.test/", fetchedAt: AT, step: { action: "navigate", decision: "allow", tier: 0, klass: "benign" } });
    assert.equal(stored.length, 1);
    assert.equal(out.auditError, "db down");
    assert.equal(out.alg, "none");
  });
});

// ---- round 2: the delegation record on every agent web action ----
describe("recordReceipt with a delegation", () => {
  const DELEGATION = { delegatedBy: "user_1", runId: "run_9", agent: "lead", scope: { origins: ["https://a.test"], classes: ["benign"] }, expiresAt: new Date("2026-10-10T12:05:00.000Z") };
  const STEP = { action: "click" as const, ref: "e3", name: "Send", klass: "send", tier: 2, decision: "confirmed" };
  function rig(over: Partial<ReceiptDeps> = {}) {
    const delegations: Array<Record<string, unknown>> = [];
    const audits: Array<{ detail: Record<string, unknown> }> = [];
    const deps: ReceiptDeps = {
      secret: "s".repeat(32),
      store: async () => undefined,
      audit: async (e) => {
        audits.push(e);
        return { id: "aud_1" };
      },
      delegate: async (d) => {
        delegations.push(d as unknown as Record<string, unknown>);
        return "dlg_1";
      },
      ...over,
    };
    return { deps, delegations, audits };
  }

  it("stores who delegated, the scope, the run, the expiry and the tier decision, linked to the receipt", async () => {
    const r = rig();
    const rec = await recordReceipt(r.deps, { workspaceId: "w", actor: "agent:lead", url: "https://a.test/x", html: "x", fetchedAt: AT, step: STEP, delegation: DELEGATION });
    assert.equal(r.delegations.length, 1);
    const d = r.delegations[0]!;
    assert.deepEqual(
      { by: d.delegatedBy, run: d.runId, agent: d.agent, scope: d.scope, exp: (d.expiresAt as Date).toISOString(), tier: d.tier, decision: d.decision, action: d.action, origin: d.origin, capture: d.captureId },
      { by: "user_1", run: "run_9", agent: "lead", scope: { origins: ["https://a.test"], classes: ["benign"] }, exp: "2026-10-10T12:05:00.000Z", tier: 2, decision: "confirmed", action: "click", origin: "https://a.test", capture: rec.id },
    );
    assert.match(String(d.id), /^dlg_[0-9a-f]{20}$/);
  });

  it("goes into the audit chain too, so the chain alone can answer who delegated this", async () => {
    const r = rig();
    await recordReceipt(r.deps, { workspaceId: "w", actor: "agent:lead", url: "https://a.test/x", html: "x", fetchedAt: AT, step: STEP, delegation: DELEGATION });
    const detail = r.audits[0]!.detail as { delegation: Record<string, unknown> };
    assert.deepEqual(detail.delegation, { id: r.delegations[0]!.id, delegatedBy: "user_1", runId: "run_9", expiresAt: "2026-10-10T12:05:00.000Z", scopeOrigins: ["https://a.test"] });
  });

  it("no delegation, no record; a failing delegation store never loses the receipt", async () => {
    const none = rig();
    await recordReceipt(none.deps, { workspaceId: "w", actor: "a", url: "https://a.test/", html: "x", fetchedAt: AT, step: STEP });
    assert.equal(none.delegations.length, 0);
    const broken = rig({ delegate: async () => { throw new Error("db"); } });
    const rec = await recordReceipt(broken.deps, { workspaceId: "w", actor: "a", url: "https://a.test/", html: "x", fetchedAt: AT, step: STEP, delegation: DELEGATION });
    assert.match(rec.id, /^cap_/);
    assert.match(String(rec.auditError ?? ""), /delegation/i);
  });
});
