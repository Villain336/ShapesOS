// ShapesOS CRM inbox — view rules (Phase 4b). Pure.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { consentHint, defaultReplyChannel, messageMark, newestAt, shortAge } from "../inbox-view";

const m = (over: Partial<Parameters<typeof messageMark>[0]>) => ({
  direction: "outbound" as const,
  status: "queued",
  approvalStatus: null,
  suppressionReason: null,
  ...over,
});

describe("messageMark", () => {
  it("maps ledger states onto the status language", () => {
    assert.deepEqual(messageMark(m({ approvalStatus: "pending" })), { mark: "needs", label: "Waiting for approval" });
    assert.deepEqual(messageMark(m({ approvalStatus: "rejected" })), { mark: "failed", label: "Approval denied" });
    assert.deepEqual(messageMark(m({ approvalStatus: "approved" })), { mark: "queued", label: "Scheduled" });
    assert.equal(messageMark(m({ status: "sent" })).mark, "done");
    assert.equal(messageMark(m({ status: "delivered" })).label, "Delivered");
    assert.deepEqual(messageMark(m({ status: "suppressed" })), { mark: "failed", label: "Not sent" });
    assert.equal(messageMark(m({ status: "failed" })).mark, "failed");
    assert.deepEqual(messageMark(m({ direction: "inbound", status: "delivered" })), { mark: null, label: "Received" });
  });
});

describe("shortAge", () => {
  const now = new Date("2026-10-03T12:00:00Z");
  it("is compact", () => {
    assert.equal(shortAge("2026-10-03T11:59:40Z", now), "now");
    assert.equal(shortAge("2026-10-03T11:55:00Z", now), "5m");
    assert.equal(shortAge("2026-10-03T09:00:00Z", now), "3h");
    assert.equal(shortAge("2026-10-01T12:00:00Z", now), "2d");
    assert.equal(shortAge("garbage", now), "");
  });
});

describe("consentHint", () => {
  it("warns unless opted in", () => {
    assert.equal(consentHint("sms", "opted_in"), null);
    assert.match(consentHint("sms", "opted_out") ?? "", /opted out of texts/);
    assert.match(consentHint("email", "unknown") ?? "", /No email consent/);
    assert.match(consentHint("email", undefined) ?? "", /No email consent/);
  });
});

describe("defaultReplyChannel", () => {
  const both = { sms: true, email: true };
  it("follows the newest inbound message, then the newest message, then what's available", () => {
    assert.equal(
      defaultReplyChannel(
        [
          { channel: "sms", direction: "inbound" },
          { channel: "email", direction: "outbound" },
        ],
        both,
      ),
      "sms",
    );
    assert.equal(defaultReplyChannel([{ channel: "email", direction: "outbound" }], both), "email");
    assert.equal(defaultReplyChannel([{ channel: "sms", direction: "inbound" }], { sms: false, email: true }), "email");
    assert.equal(defaultReplyChannel([], { sms: false, email: false }), null);
  });
});

describe("newestAt", () => {
  it("picks the latest timestamp", () => {
    assert.equal(newestAt([{ createdAt: "2026-01-02T00:00:00.000Z" }, { createdAt: "2026-01-03T00:00:00.000Z" }]), "2026-01-03T00:00:00.000Z");
    assert.equal(newestAt([]), null);
  });
});
