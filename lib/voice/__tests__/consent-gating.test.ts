// Marketr — Phase 13D Worker A: consent-gating tests.
// Run: npx tsx --test lib/voice/__tests__/consent-gating.test.ts
// Pure core (evaluateConsent) — no DB, no network.
// Contract: no-consent → hard refusal, opted-out → refusal; ONLY opted_in
// passes. There is no bypass path in the shape.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { evaluateConsent, type ConsentChannel } from "../consent";

const WS = "ws-consent-test";
const LEAD = "lead-consent-test";
const CHANNEL: ConsentChannel = "voice";

function record(status: string) {
  return {
    id: "rec-1",
    leadId: LEAD,
    channel: "voice",
    status,
    consentedAt: status === "opted_in" ? new Date("2026-09-28T04:00:00Z") : null,
    optedOutAt: status === "opted_out" ? new Date("2026-09-28T04:00:00Z") : null,
    source: "web_form",
  };
}

describe("evaluateConsent — hard refusal semantics", () => {
  it("no consent record → hard refusal (no_consent_record)", () => {
    const d = evaluateConsent(null, WS, LEAD, CHANNEL);
    assert.equal(d.allowed, false);
    assert.equal(d.blockReason, "no_consent_record");
    assert.equal(d.proof.status, "unknown");
  });

  it("opted_out → refusal (consent_opted_out)", () => {
    const d = evaluateConsent(record("opted_out"), WS, LEAD, CHANNEL);
    assert.equal(d.allowed, false);
    assert.equal(d.blockReason, "consent_opted_out");
    assert.ok(d.proof.optedOutAt);
  });

  it("pending → refusal (consent_pending)", () => {
    const d = evaluateConsent(record("pending"), WS, LEAD, CHANNEL);
    assert.equal(d.allowed, false);
    assert.equal(d.blockReason, "consent_pending");
  });

  it("unknown → refusal (consent_unknown)", () => {
    const d = evaluateConsent(record("unknown"), WS, LEAD, CHANNEL);
    assert.equal(d.allowed, false);
    assert.equal(d.blockReason, "consent_unknown");
  });

  it("opted_in → allowed, proof snapshotted", () => {
    const d = evaluateConsent(record("opted_in"), WS, LEAD, CHANNEL);
    assert.equal(d.allowed, true);
    assert.equal(d.blockReason, undefined);
    assert.equal(d.proof.leadId, LEAD);
    assert.equal(d.proof.channel, "voice");
    assert.equal(d.proof.status, "opted_in");
    assert.equal(d.proof.consentRecordId, "rec-1");
    assert.ok(d.proof.consentedAt);
    assert.ok(d.proof.checkedAt);
    assert.ok(d.proof.legalBasis.includes("FCC"));
  });

  it("opted_out always beats any earlier opt-in (no fallthrough)", () => {
    // Even a record that once consented is refused once status=opted_out.
    const d = evaluateConsent(
      { ...record("opted_in"), status: "opted_out", consentedAt: null, optedOutAt: new Date() },
      WS,
      LEAD,
      CHANNEL,
    );
    assert.equal(d.allowed, false);
    assert.equal(d.blockReason, "consent_opted_out");
  });
});
