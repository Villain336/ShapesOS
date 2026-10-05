// ShapesOS — inbound email replies (Phase 4b): reply addresses, signature
// verification, body clean-up. Pure (no DB, no network).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import {
  extractAddress,
  htmlToText,
  inboundEmailDomain,
  replyAddressFor,
  replyAddressForSend,
  stripQuotedReply,
  verifyInboundEmailSignature,
  workspaceForReplyAddress,
} from "../inbound-email";

const ENV = {
  MESSAGING_INBOUND_EMAIL_DOMAIN: "reply.shapes.test",
  MESSAGING_INBOUND_EMAIL_SECRET: "test-inbound-secret",
} as unknown as NodeJS.ProcessEnv;

/** Svix-format signature, as Resend sends it. */
function svixHeaders(raw: string, secret: string, ts = Math.floor(Date.now() / 1000)): Headers {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const id = `msg_${randomBytes(6).toString("hex")}`;
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest("base64");
  return new Headers({ "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}` });
}

describe("reply addresses", () => {
  it("round-trip a workspace id and reject tampering", () => {
    const addr = replyAddressFor("cmabc123xyz", ENV)!;
    assert.match(addr, /^reply\+cmabc123xyz-[0-9a-f]{16}@reply\.shapes\.test$/);
    assert.equal(workspaceForReplyAddress(addr, ENV), "cmabc123xyz");
    assert.equal(workspaceForReplyAddress(`Ada <${addr.toUpperCase()}>`, ENV), "cmabc123xyz");
    const forged = addr.replace("cmabc123xyz", "cmother0000");
    assert.equal(workspaceForReplyAddress(forged, ENV), null);
    assert.equal(workspaceForReplyAddress(addr.replace("reply.shapes.test", "evil.test"), ENV), null);
    assert.equal(workspaceForReplyAddress("someone@reply.shapes.test", ENV), null);
    // A different signing secret doesn't validate.
    assert.equal(workspaceForReplyAddress(addr, { ...ENV, MESSAGING_INBOUND_EMAIL_SECRET: "other" } as NodeJS.ProcessEnv), null);
  });

  it("are off without a domain, and only for lower-case ids", () => {
    assert.equal(inboundEmailDomain({} as NodeJS.ProcessEnv), null);
    assert.equal(replyAddressFor("cmabc", {} as NodeJS.ProcessEnv), null);
    assert.equal(replyAddressFor("Has-Dash", ENV), null);
    assert.equal(inboundEmailDomain({ MESSAGING_INBOUND_EMAIL_DOMAIN: "not a domain" } as unknown as NodeJS.ProcessEnv), null);
  });
});

describe("extractAddress", () => {
  it("pulls the address out of display forms", () => {
    assert.equal(extractAddress("Ada Lovelace <Ada@Example.com>"), "ada@example.com");
    assert.equal(extractAddress("ada@example.com"), "ada@example.com");
    assert.equal(extractAddress("nobody"), null);
    assert.equal(extractAddress(42), null);
  });
});

describe("body clean-up", () => {
  it("drops the quoted original", () => {
    assert.equal(stripQuotedReply("Sounds good, Tuesday works.\n\nOn Mon, Sep 1, 2026 at 9:00 AM Shapes <x@y.z> wrote:\n> Can we meet?"), "Sounds good, Tuesday works.");
    assert.equal(stripQuotedReply("Yes!\n> earlier"), "Yes!");
    assert.equal(stripQuotedReply("Thanks\n\n-----Original Message-----\nFrom: x"), "Thanks");
    assert.equal(stripQuotedReply("> only quoted"), "> only quoted");
  });
  it("turns HTML into readable text", () => {
    assert.equal(htmlToText("<p>Hi&nbsp;there</p><p>See <b>you</b> &amp; bye<br>x</p><script>evil()</script>"), "Hi there\nSee you & bye\nx");
  });
});

describe("verifyInboundEmailSignature", () => {
  const secret = `whsec_${randomBytes(24).toString("base64")}`;
  const env = { RESEND_INBOUND_WEBHOOK_SECRET: secret } as unknown as NodeJS.ProcessEnv;
  const raw = JSON.stringify({ type: "email.received", data: { email_id: "e1" } });

  it("accepts a valid Svix signature over the raw body", () => {
    assert.equal(verifyInboundEmailSignature(raw, svixHeaders(raw, secret), env), true);
  });
  it("rejects a changed body, a wrong secret, a stale timestamp and missing headers", () => {
    assert.equal(verifyInboundEmailSignature(raw + " ", svixHeaders(raw, secret), env), false);
    assert.equal(verifyInboundEmailSignature(raw, svixHeaders(raw, `whsec_${randomBytes(24).toString("base64")}`), env), false);
    assert.equal(verifyInboundEmailSignature(raw, svixHeaders(raw, secret, Math.floor(Date.now() / 1000) - 3600), env), false);
    assert.equal(verifyInboundEmailSignature(raw, new Headers(), env), false);
  });
  it("fails closed without a secret", () => {
    assert.equal(verifyInboundEmailSignature(raw, svixHeaders(raw, secret), {} as NodeJS.ProcessEnv), false);
  });
});

describe("replyAddressForSend", () => {
  it("drops the Reply-To instead of failing a send when the secret is missing in production", () => {
    const prod = { NODE_ENV: "production", MESSAGING_INBOUND_EMAIL_DOMAIN: "reply.shapes.test" } as unknown as NodeJS.ProcessEnv;
    assert.equal(replyAddressForSend("cmabc", prod), undefined);
    assert.match(replyAddressForSend("cmabc", ENV) ?? "", /^reply\+cmabc-/);
  });
});
