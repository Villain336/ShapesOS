// ShapesOS — Phase 18.2 (WS=comms): Meet pure rules — the meeting agent's
// summary parsing, transcript trimming, due dates in the person's zone
// (across DST), owner matching, the notes doc, origins and room names.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dueToUtc,
  matchOwner,
  meetingRoomName,
  notesParagraphs,
  parseMeetingSummary,
  RECORDING_IMPORTERS,
  RECORDING_SOURCES,
  summaryPrompt,
  trimTranscript,
  validCalendarRef,
} from "../meet/model";

describe("the meeting agent's summary", () => {
  it("parses notes, decisions and action items from fenced / chatty output", () => {
    const raw = 'Here you go:\n```json\n{"notes":"We reviewed Q4.","decisions":["Ship on Friday"," "],"actionItems":[{"title":"Send the deck","owner":"Ben","due":"2026-10-09"},{"title":"Book the venue","owner":null,"due":"next week"},"Call Ada",{"owner":"x"}]}\n```';
    const s = parseMeetingSummary(raw)!;
    assert.equal(s.notes, "We reviewed Q4.");
    assert.deepEqual(s.decisions, ["Ship on Friday"]);
    assert.deepEqual(s.actionItems, [
      { title: "Send the deck", owner: "Ben", due: "2026-10-09" },
      { title: "Book the venue", owner: null, due: null },
      { title: "Call Ada", owner: null, due: null },
    ]);
  });

  it("returns null for nothing usable; accepts action_items; caps lists", () => {
    assert.equal(parseMeetingSummary("no json here"), null);
    assert.equal(parseMeetingSummary("{broken"), null);
    assert.equal(parseMeetingSummary('{"notes":"","decisions":[],"actionItems":[]}'), null);
    const s = parseMeetingSummary(JSON.stringify({ action_items: Array.from({ length: 40 }, (_, i) => ({ title: `t${i}` })) }))!;
    assert.equal(s.actionItems.length, 30);
    assert.equal(s.notes, "");
    assert.equal(parseMeetingSummary('{"actionItems":[{"title":"x","due":"2026-02-30"}]}')!.actionItems[0]!.due, null, "an impossible date is dropped");
  });

  it("the prompt asks for JSON and says never to invent", () => {
    const p = summaryPrompt("Weekly sync", "Ana: hi");
    assert.match(p, /never invent/);
    assert.match(p, /"actionItems"/);
    assert.match(p, /Meeting: Weekly sync/);
  });
});

describe("transcripts, due dates, owners", () => {
  it("a long transcript keeps its head and tail", () => {
    const t = `${"a".repeat(30_000)}MIDDLE${"z".repeat(30_000)}`;
    const out = trimTranscript(t, 24_000);
    assert.ok(out.length <= 24_100);
    assert.ok(out.startsWith("aaa") && out.endsWith("zzz"));
    assert.match(out, /characters left out/);
    assert.ok(!out.includes("MIDDLE"));
    assert.equal(trimTranscript("  short  "), "short");
  });

  it("a due date is 09:00 in the person's zone, across DST", () => {
    assert.equal(dueToUtc("2026-10-09", "America/New_York")!.toISOString(), "2026-10-09T13:00:00.000Z", "EDT −4");
    assert.equal(dueToUtc("2026-11-02", "America/New_York")!.toISOString(), "2026-11-02T14:00:00.000Z", "EST −5 after the switch");
    assert.equal(dueToUtc("2026-03-30", "Europe/Madrid")!.toISOString(), "2026-03-30T07:00:00.000Z", "CEST +2");
    assert.equal(dueToUtc(null, "UTC"), null);
    assert.equal(dueToUtc("tomorrow", "UTC"), null);
  });

  it("an owner matches one member by full name, unique first name or email", () => {
    const members = [
      { userId: "u1", name: "Ana García", email: "ana@x.test" },
      { userId: "u2", name: "Ben Ode", email: "ben@x.test" },
      { userId: "u3", name: "Ana Lopez", email: "alopez@x.test" },
    ];
    assert.equal(matchOwner("Ben", members), "u2");
    assert.equal(matchOwner("ana garcía", members), "u1");
    assert.equal(matchOwner("Ana", members), null, "two Anas: nobody");
    assert.equal(matchOwner("alopez@x.test", members), "u3");
    assert.equal(matchOwner(null, members), null);
    assert.equal(matchOwner("Zed", members), null);
  });
});

describe("the notes doc, origins, rooms, recording seam", () => {
  it("writes notes, decisions and action items with headings, and says it was post-call", () => {
    const paras = notesParagraphs({ title: "Sync", when: "2026-10-06 15:00 UTC", transcriptSource: "pasted", summary: { notes: "One.\n\nTwo.", decisions: [], actionItems: [{ title: "Send deck", owner: "Ben", due: "2026-10-09" }] } });
    const text = paras.map((p) => p.text);
    assert.deepEqual(paras.filter((p) => p.headingLevel === 2).map((p) => p.text), ["Notes", "Decisions", "Action items"]);
    assert.ok(text.includes("One.") && text.includes("Two."));
    assert.ok(text.includes("None recorded."));
    assert.ok(text.includes("• Send deck — Ben (due 2026-10-09)"));
    assert.match(text.at(-1)!, /pasted transcript \(after the call\)/);
  });

  it("calendar refs, room names and the Zoom / Google Meet seam", () => {
    assert.ok(validCalendarRef("google:conn1:evt_123"));
    assert.ok(validCalendarRef("booking:abc"));
    assert.ok(!validCalendarRef("javascript:alert(1)"));
    assert.ok(!validCalendarRef("google:has space"));
    assert.ok(!validCalendarRef(null));
    assert.equal(meetingRoomName("ws_1!", "m/2"), "meet-ws_1-m2");
    assert.deepEqual(
      RECORDING_SOURCES.filter((r) => !r.available).map((r) => r.key),
      ["zoom", "google_meet"],
    );
    assert.deepEqual(Object.keys(RECORDING_IMPORTERS), [], "no importer is faked before 18.5");
  });
});
