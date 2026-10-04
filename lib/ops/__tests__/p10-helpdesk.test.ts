// ShapesOS Phase 10 (ops-core): helpdesk SLA timers, subject threading and
// the signed support address. Unit (no DB).
// Run: npx tsx --test lib/ops/__tests__/p10-helpdesk.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SLA, normalizeSubject, replySubject, slaDueDates, slaState, ticketNumberFromSubject } from "../helpdesk-sla";
import { replyAddressFor, supportAddressFor, workspaceForReplyAddress, workspaceForSupportAddress } from "@/lib/messaging/inbound-email";

const T0 = new Date("2026-10-01T09:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const base = (over: Record<string, unknown> = {}) => ({
  status: "open",
  ...slaDueDates(T0, { firstResponseMinutes: 60, resolutionMinutes: 480 }),
  firstRespondedAt: null as Date | null,
  solvedAt: null as Date | null,
  closedAt: null as Date | null,
  ...over,
});

describe("SLA timers", () => {
  it("due dates are calendar minutes from creation", () => {
    const d = slaDueDates(T0, DEFAULT_SLA.urgent);
    assert.equal(d.firstResponseDueAt.toISOString(), "2026-10-01T10:00:00.000Z");
    assert.equal(d.resolutionDueAt.toISOString(), "2026-10-01T17:00:00.000Z");
  });

  it("running → breached as time passes with no response", () => {
    assert.deepEqual(slaState(base(), at(30)), { firstResponse: "running", resolution: "running", breach: null });
    assert.deepEqual(slaState(base(), at(61)), { firstResponse: "breached", resolution: "running", breach: "first_response" });
    assert.equal(slaState(base({ firstRespondedAt: at(10) }), at(500)).breach, "resolution");
  });

  it("met when the event happens in time, breached when late — even after the fact", () => {
    assert.deepEqual(slaState(base({ firstRespondedAt: at(59), solvedAt: at(400) }), at(10_000)), { firstResponse: "met", resolution: "met", breach: null });
    assert.equal(slaState(base({ firstRespondedAt: at(90), solvedAt: at(100) }), at(100)).firstResponse, "breached");
    assert.equal(slaState(base({ firstRespondedAt: at(5), closedAt: at(470) }), at(1000)).resolution, "met");
  });

  it("no targets → no clock", () => {
    assert.deepEqual(slaState({ ...base(), firstResponseDueAt: null, resolutionDueAt: null }, at(1e6)), { firstResponse: "none", resolution: "none", breach: null });
  });
});

describe("subject threading", () => {
  it("extracts the ticket token", () => {
    assert.equal(ticketNumberFromSubject("Re: Printer jam [#42]"), 42);
    assert.equal(ticketNumberFromSubject("Printer #42"), null);
    assert.equal(ticketNumberFromSubject(null), null);
  });
  it("normalizes reply prefixes and tokens", () => {
    assert.equal(normalizeSubject("RE: Fwd: Printer   jam [#4]"), "printer jam");
    assert.equal(replySubject("Re: Printer jam [#4]", 4), "Re: Printer jam [#4]");
    assert.equal(replySubject("Printer jam", 7), "Re: Printer jam [#7]");
  });
});

describe("signed support address", () => {
  const env = { MESSAGING_INBOUND_EMAIL_DOMAIN: "reply.shapes.test", MESSAGING_INBOUND_EMAIL_SECRET: "unit-secret" } as unknown as NodeJS.ProcessEnv;
  it("round-trips and is distinct from the reply address", () => {
    const support = supportAddressFor("ws_abc", env)!;
    assert.match(support, /^support\+ws_abc-[0-9a-f]{16}@reply\.shapes\.test$/);
    assert.equal(workspaceForSupportAddress(`Help <${support.toUpperCase()}>`, env), "ws_abc");
    const reply = replyAddressFor("ws_abc", env)!;
    assert.equal(workspaceForSupportAddress(reply.replace("reply+", "support+"), env), null, "a reply signature never opens the support inbox");
    assert.equal(workspaceForReplyAddress(support.replace("support+", "reply+"), env), null);
    assert.equal(workspaceForSupportAddress(support.replace(/-[0-9a-f]+@/, "-0000000000000000@"), env), null);
  });
});
