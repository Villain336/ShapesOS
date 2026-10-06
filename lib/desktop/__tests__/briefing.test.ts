// ShapesOS — Phase 18.1 (WS=desk): the Today briefing's pure rules.
// Run: npx tsx --test lib/desktop/__tests__/briefing.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BRIEFING_MAX_CHARS, batchKeyFor, briefingParts, briefingSources, buildBriefingPrompt, cleanBriefingText, isBriefingDue, localDay, type BriefingInput } from "../briefing";

const input: BriefingInput = {
  memberName: "Tico Alvarez",
  workspaceName: "Acme",
  day: "2026-10-06",
  timeZone: "America/Los_Angeles",
  calendar: [{ time: "09:30", title: "Pipeline review with Sam" }],
  calendarConnected: true,
  needsYou: { count: 2, items: ["Send the October newsletter (Messaging and nurture)", "Pay invoice INV-7 (Tool action)"] },
  overnight: { finished: 3, failed: 1, waiting: 1, running: 0, highlights: ["Failed — researcher: competitor scan"] },
  metrics: [{ label: "Open pipeline", value: "12 leads, $48,000" }],
};

describe("the local day", () => {
  it("is the member's calendar day, not UTC's", () => {
    const t = new Date("2026-10-06T05:30:00Z"); // 22:30 the day before in Los Angeles
    assert.equal(localDay(t, "UTC"), "2026-10-06");
    assert.equal(localDay(t, "America/Los_Angeles"), "2026-10-05");
    assert.equal(localDay(t, null), "2026-10-06");
    assert.equal(localDay(t, "Not/AZone"), "2026-10-06", "an unknown zone falls back to UTC");
  });
  it("is due from 06:00 local", () => {
    assert.equal(isBriefingDue(new Date("2026-10-06T05:59:00Z"), "UTC"), false);
    assert.equal(isBriefingDue(new Date("2026-10-06T06:00:00Z"), "UTC"), true);
    assert.equal(isBriefingDue(new Date("2026-10-06T13:00:00Z"), "America/Los_Angeles"), true); // 06:00 PDT
    assert.equal(isBriefingDue(new Date("2026-10-06T12:00:00Z"), "America/Los_Angeles"), false);
  });
  it("one batch key per member per day", () => {
    assert.equal(batchKeyFor("2026-10-06", "u1"), "desktop_briefing:2026-10-06:u1");
    assert.notEqual(batchKeyFor("2026-10-06", "u1"), batchKeyFor("2026-10-06", "u2"));
  });
});

describe("the prompt", () => {
  const p = buildBriefingPrompt(input);
  it("carries every fact and the no-invention rule", () => {
    for (const fact of ["Tico", "Acme", "2026-10-06", "09:30 Pipeline review with Sam", "Send the October newsletter", "3 finished, 1 failed", "Open pipeline: 12 leads, $48,000"]) {
      assert.ok(p.includes(fact), fact);
    }
    assert.match(p, /Use ONLY the facts below/);
    assert.match(p, /Never invent/);
    assert.ok(!p.includes("Alvarez"), "first name only");
  });
  it("says so when a source is empty instead of leaving a gap", () => {
    const empty = buildBriefingPrompt({ ...input, calendar: [], calendarConnected: false, needsYou: { count: 0, items: [] }, metrics: [] });
    assert.match(empty, /no calendar connected/);
    assert.match(empty, /nothing scheduled/);
    assert.match(empty, /nothing waiting/);
    assert.match(empty, /none available/);
  });
  it("sources are counts only", () => {
    assert.deepEqual(briefingSources(input), { calendarEvents: 1, calendarConnected: true, needsYou: 2, overnightFinished: 3, overnightFailed: 1, metrics: 1 });
  });
});

describe("cleaning the model's text", () => {
  it("drops headings, fences and blank runs; normalizes bullets", () => {
    const out = cleanBriefingText("```\n## Today\n\n\nTwo things need you.\n* Approve the newsletter\n• Check the failed scan\n```");
    assert.equal(out, "Today\n\nTwo things need you.\n- Approve the newsletter\n- Check the failed scan");
  });
  it("caps the length at a line or sentence boundary", () => {
    const long = Array.from({ length: 400 }, (_, i) => `- Line ${i} is here.`).join("\n");
    const out = cleanBriefingText(long);
    assert.ok(out.length <= BRIEFING_MAX_CHARS);
    assert.ok(out.endsWith("."));
  });
  it("splits into a lead and bullets for display", () => {
    assert.deepEqual(briefingParts("Two things need you.\n- Approve the newsletter\n- Check the scan"), {
      lead: ["Two things need you."],
      bullets: ["Approve the newsletter", "Check the scan"],
    });
  });
});
