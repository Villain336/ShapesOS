// ShapesOS — CRM conversation inbox rules (Phase 4b). Pure: the DB client and
// the dispatcher are fakes. The DB-backed suite is inbox-db.test.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { OutboundMessage } from "@prisma/client";
import {
  decodeCursor,
  encodeCursor,
  replySubject,
  replyToThread,
  suppressionLabel,
  validateReply,
  type QueueReplyFn,
} from "../inbox";

describe("thread cursor", () => {
  it("round-trips and rejects junk", () => {
    const c = encodeCursor(new Date("2026-09-01T12:00:00.000Z"), "lead_1");
    assert.deepEqual(decodeCursor(c), { at: new Date("2026-09-01T12:00:00.000Z"), leadId: "lead_1" });
    assert.equal(decodeCursor(null), null);
    assert.equal(decodeCursor("!!!"), null);
    assert.equal(decodeCursor(Buffer.from("not-a-date|x").toString("base64url")), null);
    assert.equal(decodeCursor(Buffer.from("2026-09-01T00:00:00Z|").toString("base64url")), null);
  });
});

describe("replySubject", () => {
  it("prefixes Re: once", () => {
    assert.equal(replySubject("Your proposal"), "Re: Your proposal");
    assert.equal(replySubject("RE: Your proposal"), "RE: Your proposal");
    assert.equal(replySubject(null), "");
  });
});

describe("validateReply", () => {
  it("applies the messaging limits", () => {
    assert.equal(validateReply({ channel: "sms", body: "hi" }), null);
    assert.match(validateReply({ channel: "sms", body: "  " }) ?? "", /Write a message/);
    assert.match(validateReply({ channel: "sms", body: "x".repeat(1601) }) ?? "", /under 1600/);
    assert.match(validateReply({ channel: "email", body: "hi" }) ?? "", /subject/);
    assert.equal(validateReply({ channel: "email", subject: "Re: hi", body: "hi" }), null);
    assert.match(validateReply({ channel: "email", subject: "s", body: "x".repeat(5001) }) ?? "", /under 5000/);
    assert.match(validateReply({ channel: "fax" as never, body: "hi" }) ?? "", /SMS or email/);
  });
});

describe("suppressionLabel", () => {
  it("explains each dispatcher reason", () => {
    assert.match(suppressionLabel("no_consent"), /consent/);
    assert.match(suppressionLabel("opt_out"), /opted out/);
    assert.match(suppressionLabel("cap"), /cap/);
    assert.match(suppressionLabel("weird_reason"), /weird reason/);
  });
});

describe("replyToThread gating", () => {
  const lead = { id: "lead_1", name: "Ada", email: null, phone: "+15550000001", company: null, ownerId: null, ownerName: null, stage: "new" };
  function fakeDb(found: typeof lead | null) {
    const seen: unknown[] = [];
    return {
      seen,
      db: {
        lead: {
          findFirst: async (args: unknown) => {
            seen.push(args);
            return found;
          },
        },
      } as never,
    };
  }
  function row(over: Partial<OutboundMessage>): OutboundMessage {
    return {
      id: "m1",
      workspaceId: "ws",
      leadId: "lead_1",
      channel: "sms",
      direction: "outbound",
      kind: "manual",
      subject: null,
      body: "hi",
      status: "queued",
      suppressionReason: null,
      provider: "fake",
      providerSid: null,
      scheduledFor: null,
      sentAt: null,
      deliveredAt: null,
      claimedAt: null,
      error: null,
      costCents: 0,
      approvalId: "appr_1",
      createdAt: new Date(),
      ...over,
    };
  }

  it("queues through the dispatcher as a manual send requested by the caller, scoped to the workspace", async () => {
    const { db, seen } = fakeDb(lead);
    const calls: Parameters<QueueReplyFn>[0][] = [];
    const queue: QueueReplyFn = async (input) => {
      calls.push(input);
      return row({});
    };
    const res = await replyToThread(db, queue, { workspaceId: "ws", userId: "u1", leadId: "lead_1", channel: "sms", body: "  hi  " });
    assert.equal(res.outcome, "queued");
    assert.equal(res.message.approvalStatus, "pending");
    assert.deepEqual(calls[0], { workspaceId: "ws", leadId: "lead_1", channel: "sms", kind: "manual", subject: undefined, body: "hi", requestedBy: "u1" });
    assert.deepEqual((seen[0] as { where: unknown }).where, { id: "lead_1", workspaceId: "ws" });
  });

  it("maps the dispatcher's suppression to outcome 'suppressed'", async () => {
    const { db } = fakeDb(lead);
    const res = await replyToThread(db, async () => row({ status: "suppressed", suppressionReason: "opt_out", approvalId: null }), {
      workspaceId: "ws",
      userId: "u1",
      leadId: "lead_1",
      channel: "sms",
      body: "hi",
    });
    assert.equal(res.outcome, "suppressed");
    assert.equal(res.message.suppressionReason, "opt_out");
  });

  it("never reaches the dispatcher for a foreign lead, a missing address or an invalid draft", async () => {
    let called = 0;
    const queue: QueueReplyFn = async () => {
      called++;
      return row({});
    };
    await assert.rejects(
      replyToThread(fakeDb(null).db, queue, { workspaceId: "ws", userId: "u", leadId: "x", channel: "sms", body: "hi" }),
      (e: unknown) => (e as { status?: number }).status === 404,
    );
    await assert.rejects(
      replyToThread(fakeDb(lead).db, queue, { workspaceId: "ws", userId: "u", leadId: "lead_1", channel: "email", subject: "s", body: "hi" }),
      (e: unknown) => (e as { status?: number }).status === 400,
    );
    await assert.rejects(
      replyToThread(fakeDb(lead).db, queue, { workspaceId: "ws", userId: "u", leadId: "lead_1", channel: "sms", body: " " }),
      (e: unknown) => (e as { status?: number }).status === 400,
    );
    assert.equal(called, 0);
  });
});
