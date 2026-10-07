// Phase 19B (WS=engine) — residents from personas + segment sliders, their
// homes, jobs, ties and routine schedules (weekday / weekend / night shift).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateTown } from "../generate";
import { generateResidents, scheduleBlock, minuteOf, type SegmentSpec } from "../residents";
import { validSpec } from "../../panel/__tests__/fixtures";

const town = generateTown({ seed: 3, size: "small" });
const persona = { id: "p-maya", spec: validSpec(), calibrated: true };
const segments: SegmentSpec[] = [
  { key: "maya", label: "Maya-like buyers", share: 0.6, personaId: "p-maya", routineMix: { weekday: 1 } },
  { key: "night", label: "Night workers", share: 0.4, personaId: null, routineMix: { night: 1 }, income: "low" },
];

describe("generateResidents", () => {
  const people = generateResidents({ layout: town, population: 50, segments, personas: [persona], seed: 11 });

  it("makes exactly the population, split by segment share", () => {
    assert.equal(people.length, 50);
    assert.equal(people.filter((r) => r.segment === "maya").length, 30);
    assert.equal(people.filter((r) => r.segment === "night").length, 20);
  });

  it("gives everyone a home and a workplace that exist in the town, within capacity", () => {
    const lots = new Map(town.lots.map((l) => [l.id, l]));
    for (const r of people) {
      assert.equal(lots.get(r.homeLotId)?.kind, "home");
      assert.ok(["work", "shop", "cafe"].includes(lots.get(r.workLotId)!.kind));
    }
    const perHome = new Map<string, number>();
    for (const r of people) perHome.set(r.homeLotId, (perHome.get(r.homeLotId) ?? 0) + 1);
    for (const [id, n] of perHome) assert.ok(n <= (lots.get(id)!.capacity ?? 4), `${id} holds ${n}`);
  });

  it("carries the persona (calibrated) or marks the resident uncalibrated", () => {
    const m = people.find((r) => r.segment === "maya")!;
    assert.equal(m.personaId, "p-maya");
    assert.equal(m.calibrated, true);
    const n = people.find((r) => r.segment === "night")!;
    assert.equal(n.personaId, null);
    assert.equal(n.calibrated, false);
    assert.equal(n.routine, "night");
  });

  it("ties: symmetric friendships (small world) and family by household, never to self", () => {
    const byId = new Map(people.map((r) => [r.id, r]));
    for (const r of people) {
      assert.ok(!r.friends.includes(r.id) && !r.family.includes(r.id));
      for (const f of r.friends) assert.ok(byId.get(f)!.friends.includes(r.id), `${r.id}↔${f}`);
      for (const f of r.family) assert.equal(byId.get(f)!.homeLotId, r.homeLotId);
    }
    const mean = people.reduce((s, r) => s + r.friends.length, 0) / people.length;
    assert.ok(mean >= 3 && mean <= 5, `mean friends ${mean}`);
  });

  it("is deterministic per seed", () => {
    assert.deepEqual(generateResidents({ layout: town, population: 50, segments, personas: [persona], seed: 11 }), people);
    assert.notDeepEqual(generateResidents({ layout: town, population: 50, segments, personas: [persona], seed: 12 }), people);
  });

  it("refuses a population the town has no homes for", () => {
    assert.throws(() => generateResidents({ layout: town, population: 5_000, segments, personas: [persona], seed: 1 }), /homes for/);
  });
});

describe("routine schedules", () => {
  const people = generateResidents({ layout: town, population: 50, segments, personas: [persona], seed: 11 });
  const weekdayer = people.find((r) => r.routine === "weekday")!;
  const nightWorker = people.find((r) => r.routine === "night")!;
  // Day 0 is a Monday.
  it("a weekday resident is at work during work hours, Monday to Friday", () => {
    for (let day = 0; day < 5; day++) {
      assert.equal(scheduleBlock(weekdayer, minuteOf(day, 11, 0)), "work", `day ${day} 11:00`);
      assert.equal(scheduleBlock(weekdayer, minuteOf(day, 15, 30)), "work", `day ${day} 15:30`);
    }
    assert.equal(scheduleBlock(weekdayer, minuteOf(2, 3, 0)), "sleep", "Wednesday 03:00");
    assert.equal(scheduleBlock(weekdayer, minuteOf(2, 19, 0)), "free", "Wednesday 19:00");
  });

  it("…and free on the weekend", () => {
    assert.equal(scheduleBlock(weekdayer, minuteOf(5, 11, 0)), "free", "Saturday 11:00");
    assert.equal(scheduleBlock(weekdayer, minuteOf(6, 15, 0)), "free", "Sunday 15:00");
  });

  it("a night-shift resident works across midnight and sleeps in the morning", () => {
    assert.equal(scheduleBlock(nightWorker, minuteOf(0, 23, 30)), "work", "Monday 23:30");
    assert.equal(scheduleBlock(nightWorker, minuteOf(1, 3, 0)), "work", "Tuesday 03:00 (Monday's shift)");
    assert.equal(scheduleBlock(nightWorker, minuteOf(1, 10, 0)), "sleep", "Tuesday 10:00");
    assert.equal(scheduleBlock(nightWorker, minuteOf(5, 23, 30)), "free", "Saturday night off");
  });

  it("a weekend-routine resident works Saturday and is off Tuesday", () => {
    const weekender = generateResidents({ layout: town, population: 10, segments: [{ key: "w", label: "Weekend staff", share: 1, routineMix: { weekend: 1 } }], personas: [], seed: 2 })[0]!;
    assert.equal(weekender.routine, "weekend");
    assert.equal(scheduleBlock(weekender, minuteOf(5, 13, 0)), "work", "Saturday 13:00");
    assert.equal(scheduleBlock(weekender, minuteOf(1, 13, 0)), "free", "Tuesday 13:00");
  });
});
