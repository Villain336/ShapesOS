// ShapesOS — booking availability on daylight-saving days (FULL-AUDIT
// §5: slots shifted or duplicated; regression for the edge2/book1.ts probe).
// Every local slot is converted on its own, days step by calendar date.

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

const NY = "America/New_York";
let settings: Record<string, unknown> = {};

// Fake Prisma before the module graph loads (lib/prisma reuses globalThis.prisma).
(globalThis as unknown as { prisma: unknown }).prisma = {
  bookingPage: { findFirst: async () => ({ id: "p", settings }) },
  booking: { findMany: async () => [] },
};

type BookingModule = typeof import("../booking");
let booking: BookingModule;

before(async () => {
  booking = await import("../booking");
});

async function localSlots(from: string, to: string) {
  const { slots, settings: s } = await booking.getAvailability({
    pageId: "p",
    workspaceId: "w",
    from: new Date(from),
    to: new Date(to),
  });
  const local = slots.map((x) => {
    const p = booking.zonedParts(new Date(x.startAt), NY);
    return `${p.ymd} ${String(Math.floor(p.minutes / 60)).padStart(2, "0")}:${String(p.minutes % 60).padStart(2, "0")}`;
  });
  return { slots, local, settings: s };
}

function expected(day: string, fromMin: number, toMin: number, step: number): string[] {
  const out: string[] = [];
  for (let m = fromMin; m + step <= toMin; m += step) {
    out.push(`${day} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return out;
}

describe("getAvailability on DST days (America/New_York)", () => {
  it("spring forward (Sun 2026-03-08): exactly the 09:00–17:00 local slots, none shifted", async () => {
    settings = { timezone: NY, durationMin: 30, bufferMin: 0, workingHours: { sun: [540, 1020] } };
    const { slots, local, settings: s } = await localSlots("2026-03-08T05:00:00Z", "2026-03-09T03:59:00Z");
    assert.deepEqual(local, expected("2026-03-08", 540, 1020, 30));
    assert.equal(new Set(slots.map((x) => x.startAt)).size, slots.length);
    assert.equal(slots[0].startAt, "2026-03-08T13:00:00.000Z"); // 09:00 EDT
    assert.ok(slots.every((x) => booking.isOfferedSlot(s, new Date(x.startAt))));
  });

  it("fall back (Sun 2026-11-01): exactly the local slots, no duplicates, none shifted", async () => {
    settings = { timezone: NY, durationMin: 30, bufferMin: 0, workingHours: { sun: [540, 1020], mon: [540, 1020] } };
    const { slots, local, settings: s } = await localSlots("2026-11-01T04:00:00Z", "2026-11-03T04:59:00Z");
    assert.deepEqual(local, [...expected("2026-11-01", 540, 1020, 30), ...expected("2026-11-02", 540, 1020, 30)]);
    assert.equal(new Set(slots.map((x) => x.startAt)).size, slots.length);
    assert.equal(slots[0].startAt, "2026-11-01T14:00:00.000Z"); // 09:00 EST
    assert.ok(slots.every((x) => booking.isOfferedSlot(s, new Date(x.startAt))));
  });

  it("night hours across the transitions: gap slots skipped, repeated hour offered once", async () => {
    settings = { timezone: NY, durationMin: 30, bufferMin: 0, workingHours: { sun: [0, 240] } };
    const spring = await localSlots("2026-03-08T05:00:00Z", "2026-03-08T12:00:00Z");
    // 02:00 and 02:30 don't exist on 2026-03-08.
    assert.deepEqual(spring.local, ["2026-03-08 00:00", "2026-03-08 00:30", "2026-03-08 01:00", "2026-03-08 01:30", "2026-03-08 03:00", "2026-03-08 03:30"]);
    const fall = await localSlots("2026-11-01T04:00:00Z", "2026-11-01T12:00:00Z");
    assert.deepEqual(fall.local, expected("2026-11-01", 0, 240, 30));
    assert.equal(new Set(fall.slots.map((x) => x.startAt)).size, fall.slots.length);
    // The second 01:30 (EST) is not an offered slot; the first (EDT) is.
    assert.equal(booking.isOfferedSlot(fall.settings, new Date("2026-11-01T05:30:00Z")), true);
    assert.equal(booking.isOfferedSlot(fall.settings, new Date("2026-11-01T06:30:00Z")), false);
  });

  it("isOfferedSlot rejects off-grid seconds and unknown timezones fail validation", () => {
    const s = booking.BookingSettingsSchema.parse({ timezone: NY, durationMin: 30, workingHours: { mon: [540, 1020] } });
    assert.equal(booking.isOfferedSlot(s, new Date("2026-10-05T13:00:00Z")), true);
    assert.equal(booking.isOfferedSlot(s, new Date("2026-10-05T13:00:30Z")), false);
    assert.equal(booking.BookingSettingsSchema.safeParse({ timezone: "Mars/Olympus" }).success, false);
  });
});
