// ShapesOS — Phase 18.2 (WS=comms): Mail, the pure parts (unit): thread keys,
// merging / ordering threads across sources, folders, search, Outlook
// conversation grouping, Gmail header summaries and body extraction, and the
// inbox agent's summary parsing.
// Run: npx tsx --test lib/comms/__tests__/mail.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupByConversation, inFolder, matchesQuery, mergeThreads, normalizeTag, parseParty, parseThreadKey, threadKey, type MailThreadView } from "../mail/types";
import { htmlToText, messageText, summarizeThread } from "@/lib/connectors/m21/live/gmail-read";
import { parseSummaryJson } from "../mail/agent.server";

const view = (key: string, at: string, over: Partial<MailThreadView> = {}): MailThreadView => ({
  key,
  source: key.startsWith("crm:") ? "crm" : key.startsWith("social:") ? "social" : key.startsWith("outlook:") ? "outlook" : "gmail",
  via: "x",
  subject: `Subject ${key}`,
  from: { name: null, address: null },
  participants: [],
  snippet: null,
  lastMessageAt: at,
  messageCount: 1,
  unread: false,
  archived: false,
  labels: [],
  tags: [],
  suggestedTags: [],
  summary: null,
  channel: null,
  mock: false,
  organizable: true,
  ...over,
});

describe("thread keys", () => {
  it("round-trip every source; opaque provider ids may contain ':' , '/' and '='", () => {
    for (const ref of [
      { source: "gmail", connectionId: "conn1", externalId: "18c2f0a" },
      { source: "outlook", connectionId: "conn_2", externalId: "AAQkAGI2=+/x" },
      { source: "crm", leadId: "lead-9" },
      { source: "social", accountId: "65f0aa", conversationId: "ig:1784:thread" },
    ] as const) {
      assert.deepEqual(parseThreadKey(threadKey(ref)), ref);
    }
  });
  it("rejects malformed keys", () => {
    for (const bad of ["", "gmail", "gmail:", "gmail:conn", "nope:a:b", "crm:", "crm:a:b", "gmail:bad id!:x", "gmail:c:has space", 42, null]) {
      assert.equal(parseThreadKey(bad), null, String(bad));
    }
  });
});

describe("merging the sources", () => {
  it("newest first across sources, stable ties, one row per key, capped", () => {
    const merged = mergeThreads(
      [
        [view("gmail:c:1", "2026-10-05T10:00:00.000Z"), view("gmail:c:2", "2026-10-01T10:00:00.000Z")],
        [view("crm:l1", "2026-10-06T08:00:00.000Z"), view("gmail:c:1", "2026-10-09T00:00:00.000Z", { subject: "dupe" })],
        [view("social:a:z", "2026-10-05T10:00:00.000Z"), view("social:a:b", "2026-10-05T10:00:00.000Z")],
      ],
      4,
    );
    assert.deepEqual(merged.map((t) => t.key), ["crm:l1", "gmail:c:1", "social:a:b", "social:a:z"]);
    assert.notEqual(merged[1]!.subject, "dupe", "the first list's row wins");
  });
  it("folders and search", () => {
    assert.equal(inFolder({ archived: false, unread: false }, "inbox"), true);
    assert.equal(inFolder({ archived: true, unread: true }, "unread"), false);
    assert.equal(inFolder({ archived: true, unread: false }, "archived"), true);
    const t = view("gmail:c:1", "2026-10-05T10:00:00.000Z", { subject: "Q4 invoice", from: { name: "Ana Ruiz", address: "ana@acme.com" }, tags: ["billing"] });
    assert.ok(matchesQuery(t, "invoice ana"));
    assert.ok(matchesQuery(t, "BILLING"));
    assert.ok(!matchesQuery(t, "invoice bob"));
    assert.ok(matchesQuery(t, "  "));
  });
  it("people and labels", () => {
    assert.deepEqual(parseParty("Ana Ruiz <ANA@acme.com>"), { name: "Ana Ruiz", address: "ana@acme.com" });
    assert.deepEqual(parseParty('"Ruiz, Ana" <ana@acme.com>'), { name: "Ruiz, Ana", address: "ana@acme.com" });
    assert.deepEqual(parseParty("ana@acme.com"), { name: null, address: "ana@acme.com" });
    assert.deepEqual(parseParty(""), { name: null, address: null });
    assert.equal(normalizeTag("  Needs   Reply!! "), "needs reply");
    assert.equal(normalizeTag("<script>"), "script");
    assert.equal(normalizeTag(""), null);
  });
});

describe("Outlook conversations", () => {
  it("one row per conversation: newest message's sender, first subject, unread if any is", () => {
    const rows = groupByConversation([
      { id: "m1", conversationId: "c1", receivedAt: "2026-10-01T09:00:00Z", subject: "Quote", from: "ada@x.com", isRead: true },
      { id: "m2", conversationId: "c1", receivedAt: "2026-10-02T09:00:00Z", subject: "RE: Quote", from: "bo@x.com", isRead: false, preview: "Sounds good" },
      { id: "m3", conversationId: null, receivedAt: "2026-10-03T09:00:00Z", subject: "Solo", from: "cy@x.com", isRead: true },
    ]);
    assert.deepEqual(rows.map((r) => r.conversationId), ["m3", "c1"]);
    const c1 = rows[1]!;
    assert.equal(c1.subject, "Quote");
    assert.equal(c1.from, "bo@x.com");
    assert.equal(c1.latestMessageId, "m2");
    assert.equal(c1.messageCount, 2);
    assert.equal(c1.unread, true);
    assert.equal(c1.preview, "Sounds good");
    assert.deepEqual(c1.participants.sort(), ["ada@x.com", "bo@x.com"]);
  });
});

describe("Gmail reads", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  it("summarizes a thread from its headers (never the body)", () => {
    const s = summarizeThread({
      id: "t1",
      messages: [
        { id: "a", internalDate: String(Date.parse("2026-10-01T09:00:00Z")), labelIds: ["INBOX"], payload: { headers: [{ name: "Subject", value: "Pricing" }, { name: "From", value: "Ana <ana@acme.com>" }, { name: "To", value: "me@co.com" }] } },
        { id: "b", internalDate: String(Date.parse("2026-10-02T09:00:00Z")), labelIds: ["INBOX", "UNREAD"], snippet: "Following up", payload: { headers: [{ name: "Subject", value: "Re: Pricing" }, { name: "From", value: "Bo <bo@acme.com>" }, { name: "Cc", value: "ana@acme.com" }] } },
      ],
    })!;
    assert.equal(s.subject, "Pricing");
    assert.equal(s.from, "Bo <bo@acme.com>");
    assert.equal(s.lastMessageAt, "2026-10-02T09:00:00.000Z");
    assert.equal(s.unread, true);
    assert.equal(s.latestMessageId, "b");
    assert.deepEqual(s.participants.sort(), ["ana@acme.com", "bo@acme.com", "me@co.com"]);
    assert.ok(s.labels.includes("UNREAD"));
    assert.equal(summarizeThread({ id: "x", messages: [] }), null);
  });
  it("extracts the text: text/plain first, else HTML as text; attachments are skipped", () => {
    assert.equal(messageText({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64("<p>Hi <b>Ana</b></p>") } }, { mimeType: "text/plain", body: { data: b64("Hi Ana") } }] }), "Hi Ana");
    assert.equal(messageText({ mimeType: "text/html", body: { data: b64("<style>x{}</style><p>Line 1</p><p>Line &amp; 2</p>") } }), "Line 1\nLine & 2");
    assert.equal(messageText({ mimeType: "multipart/mixed", parts: [{ mimeType: "text/plain", filename: "a.txt", body: { data: b64("ATTACHMENT") } }] }), "");
    assert.equal(htmlToText("<script>alert(1)</script>ok"), "ok");
  });
});

describe("inbox agent output", () => {
  it("parses the summary JSON (fenced or with prose), normalizes labels", () => {
    assert.deepEqual(parseSummaryJson('```json\n{"summary": "Ana wants a quote.", "labels": ["Sales", "needs reply", "needs reply"]}\n```'), { summary: "Ana wants a quote.", labels: ["sales", "needs reply"] });
    assert.equal(parseSummaryJson("no json here"), null);
    assert.equal(parseSummaryJson('{"labels": ["x"]}'), null, "a summary is required");
  });
});
