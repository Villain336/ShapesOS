// ShapesOS — Phase 18.2 (WS=comms): Calendar, the pure parts (unit):
// ICS generation (escaping, folding, UTC instants, all-day), free/busy slot
// finding (time zones, DST, working hours, buffers), the view grid, provider
// time parsing and recurring focus blocks.
// Run: npx tsx --test lib/comms/__tests__/calendar.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildIcs, escapeText, foldLine, icsDate, icsDateTime, icsFileName } from "../calendar/ics";
import { findSlots, mergeIntervals } from "../calendar/freebusy";
import { addDays, placeDay, shiftAnchor, startOfWeek, viewDays, viewWindow } from "../calendar/grid";
import { focusOccurrences, parseProviderTime } from "../calendar/sources.server";

const d = (s: string) => new Date(s);

describe("ICS generation (RFC 5545)", () => {
  it("formats UTC instants and DATE values", () => {
    assert.equal(icsDateTime(d("2026-10-12T15:04:05Z")), "20261012T150405Z");
    assert.equal(icsDate(d("2026-03-01T00:00:00Z")), "20260301");
  });
  it("escapes text: backslash, semicolon, comma, newlines", () => {
    assert.equal(escapeText("a\\b;c,d\ne\r\nf"), String.raw`a\\b\;c\,d\ne\nf`);
  });
  it("folds at 75 octets without splitting a UTF-8 character", () => {
    const long = `SUMMARY:${"é".repeat(60)}`;
    const folded = foldLine(long);
    const parts = folded.split("\r\n");
    assert.ok(parts.length > 1);
    const enc = new TextEncoder();
    assert.ok(enc.encode(parts[0]!).length <= 75);
    for (const p of parts.slice(1)) {
      assert.ok(p.startsWith(" "));
      assert.ok(enc.encode(p).length <= 75);
    }
    assert.equal(parts.map((p, i) => (i ? p.slice(1) : p)).join(""), long, "unfolds to the original");
    assert.equal(foldLine("SHORT:x"), "SHORT:x");
  });
  it("a whole calendar: CRLF, one VEVENT per event, timed and all-day, defaults for a missing end", () => {
    const ics = buildIcs({
      name: "Ana, test",
      refreshMinutes: 60,
      now: d("2026-10-01T00:00:00Z"),
      events: [
        { uid: "booking:1@shapesos", title: "Demo; call", start: d("2026-10-12T15:00:00Z"), end: d("2026-10-12T15:30:00Z"), attendees: ["ana@acme.com", "not-an-email"], url: "https://meet.example/x", location: "Room 1, floor 2" },
        { uid: "focus:2@shapesos", title: "Offsite", start: d("2026-10-13T00:00:00Z"), end: null, allDay: true },
        { uid: "reminder:3 bad uid!@shapesos", title: "", start: d("2026-10-14T09:00:00Z"), end: null, url: "javascript:alert(1)" },
      ],
    });
    assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
    assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
    assert.ok(!/[^\r]\n/.test(ics), "every line ends with CRLF");
    assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 3);
    assert.match(ics, /X-WR-CALNAME:Ana\\, test/);
    assert.match(ics, /DTSTART:20261012T150000Z\r\nDTEND:20261012T153000Z/);
    assert.ok(ics.includes(String.raw`SUMMARY:Demo\; call`));
    assert.match(ics, /LOCATION:Room 1\\, floor 2/);
    assert.match(ics, /ATTENDEE:mailto:ana@acme.com/);
    assert.ok(!ics.includes("not-an-email"));
    assert.match(ics, /DTSTART;VALUE=DATE:20261013\r\nDTEND;VALUE=DATE:20261014/, "all day: next day exclusive");
    assert.match(ics, /DTSTART:20261014T090000Z\r\nDTEND:20261014T093000Z/, "no end: 30 minutes");
    assert.match(ics, /SUMMARY:\(no title\)/);
    assert.match(ics, /UID:reminder-3-bad-uid-@shapesos/);
    assert.ok(!ics.includes("javascript:"), "only https URLs");
    assert.match(ics, /REFRESH-INTERVAL;VALUE=DURATION:PT60M/);
  });
  it("file names", () => {
    assert.equal(icsFileName("Café: Q4 review!"), "cafe-q4-review.ics");
    assert.equal(icsFileName("!!!"), "event.ics");
  });
});

describe("free/busy slots (time zones, DST)", () => {
  it("merges overlapping busy time", () => {
    const m = mergeIntervals([
      { start: d("2026-10-12T10:00:00Z"), end: d("2026-10-12T11:00:00Z") },
      { start: d("2026-10-12T10:30:00Z"), end: d("2026-10-12T12:00:00Z") },
      { start: d("2026-10-12T13:00:00Z"), end: d("2026-10-12T13:00:00Z") },
    ]);
    assert.equal(m.length, 1);
    assert.equal(m[0]!.end.toISOString(), "2026-10-12T12:00:00.000Z");
  });
  it("working hours are local: 09:00 New York is 13:00Z in summer and 14:00Z in winter", () => {
    const summer = findSlots({ busy: [], from: d("2026-10-30T00:00:00Z"), to: d("2026-10-31T00:00:00Z"), durationMin: 30, timeZone: "America/New_York", max: 1 });
    assert.equal(summer[0]!.start.toISOString(), "2026-10-30T13:00:00.000Z");
    const winter = findSlots({ busy: [], from: d("2026-11-02T00:00:00Z"), to: d("2026-11-03T00:00:00Z"), durationMin: 30, timeZone: "America/New_York", max: 1 });
    assert.equal(winter[0]!.start.toISOString(), "2026-11-02T14:00:00.000Z");
  });
  it("skips busy time, weekends and the end of the working day", () => {
    const busy = [{ start: d("2026-10-16T09:00:00Z"), end: d("2026-10-16T16:00:00Z") }]; // Fri
    const slots = findSlots({ busy, from: d("2026-10-16T00:00:00Z"), to: d("2026-10-20T00:00:00Z"), durationMin: 60, timeZone: "UTC", max: 3 });
    assert.deepEqual(slots.map((s) => s.start.toISOString()), ["2026-10-16T16:00:00.000Z", "2026-10-19T09:00:00.000Z", "2026-10-19T09:30:00.000Z"], "Friday 16:00–17:00, then Monday");
  });
  it("respects notBefore, buffers and custom hours / days", () => {
    const busy = [{ start: d("2026-10-12T10:00:00Z"), end: d("2026-10-12T11:00:00Z") }];
    const slots = findSlots({ busy, from: d("2026-10-12T00:00:00Z"), to: d("2026-10-13T00:00:00Z"), durationMin: 30, timeZone: "UTC", bufferMin: 15, notBefore: d("2026-10-12T09:10:00Z"), max: 2 });
    assert.deepEqual(slots.map((s) => s.start.toISOString()), ["2026-10-12T11:30:00.000Z", "2026-10-12T12:00:00.000Z"], "09:30 would end inside the 15-min buffer before 10:00");
    const sat = findSlots({ busy: [], from: d("2026-10-17T00:00:00Z"), to: d("2026-10-18T00:00:00Z"), durationMin: 60, timeZone: "UTC", days: [6], workStartMin: 600, workEndMin: 720 });
    assert.deepEqual(sat.map((s) => s.start.toISOString()), ["2026-10-17T10:00:00.000Z", "2026-10-17T10:30:00.000Z", "2026-10-17T11:00:00.000Z"]);
  });
  it("Asia/Kolkata (half-hour offset)", () => {
    const s = findSlots({ busy: [], from: d("2026-10-12T00:00:00Z"), to: d("2026-10-13T00:00:00Z"), durationMin: 30, timeZone: "Asia/Kolkata", max: 1 });
    assert.equal(s[0]!.start.toISOString(), "2026-10-12T03:30:00.000Z", "09:00 IST");
  });
});

describe("view grid", () => {
  it("weeks start on Monday; month views are six weeks", () => {
    assert.equal(startOfWeek("2026-10-18"), "2026-10-12", "Sunday → the Monday before");
    assert.equal(startOfWeek("2026-10-12"), "2026-10-12");
    const month = viewDays("month", "2026-10-15");
    assert.equal(month.length, 42);
    assert.equal(month[0], "2026-09-28");
    assert.deepEqual(viewDays("day", "2026-10-15"), ["2026-10-15"]);
    assert.equal(shiftAnchor("month", "2026-01-31", 1), "2026-02-01");
    assert.equal(shiftAnchor("week", "2026-12-28", 1), "2027-01-04");
    assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  });
  it("a view window starts and ends at local midnight (DST weeks are 167 / 169 hours)", () => {
    const w = viewWindow("week", "2026-03-11", "America/New_York");
    assert.equal(w.from.toISOString(), "2026-03-09T04:00:00.000Z");
    assert.equal((w.to.getTime() - w.from.getTime()) / 3_600_000, 7 * 24);
    const fall = viewWindow("week", "2026-10-28", "America/New_York");
    assert.equal((fall.to.getTime() - fall.from.getTime()) / 3_600_000, 7 * 24 + 1, "the week of the fall-back (Sun Nov 1) has 169 h");
    const spring = viewWindow("week", "2026-03-04", "America/New_York");
    assert.equal((spring.to.getTime() - spring.from.getTime()) / 3_600_000, 7 * 24 - 1, "the week of the spring-forward (Sun Mar 8) has 167 h");
  });
  it("places overlapping events side by side, clipped to the day", () => {
    const placed = placeDay(
      [
        { id: "a", start: "2026-10-12T09:00:00Z", end: "2026-10-12T10:00:00Z" },
        { id: "b", start: "2026-10-12T09:30:00Z", end: "2026-10-12T10:30:00Z" },
        { id: "c", start: "2026-10-12T11:00:00Z", end: null },
        { id: "late", start: "2026-10-12T23:45:00Z", end: "2026-10-13T01:00:00Z" },
      ],
      "2026-10-12",
      "UTC",
    );
    const by = Object.fromEntries(placed.map((p) => [p.id, p]));
    assert.equal(by.a!.top, 540);
    assert.equal(by.a!.height, 60);
    assert.deepEqual([by.a!.lane, by.b!.lane, by.a!.lanes, by.b!.lanes], [0, 1, 2, 2]);
    assert.deepEqual([by.c!.lane, by.c!.lanes, by.c!.height], [0, 1, 30]);
    assert.equal(by.late!.top + by.late!.height, 24 * 60, "clipped at midnight");
  });
});

describe("provider times and recurring focus blocks", () => {
  it("date-only is all day; a bare date-time is a wall time in the event's zone; offsets are instants", () => {
    assert.deepEqual(parseProviderTime("2026-10-12", null), { date: d("2026-10-12T00:00:00Z"), allDay: true });
    assert.equal(parseProviderTime("2026-10-12T15:00:00.0000000", "UTC")!.date.toISOString(), "2026-10-12T15:00:00.000Z");
    assert.equal(parseProviderTime("2026-10-12T15:00:00", "Europe/Madrid")!.date.toISOString(), "2026-10-12T13:00:00.000Z");
    assert.equal(parseProviderTime("2026-10-12T15:00:00+02:00", null)!.date.toISOString(), "2026-10-12T13:00:00.000Z");
    assert.equal(parseProviderTime("nope", null), null);
    assert.equal(parseProviderTime(null, null), null);
  });
  it("weekday focus blocks skip weekends and keep their local time across DST", () => {
    const block = { startAt: d("2026-10-29T13:00:00Z"), endAt: d("2026-10-29T15:00:00Z"), recurrence: "weekdays" }; // Thu 09:00 New York
    const occ = focusOccurrences(block, d("2026-10-29T00:00:00Z"), d("2026-11-04T00:00:00Z"), "America/New_York");
    assert.deepEqual(occ.map((o) => o.start.toISOString()), ["2026-10-29T13:00:00.000Z", "2026-10-30T13:00:00.000Z", "2026-11-02T14:00:00.000Z", "2026-11-03T14:00:00.000Z"]);
    assert.ok(occ.every((o) => o.end.getTime() - o.start.getTime() === 2 * 3_600_000));
    const once = focusOccurrences({ ...block, recurrence: "none" }, d("2026-11-01T00:00:00Z"), d("2026-11-02T00:00:00Z"), "UTC");
    assert.equal(once.length, 0, "a one-off outside the window");
  });
});
