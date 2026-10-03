// ShapesOS — scheduler tick against a real migrated database: one bad
// schedule is parked + audited while the rest still fire, and a leap-day
// schedule advances to the next leap year (FULL-AUDIT §5 "Leap-day cron
// halts the scheduler"). Also checks the Phase 2 timezone columns.
// Run: DATABASE_URL=… npx tsx --test lib/scheduler/__tests__/tick-db.test.ts

import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { runSchedulerTick } from "../tick";
import { createSchedule, updateSchedule, ScheduleServiceError } from "../service";
import { nextOccurrence } from "@/lib/wfh/rituals";

const WS = "p2g-tick-ws";
const OTHER_WS = "p2g-tick-ws-2";
const TZ_WS = "p4fix-tick-tz-ws";
const NOW = new Date("2028-02-29T00:00:30Z");

async function createWorkspace(id: string) {
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at)
    VALUES (${id}, ${id}, ${"test:" + id}, now()) ON CONFLICT DO NOTHING`;
}

before(async () => {
  for (const id of [WS, OTHER_WS, TZ_WS]) {
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
    await createWorkspace(id);
  }
});

after(async () => {
  for (const id of [WS, OTHER_WS, TZ_WS]) await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
  await prisma.$disconnect();
});

async function skillFor(workspaceId: string) {
  return prisma.skill.create({
    data: {
      workspaceId,
      name: "Tick test",
      slug: `tick-test-${workspaceId}`,
      description: "scheduler tick DB test",
      source: "upload",
      skillMd: "# test",
      declaredTools: [],
      trustTier: "built_in",
    },
  });
}

async function schedule(workspaceId: string, skillId: string, cronExpr: string, nextRunAt: Date) {
  return prisma.scheduledSkill.create({
    data: {
      workspaceId,
      skillId,
      triggerType: "cron",
      cronExpr,
      createdBy: "test",
      approvalMode: "supervised",
      nextRunAt,
    },
  });
}

describe("runSchedulerTick (database)", () => {
  it("parks + audits a bad schedule, fires the others, advances leap-day to 2032", async () => {
    const skillA = await skillFor(WS);
    const skillB = await skillFor(OTHER_WS);
    const bad = await schedule(WS, skillA.id, "0 0 30 2 *", new Date("2028-02-28T00:00:00Z"));
    const leap = await schedule(WS, skillA.id, "0 0 29 2 *", new Date("2028-02-29T00:00:00Z"));
    const good = await schedule(OTHER_WS, skillB.id, "*/5 * * * *", new Date("2028-02-29T00:00:00Z"));

    const fired: string[] = [];
    const result = await runSchedulerTick(prisma, NOW, {
      fire: (async (_db: unknown, s: { id: string }) => {
        fired.push(s.id);
        return { fired: true };
      }) as never,
    });

    assert.deepEqual(fired.sort(), [leap.id, good.id].sort());
    assert.ok(result.fired >= 2);
    assert.ok(result.blocked.some((b) => b.scheduleId === bad.id));

    const rows = await prisma.scheduledSkill.findMany({
      where: { id: { in: [bad.id, leap.id, good.id] } },
      select: { id: true, status: true, nextRunAt: true },
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId[bad.id].status, "paused");
    assert.equal(byId[leap.id].status, "active");
    assert.equal(byId[leap.id].nextRunAt?.toISOString(), "2032-02-29T00:00:00.000Z");
    assert.equal(byId[good.id].nextRunAt?.toISOString(), "2028-02-29T00:05:00.000Z");

    const audit = await prisma.fileChangeLog.findMany({
      where: { workspaceId: WS, action: "schedule_paused" },
      select: { summary: true },
    });
    assert.equal(audit.length, 1);
    assert.match(audit[0].summary, /parked by the scheduler/);
  });

  it("timezone columns default to UTC and round-trip an IANA zone", async () => {
    const mode = await prisma.wfhWorkMode.create({ data: { workspaceId: WS, userId: "u-tz" } });
    assert.equal(mode.timezone, "UTC");
    const updated = await prisma.wfhWorkMode.update({ where: { id: mode.id }, data: { timezone: "America/New_York" } });
    assert.equal(updated.timezone, "America/New_York");

    const ritual = await prisma.wfhRitual.create({
      data: {
        workspaceId: WS,
        createdBy: "u-tz",
        type: "wins",
        title: "Wins",
        description: "d",
        cadence: "weekly",
        anchorDate: new Date("2026-10-26T13:00:00Z"), // Mon 09:00 EDT
        timezone: "America/New_York",
      },
    });
    const next = nextOccurrence(ritual.anchorDate, "weekly", new Date("2026-11-01T12:00:00Z"), ritual.timezone);
    assert.equal(next.toISOString(), "2026-11-02T14:00:00.000Z"); // still 09:00 local (EST)

    const [{ tz }] = await prisma.$queryRaw<{ tz: string }[]>`
      SELECT column_default AS tz FROM information_schema.columns
      WHERE table_name = 'workflows' AND column_name = 'timezone'`;
    assert.match(tz, /'UTC'/);
  });

  // Phase 4a follow-up: scheduled skills used to run on UTC wall time only.
  it("a schedule's IANA timezone is validated, stored, and drives nextRunAt (create, update, tick)", async () => {
    const skill = await skillFor(TZ_WS);
    const base = { workspaceId: TZ_WS, skillId: skill.id, triggerType: "cron" as const, createdBy: "test" };
    const from = new Date("2026-10-03T00:00:00Z");

    const legacy = await createSchedule(prisma, { ...base, cronExpr: "0 9 * * 1" }, from);
    assert.equal(legacy.timezone, "UTC", "default stays UTC");
    assert.equal(legacy.nextRunAt?.toISOString(), "2026-10-05T09:00:00.000Z");

    const ny = await createSchedule(prisma, { ...base, cronExpr: "0 9 * * 1", timezone: "America/New_York" }, from);
    assert.equal(ny.timezone, "America/New_York");
    assert.equal(ny.nextRunAt?.toISOString(), "2026-10-05T13:00:00.000Z", "Mon 09:00 EDT");

    await assert.rejects(
      createSchedule(prisma, { ...base, cronExpr: "0 9 * * 1", timezone: "Mars/Olympus" }, from),
      (e: unknown) => e instanceof ScheduleServiceError && /unknown timezone/.test(e.message),
    );

    // Changing only the zone recomputes nextRunAt from the stored cron.
    const moved = await updateSchedule(prisma, ny.id, TZ_WS, { timezone: "Asia/Tokyo" }, "test", from);
    assert.equal(moved.timezone, "Asia/Tokyo");
    assert.equal(moved.nextRunAt?.toISOString(), "2026-10-05T00:00:00.000Z", "Mon 09:00 JST");
    await assert.rejects(updateSchedule(prisma, ny.id, TZ_WS, { timezone: "nope" }, "test", from), ScheduleServiceError);

    // The tick advances in the schedule's zone: across New York's fall-back,
    // a 09:00 local daily schedule moves from 13:00Z to 14:00Z.
    const daily = await createSchedule(prisma, { ...base, cronExpr: "0 9 * * *", timezone: "America/New_York", approvalMode: "supervised" }, new Date("2026-10-31T12:00:00Z"));
    assert.equal(daily.nextRunAt?.toISOString(), "2026-10-31T13:00:00.000Z");
    await runSchedulerTick(prisma, new Date("2026-10-31T13:00:20Z"), {
      workspaceId: TZ_WS,
      fire: (async () => ({ fired: true })) as never,
    });
    const after = await prisma.scheduledSkill.findUniqueOrThrow({ where: { id: daily.id } });
    assert.equal(after.nextRunAt?.toISOString(), "2026-11-01T14:00:00.000Z", "still 09:00 local (EST)");
  });
});
