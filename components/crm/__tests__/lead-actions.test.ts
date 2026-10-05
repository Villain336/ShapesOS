// ShapesOS CRM — lead action rules.
// Run: npx tsx --test components/crm/__tests__/lead-actions.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSendRequest,
  enrollableSequences,
  interpretEnroll,
  interpretSend,
  leadActionAvailability,
  SMS_MAX,
  telHref,
  validateDraft,
} from "../lead-actions";

describe("leadActionAvailability", () => {
  it("enables channels only when the lead has the contact detail", () => {
    const a = leadActionAvailability({ id: "l1", name: "Ada", email: "ada@example.com", phone: null });
    assert.equal(a.email.enabled, true);
    assert.equal(a.sms.enabled, false);
    assert.equal(a.call.enabled, false);
    assert.match(a.sms.reason!, /phone number/);
  });

  it("treats whitespace-only values as missing", () => {
    const a = leadActionAvailability({ id: "l1", name: "Ada", email: "  ", phone: " +1 555 " });
    assert.equal(a.email.enabled, false);
    assert.equal(a.call.enabled, true);
  });
});

describe("telHref", () => {
  it("strips formatting and keeps a leading plus", () => {
    assert.equal(telHref("+1 (555) 010-2030"), "tel:+15550102030");
    assert.equal(telHref("555.010.2030"), "tel:5550102030");
  });
  it("rejects values with no usable digits", () => {
    assert.equal(telHref("n/a"), null);
  });
});

describe("validateDraft / buildSendRequest", () => {
  it("requires a body, and a subject for email", () => {
    assert.match(validateDraft({ channel: "sms", subject: "", body: "  " })!, /Write a message/);
    assert.match(validateDraft({ channel: "email", subject: "", body: "Hi" })!, /subject/);
    assert.equal(validateDraft({ channel: "email", subject: "Hello", body: "Hi" }), null);
  });

  it("caps text length", () => {
    assert.match(validateDraft({ channel: "sms", subject: "", body: "x".repeat(SMS_MAX + 1) })!, /under/);
    assert.equal(validateDraft({ channel: "sms", subject: "", body: "x".repeat(SMS_MAX) }), null);
  });

  it("builds a manual, approval-gated send with subject only for email", () => {
    assert.deepEqual(buildSendRequest("l1", { channel: "email", subject: " Hi ", body: " Body " }), {
      leadId: "l1",
      channel: "email",
      kind: "manual",
      subject: "Hi",
      body: "Body",
    });
    const sms = buildSendRequest("l1", { channel: "sms", subject: "ignored", body: "Yo" });
    assert.equal("subject" in sms, false);
    assert.equal(sms.kind, "manual");
  });
});

describe("interpretSend", () => {
  it("queued messages wait for approval", () => {
    const r = interpretSend("Ada", "email", { message: { status: "queued" } });
    assert.equal(r.queued, true);
    assert.match(r.title, /waiting for approval/);
  });

  it("never reports a suppressed message as queued", () => {
    const r = interpretSend("Ada", "sms", { message: { status: "suppressed", suppressionReason: "no_consent" } });
    assert.equal(r.queued, false);
    assert.equal(r.title, "Not sent");
    assert.match(r.description, /hasn't opted in to texts/);
    assert.match(interpretSend("Ada", "email", { message: { status: "suppressed", suppressionReason: "opt_out" } }).description, /opted out of email/);
  });

  it("treats a missing message as not sent", () => {
    assert.equal(interpretSend("Ada", "email", {}).queued, false);
  });
});

describe("interpretEnroll", () => {
  it("offers Undo only for a fresh enrollment", () => {
    assert.deepEqual(interpretEnroll("l1", { results: [{ leadId: "l1", ok: true }] }), {
      ok: true,
      offerUndo: true,
      message: "Enrolled",
    });
    const again = interpretEnroll("l1", { results: [{ leadId: "l1", ok: true, alreadyEnrolled: true }] });
    assert.equal(again.ok, true);
    assert.equal(again.offerUndo, false);
  });

  it("surfaces the server's error", () => {
    const r = interpretEnroll("l1", { results: [{ leadId: "l1", ok: false, error: "Cannot enroll into an archived sequence" }] });
    assert.equal(r.ok, false);
    assert.match(r.message, /archived/);
    assert.equal(interpretEnroll("l1", null).ok, false);
  });

  it("filters archived sequences out of the picker", () => {
    const list = enrollableSequences([
      { id: "a", status: "active" },
      { id: "b", status: "archived" },
      { id: "c", status: "draft" },
    ]);
    assert.deepEqual(list.map((s) => s.id), ["a", "c"]);
  });
});
