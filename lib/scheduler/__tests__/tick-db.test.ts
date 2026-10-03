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
import { nextOccurrence } from "@/lib/wfh/rituals";

const WS = "p2g-tick-ws";
const OTHER_WS = "p2g-tick-ws-2";
const NOW = new Date("2028-02-29T00:00:30Z");

async function createWorkspace(id: string) {
  await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at)
    VALUES (${id}, ${id}, ${"test:" + id}, now()) ON CONFLICT DO NOTHING`;
}

before(async () => {
  for (const id of [WS, OTHER_WS]) {
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
    await createWorkspace(id);
  }
});

after(async () => {
  for (const id of [WS, OTHER_WS]) await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${id}`;
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
});
