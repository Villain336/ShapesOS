// ShapesOS — scheduler cron parser / next-run / tick containment
// (FULL-AUDIT-2026-10-03 §5: leap-day cron halted the scheduler; "-5" and
// "1-2-3" were accepted). Regression for the edge/p1.ts probe.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import {
  CronParseError,
  cronMatches,
  cronMatchesInZone,
  nextFutureRunAfter,
  nextFutureRunAfterInZone,
  nextRunAfter,
  nextRunAfterInZone,
  parseCron,
} from "../cron";
import { runSchedulerTick } from "../tick";

describe("parseCron — malformed input", () => {
  for (const bad of [
    "-5 * * * *",
    "1-2-3 * * * *",
    "5- * * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * 32 * *",
    "* * * 13 *",
    "* * * * 8",
    "10-5 * * * *",
    "1-70 * * * *",
    "*/0 * * * *",
    "1/2/3 * * * *",
    "0 0 30 2 *",
    "0 0 31 4,6,9,11 *",
  ]) {
    it(`rejects "${bad}"`, () => assert.throws(() => parseCron(bad), CronParseError));
  }

  it("still accepts the standard forms", () => {
    assert.deepEqual([...parseCron("*/15 * * * *").minute], [0, 15, 30, 45]);
    assert.deepEqual([...parseCron("5/20 * * * *").minute], [5, 25, 45]);
    assert.deepEqual([...parseCron("1-3,7 * * * *").minute], [1, 2, 3, 7]);
    assert.deepEqual([...parseCron("0 9-17/4 * * *").hour], [9, 13, 17]);
    parseCron("0 0 29 2 *");
    parseCron("0 0 31 1-12 *");
  });

  it("0 and 7 are both Sunday", () => {
    const sun = new Date("2026-10-04T09:00:00Z");
    assert.equal(cronMatches(parseCron("0 9 * * 7"), sun), true);
    assert.equal(cronMatches(parseCron("0 9 * * 0"), sun), true);
    assert.equal(cronMatches(parseCron("0 9 * * 1-5"), sun), false);
  });

  it("day-of-month and day-of-week combine with OR when both are restricted", () => {
    const s = parseCron("0 9 1 * 1");
    assert.equal(cronMatches(s, new Date("2026-10-01T09:00:00Z")), true); // Thu the 1st
    assert.equal(cronMatches(s, new Date("2026-10-05T09:00:00Z")), true); // a Monday
    assert.equal(cronMatches(s, new Date("2026-10-06T09:00:00Z")), false);
    // A "*"-prefixed field stays unrestricted (AND with the other).
    const t = parseCron("0 9 */2 * 1");
    assert.equal(cronMatches(t, new Date("2026-10-05T09:00:00Z")), true); // Monday, odd day
    assert.equal(cronMatches(t, new Date("2026-10-12T09:00:00Z")), false); // Monday, even day
    assert.equal(cronMatches(t, new Date("2026-10-01T09:00:00Z")), false); // odd day, Thursday
  });
});

describe("nextRunAfter", () => {
  it("finds Feb 29 from 2026 (more than a year away)", () => {
    const s = parseCron("0 0 29 2 *");
    assert.equal(nextRunAfter(s, new Date("2026-10-03T00:00:00Z")).toISOString(), "2028-02-29T00:00:00.000Z");
  });

  it("advances past a leap-day fire to the next leap year (the tick path)", () => {
    const s = parseCron("0 0 29 2 *");
    const next = nextFutureRunAfter(s, new Date("2028-02-29T00:00:00Z"), new Date("2028-02-29T00:00:30Z"));
    assert.equal(next.toISOString(), "2032-02-29T00:00:00.000Z");
  });

  it("covers the 8-year leap gap across a non-leap century year", () => {
    const s = parseCron("0 0 29 2 *");
    assert.equal(nextRunAfter(s, new Date("2096-03-01T00:00:00Z")).toISOString(), "2104-02-29T00:00:00.000Z");
  });

  it("is strictly after `from`, at minute resolution", () => {
    const s = parseCron("*/5 * * * *");
    assert.equal(nextRunAfter(s, new Date("2026-10-03T10:05:00Z")).toISOString(), "2026-10-03T10:10:00.000Z");
    assert.equal(nextRunAfter(s, new Date("2026-10-03T10:04:59Z")).toISOString(), "2026-10-03T10:05:00.000Z");
    assert.equal(nextRunAfter(parseCron("30 23 * * *"), new Date("2026-12-31T23:30:00Z")).toISOString(), "2027-01-01T23:30:00.000Z");
  });

  it("catch-up jumps straight past a long downtime (no replay)", () => {
    const s = parseCron("* * * * *");
    const next = nextFutureRunAfter(s, new Date("2026-01-01T00:00:00Z"), new Date("2026-10-03T12:00:10Z"));
    assert.equal(next.toISOString(), "2026-10-03T12:01:00.000Z");
  });

  it("is fast for sparse schedules", () => {
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) nextRunAfter(parseCron("0 0 29 2 1"), new Date("2026-10-03T00:00:00Z"));
    assert.ok(Date.now() - t0 < 2000);
  });
});

describe("cronMatchesInZone", () => {
  it("reads the schedule as wall-clock time in the zone", () => {
    const s = parseCron("0 9 * * 1");
    // Mon 2026-10-05 09:00 EDT = 13:00Z
    assert.equal(cronMatchesInZone(s, new Date("2026-10-05T13:00:00Z"), "America/New_York"), true);
    assert.equal(cronMatchesInZone(s, new Date("2026-10-05T09:00:00Z"), "America/New_York"), false);
    // Across fall-back, 09:00 EST = 14:00Z
    assert.equal(cronMatchesInZone(s, new Date("2026-11-02T14:00:00Z"), "America/New_York"), true);
  });
});

// ── per-schedule timezone (Phase 4a follow-up: schedules ran in UTC) ─────────

describe("nextRunAfterInZone", () => {
  const NY = "America/New_York";
  const iso = (d: Date) => d.toISOString();

  it("reads the cron as wall-clock time in the schedule's zone", () => {
    const s = parseCron("0 9 * * 1");
    // Mon 2026-10-05 09:00 EDT = 13:00Z (UTC would have said 09:00Z).
    assert.equal(iso(nextRunAfterInZone(s, new Date("2026-10-03T00:00:00Z"), NY)), "2026-10-05T13:00:00.000Z");
    // Kolkata is +05:30 with no DST: Mon 09:00 IST = 03:30Z.
    assert.equal(iso(nextRunAfterInZone(s, new Date("2026-10-03T00:00:00Z"), "Asia/Kolkata")), "2026-10-05T03:30:00.000Z");
    // Local day boundary: Sunday 23:00 UTC is already Monday in Tokyo.
    assert.equal(iso(nextRunAfterInZone(parseCron("30 8 * * 1"), new Date("2026-10-04T20:00:00Z"), "Asia/Tokyo")), "2026-10-04T23:30:00.000Z");
  });

  it("keeps local time across the fall-back transition and fires once in the repeated hour", () => {
    // 2026-11-01: New York falls back 02:00 EDT → 01:00 EST.
    const daily9 = parseCron("0 9 * * *");
    assert.equal(iso(nextRunAfterInZone(daily9, new Date("2026-10-31T13:00:00Z"), NY)), "2026-11-01T14:00:00.000Z");
    const daily130 = parseCron("30 1 * * *");
    const first = nextRunAfterInZone(daily130, new Date("2026-11-01T00:00:00Z"), NY);
    assert.equal(iso(first), "2026-11-01T05:30:00.000Z", "earlier 01:30 (EDT)");
    assert.equal(iso(nextRunAfterInZone(daily130, first, NY)), "2026-11-02T06:30:00.000Z", "not again at 01:30 EST");
  });

  it("a wall time skipped by spring-forward fires shifted forward, not never", () => {
    // 2026-03-08: New York springs forward 02:00 → 03:00; 02:30 doesn't exist.
    const s = parseCron("30 2 * * *");
    assert.equal(iso(nextRunAfterInZone(s, new Date("2026-03-08T05:00:00Z"), NY)), "2026-03-08T07:30:00.000Z");
    assert.equal(iso(nextRunAfterInZone(s, new Date("2026-03-08T07:30:00Z"), NY)), "2026-03-09T06:30:00.000Z");
  });

  it("UTC (the default) is exactly the old behaviour", () => {
    for (const expr of ["0 9 * * 1", "*/5 * * * *", "0 0 29 2 *", "15 3 1,15 * *"]) {
      const s = parseCron(expr);
      const from = new Date("2026-10-03T10:04:59Z");
      assert.equal(iso(nextRunAfterInZone(s, from, "UTC")), iso(nextRunAfter(s, from)));
    }
    const s = parseCron("0 * * * *");
    assert.equal(
      iso(nextFutureRunAfterInZone(s, new Date("2026-01-01T00:00:00Z"), new Date("2026-10-03T12:00:10Z"), NY)),
      "2026-10-03T13:00:00.000Z",
    );
  });

  it("agrees with cronMatchesInZone minute by minute (no slot skipped or invented)", () => {
    const zones = [NY, "Europe/London", "Asia/Kolkata", "Australia/Lord_Howe", "Pacific/Chatham"];
    const exprs = ["0 9 * * 1-5", "*/7 * * * *", "45 23 * * 0", "0 0 1 * *", "30 6,18 * * *"];
    // A DST-free window (late May–June) so every wall time is exact.
    const from = new Date("2026-05-20T00:00:00Z");
    for (const tz of zones) {
      for (const expr of exprs) {
        const s = parseCron(expr);
        let cursor = from;
        for (let k = 0; k < 4; k++) {
          const next = nextRunAfterInZone(s, cursor, tz);
          assert.equal(cronMatchesInZone(s, next, tz), true, `${expr} @ ${tz}: ${iso(next)} must match`);
          // Brute force: no matching minute strictly between cursor and next.
          for (let t = Math.floor(cursor.getTime() / 60_000) * 60_000 + 60_000; t < next.getTime(); t += 60_000) {
            if (cronMatchesInZone(s, new Date(t), tz)) assert.fail(`${expr} @ ${tz}: skipped ${new Date(t).toISOString()}`);
          }
          cursor = next;
        }
      }
    }
  });

  it("stays fast for an every-minute schedule and a leap-day schedule", () => {
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) nextRunAfterInZone(parseCron("* * * * *"), new Date("2026-10-03T12:00:00Z"), NY);
    assert.equal(iso(nextRunAfterInZone(parseCron("0 0 29 2 *"), new Date("2026-10-03T00:00:00Z"), NY)), "2028-02-29T05:00:00.000Z");
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
  });
});

// ── tick containment (fake db) ────────────────────────────────────────────

interface Row {
  id: string;
  workspaceId: string;
  projectId: string | null;
  status: "active" | "paused";
  triggerType: "cron";
  cronExpr: string | null;
  nextRunAt: Date | null;
  timezone?: string;
}

function fakeDb(rows: Row[], frozenWorkspaces: readonly string[] = []) {
  const audits: { action: string; summary: string; workspaceId: string }[] = [];
  const db = {
    // Phase 18.1: the tick skips workspaces paused from Control Center (frozenAt).
    workspace: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => frozenWorkspaces.includes(id)).map((id) => ({ id })),
    },
    scheduledSkill: {
      findMany: async () => rows.filter((r) => r.status === "active").map((r) => ({ ...r })),
      updateMany: async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
        const r = rows.find((x) => x.id === where.id);
        if (!r) return { count: 0 };
        if (where.status && r.status !== where.status) return { count: 0 };
        if (where.nextRunAt && r.nextRunAt?.getTime() !== where.nextRunAt.getTime()) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
    },
    fileChangeLog: {
      create: async ({ data }: { data: { action: string; summary: string; workspaceId: string } }) => {
        audits.push(data);
        return data;
      },
    },
  };
  return { db: db as unknown as PrismaClient, audits };
}

describe("runSchedulerTick containment", () => {
  const now = new Date("2028-02-29T00:00:30Z");

  it("Phase 18.1: a paused workspace's schedule is not fired and stays due (catch-up after resume)", async () => {
    const due = new Date("2028-02-29T00:00:00Z");
    const rows: Row[] = [
      { id: "paused-ws", workspaceId: "w-paused", projectId: null, status: "active", triggerType: "cron", cronExpr: "0 0 * * *", nextRunAt: due },
      { id: "live-ws", workspaceId: "w-live", projectId: null, status: "active", triggerType: "cron", cronExpr: "0 0 * * *", nextRunAt: due },
    ];
    const { db } = fakeDb(rows, ["w-paused"]);
    const fired: string[] = [];
    const r = await runSchedulerTick(db, now, { fire: async (_db, s) => (fired.push(s.id), { fired: true }) as never });
    assert.deepEqual(fired, ["live-ws"]);
    assert.equal(r.fired, 1);
    assert.deepEqual(r.blocked, [{ scheduleId: "paused-ws", reason: "agents paused in this workspace" }]);
    assert.equal(rows[0]!.nextRunAt?.getTime(), due.getTime(), "still due: not advanced, not parked");
    assert.equal(rows[0]!.status, "active");
  });

  it("a leap-day schedule fires and advances to 2032 instead of throwing", async () => {
    const rows: Row[] = [
      { id: "leap", workspaceId: "w1", projectId: null, status: "active", triggerType: "cron", cronExpr: "0 0 29 2 *", nextRunAt: new Date("2028-02-29T00:00:00Z") },
    ];
    const { db } = fakeDb(rows);
    const r = await runSchedulerTick(db, now, { fire: async () => ({ fired: true }) as never });
    assert.equal(r.fired, 1);
    assert.equal(rows[0].nextRunAt?.toISOString(), "2032-02-29T00:00:00.000Z");
  });

  it("one bad schedule is parked + audited; the others still fire", async () => {
    const rows: Row[] = [
      { id: "bad-cron-1", workspaceId: "w1", projectId: null, status: "active", triggerType: "cron", cronExpr: "0 0 30 2 *", nextRunAt: new Date("2028-02-28T00:00:00Z") },
      { id: "throws-01", workspaceId: "w2", projectId: null, status: "active", triggerType: "cron", cronExpr: "* * * * *", nextRunAt: new Date("2028-02-29T00:00:00Z") },
      { id: "good-0001", workspaceId: "w3", projectId: null, status: "active", triggerType: "cron", cronExpr: "* * * * *", nextRunAt: new Date("2028-02-29T00:00:00Z") },
    ];
    const { db, audits } = fakeDb(rows);
    const fired: string[] = [];
    const r = await runSchedulerTick(db, now, {
      fire: (async (_db: unknown, s: { id: string }) => {
        if (s.id === "throws-01") throw new Error("provider exploded");
        fired.push(s.id);
        return { fired: true };
      }) as never,
    });
    assert.deepEqual(fired, ["good-0001"]);
    assert.equal(r.fired, 1);
    assert.deepEqual(r.blocked.map((b) => b.scheduleId).sort(), ["bad-cron-1", "throws-01"]);
    // Bad expression → paused (parked) with an audit row naming it.
    assert.equal(rows[0].status, "paused");
    const parked = audits.find((a) => a.action === "schedule_paused");
    assert.ok(parked && parked.workspaceId === "w1" && /parked/.test(parked.summary));
    // Fire failure after the claim → still active, already advanced, audited.
    assert.equal(rows[1].status, "active");
    assert.equal(rows[1].nextRunAt?.toISOString(), "2028-02-29T00:01:00.000Z");
    assert.ok(audits.some((a) => a.action === "scheduler_run_failed" && a.workspaceId === "w2"));
  });

  it("advances a schedule in its own timezone; a corrupt stored zone is parked", async () => {
    const t = new Date("2026-10-05T13:00:20Z"); // Mon 09:00 EDT
    const rows: Row[] = [
      { id: "ny-weekly", workspaceId: "w1", projectId: null, status: "active", triggerType: "cron", cronExpr: "0 9 * * 1", nextRunAt: new Date("2026-10-05T13:00:00Z"), timezone: "America/New_York" },
      { id: "bad-zone", workspaceId: "w2", projectId: null, status: "active", triggerType: "cron", cronExpr: "0 9 * * 1", nextRunAt: new Date("2026-10-05T13:00:00Z"), timezone: "Mars/Olympus" },
    ];
    const { db } = fakeDb(rows);
    const r = await runSchedulerTick(db, t, { fire: async () => ({ fired: true }) as never });
    assert.equal(r.fired, 1);
    assert.equal(rows[0].nextRunAt?.toISOString(), "2026-10-12T13:00:00.000Z", "next Monday 09:00 EDT");
    assert.equal(rows[1].status, "paused");
  });
});
