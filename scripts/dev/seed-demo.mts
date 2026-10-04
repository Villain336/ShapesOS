// ShapesOS — dev-only demo data for the agent home, sidebar and kit look.
//
// Seeds one workspace with agent work in every state, shaped exactly like
// what the orchestrator writes (lib/orchestrator/orchestrator.ts): missions
// with hash-chained route/exec events, pending mission approvals, AgentRuns
// (running / queued / failed / succeeded), scheduled skills with runs
// (succeeded / awaiting approval / failed), notifications, and a credit
// balance so the usage meter shows. The Overview then renders banners, the
// lead agent with sub-agents branching beneath it, live activity and work
// cards; the sidebar's "Running now" fills in.
//
//   SEED_EMAIL=e2e-admin@example.com \
//   DATABASE_URL=postgresql://<owner>@localhost:5432/<db> \
//   npx tsx scripts/dev/seed-demo.mts
//
// - Refuses to run with NODE_ENV=production.
// - The user is the credentials operator `admin:<SEED_EMAIL|ADMIN_EMAIL>`; the
//   workspace is theirs (created if missing, onboarding marked done).
// - Idempotent: every seeded row is tagged (createdBy/startedBy "seed-demo",
//   slugs "seed-demo-*", keys "seed-demo:*") and replaced on each run
//   (usage events are append-only, so those are written once and kept).
// - Runs as any role that can write the tables; every RLS table is written
//   inside a transaction with the tenant GUC set.

import type { Prisma } from "@prisma/client";

if (process.env.NODE_ENV === "production") {
  console.error("seed-demo: refusing to run with NODE_ENV=production (dev data only).");
  process.exit(1);
}

const email = (process.env.SEED_EMAIL ?? process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
if (!email) {
  console.error("seed-demo: set SEED_EMAIL (or ADMIN_EMAIL) to the operator account to seed for.");
  process.exit(1);
}
const userId = `admin:${email}`;
const TAG = "seed-demo";

const { prisma } = await import("@/lib/prisma");
const { getTemplate } = await import("@/lib/missions/templates");
const { canonicalize, sha256Hex, eventHashFor, bindingHashOf } = await import("@/lib/authority/approvals");

type Tx = Prisma.TransactionClient;
type Json = Prisma.InputJsonValue;

const now = new Date();
const minAgo = (m: number) => new Date(now.getTime() - m * 60_000);

// ── workspace ──────────────────────────────────────────────────────────────
let ws = await prisma.workspace.findFirst({ where: { ownerUserId: userId }, orderBy: { createdAt: "asc" } });
if (!ws) {
  const { createWorkspaceForUser } = await import("@/lib/workspace/lifecycle");
  ws = await createWorkspaceForUser({ userId, name: "Personal workspace", ifNoneExists: true });
  console.log("created workspace", ws.id);
}
const workspaceId = ws.id;
await prisma.workspace.update({
  where: { id: workspaceId },
  data: { onboardingCompletedAt: ws.onboardingCompletedAt ?? now },
});
console.log(`seeding workspace ${ws.name} (${workspaceId}) for ${userId}`);

async function scoped<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return fn(tx);
    },
    { timeout: 60_000 },
  );
}

// ── clear the previous seed ────────────────────────────────────────────────
await scoped(async (tx) => {
  await tx.missionApproval.deleteMany({ where: { workspaceId, createdBy: TAG } });
  await tx.agentRun.deleteMany({ where: { workspaceId, startedBy: TAG } });
  await tx.mission.deleteMany({ where: { workspaceId, createdBy: TAG } });
});
await prisma.skill.deleteMany({ where: { workspaceId, slug: { startsWith: `${TAG}-` } } });
await prisma.notification.deleteMany({ where: { workspaceId, dedupKey: { startsWith: `${TAG}:` } } });
// usage_events is append-only (THREAT-MODEL-METERING T5): seeded once, kept.

// ── missions, written the way the orchestrator writes them ─────────────────
const template = getTemplate("home-services.booked-job-growth");
const plan = template.plan.map((s) => ({ ...s }));

type Ev = { min: number; actor: string; step: string; tool?: string; args?: Record<string, unknown>; observation?: Record<string, unknown> };
let hop = 0;
const route = (agent: string, label: string, min: number): Ev => {
  hop += 1;
  return {
    min,
    actor: "chief-strategy-agent",
    step: `route.${hop}`,
    tool: agent,
    args: { taskKind: agent, taskLabel: label, nextAgent: agent, routingReason: `routing-table: task kind "${agent}" -> ${agent}` },
  };
};
const exec = (agent: string, summary: string, min: number, costCents = 12): Ev => ({
  min,
  actor: agent,
  step: `exec.${hop}`,
  tool: agent,
  observation: { summary, costCents },
});
const execError = (agent: string, error: string, min: number): Ev => ({
  min,
  actor: agent,
  step: `exec.${hop}.error`,
  tool: agent,
  observation: { error, consecutiveFailures: 1 },
});

async function seedMission(opts: {
  name: string;
  status: "planned" | "active" | "paused" | "complete";
  startedMin: number;
  events: Ev[];
}): Promise<string> {
  return scoped(async (tx) => {
    const m = await tx.mission.create({
      data: {
        workspaceId,
        template: template.id,
        goal: { metric: "booked_jobs", targetValue: 40, unit: "jobs", timeframeDays: 90, direction: "increase", baseline: null, label: opts.name },
        status: opts.status,
        planSnapshot: { templateId: template.id, steps: plan } as unknown as Json,
        checkpoints: [],
        budgetCaps: { maxCostCents: template.budgetDefaults.maxCostCents },
        termination: { maxSteps: template.budgetDefaults.maxSteps, deadlineAt: new Date(now.getTime() + 90 * 86_400_000).toISOString() },
        createdBy: TAG,
        createdAt: minAgo(opts.startedMin),
      },
    });
    let prevHash = "GENESIS";
    const all: Ev[] = [
      { min: opts.startedMin, actor: "mission-engine", step: "mission.genesis", observation: { templateId: template.id } },
      ...(opts.status === "planned" ? [] : [{ min: opts.startedMin - 0.1, actor: "mission-engine", step: "mission.activated", observation: { planSteps: plan.length } }]),
      ...opts.events,
    ];
    for (const e of all) {
      const ts = minAgo(e.min);
      const args = (e.args ?? {}) as Json;
      const observation = (e.observation ?? {}) as Json;
      const payloadHash = sha256Hex(canonicalize({ step: e.step, tool: e.tool ?? null, args, observation, costCents: 0 }));
      const eventHash = eventHashFor(prevHash, m.id, e.actor, payloadHash, ts);
      await tx.missionEvent.create({
        data: { missionId: m.id, workspaceId, ts, actor: e.actor, step: e.step, tool: e.tool ?? null, args, observation, costCents: 0, eventHash, prevHash },
      });
      prevHash = eventHash;
    }
    return m.id;
  });
}

async function seedRun(kind: "mission" | "playbook" | "browser" | "follow_up", status: "queued" | "running" | "succeeded" | "failed", startedMin: number, missionId: string | null, events: string[] = []) {
  await scoped(async (tx) => {
    const run = await tx.agentRun.create({
      data: {
        workspaceId,
        kind,
        status,
        startedBy: TAG,
        missionId,
        createdAt: minAgo(startedMin),
        endedAt: status === "succeeded" || status === "failed" ? minAgo(Math.max(0, startedMin - 3)) : null,
        nextSeq: events.length,
      },
    });
    for (const [seq, summary] of events.entries()) {
      await tx.agentRunEvent.create({
        data: { workspaceId, runId: run.id, seq, type: "note", summary, createdAt: minAgo(startedMin - seq) },
      });
    }
  });
}

async function seedApproval(missionId: string, action: string, binding: Record<string, unknown>) {
  await scoped((tx) =>
    tx.missionApproval.create({
      data: {
        missionId,
        workspaceId,
        action,
        tier: 2,
        bindingJson: binding as Json,
        bindingHash: bindingHashOf(binding),
        status: "pending",
        expiresAt: new Date(now.getTime() + 3 * 86_400_000),
        createdBy: TAG,
      },
    }),
  );
}

// 1. Running: the lead has the Researcher reading sources.
hop = 0;
const brief = await seedMission({
  name: "Weekly competitor brief",
  status: "active",
  startedMin: 34,
  events: [
    route("planner", "Plan the work", 33),
    exec("planner", "Split the task into 5 steps.", 32),
    route("researcher", "Search the web", 31),
    exec("researcher", "Found 18 results and kept 12.", 30),
    route("researcher", "Reading 12 sources", 29),
  ],
});
await seedRun("mission", "running", 33, brief, ["Planned the work", "Searched the web: 18 results, 12 kept", "Reading sources (7 of 12)"]);

// 2. Needs you: the Writer drafted renewal emails; approvals pending.
hop = 0;
const renewals = await seedMission({
  name: "October renewal emails",
  status: "active",
  startedMin: 80,
  events: [
    route("analyst", "Find accounts renewing in October", 79),
    exec("analyst", "Found 14 accounts renewing in October.", 75),
    route("drafter", "Draft 14 renewal reminders", 74),
  ],
});
await seedApproval(renewals, "send_renewal_emails", { channel: "email", recipients: 14, template: "renewal-reminder" });
await seedApproval(renewals, "publish_offer_post", { channel: "social", posts: 1 });

// 3. Failed: the Operator lost calendar access.
hop = 0;
const sync = await seedMission({
  name: "Calendar and reminders sync",
  status: "active",
  startedMin: 50,
  events: [
    route("scheduler", "Line up this week's reminders", 49),
    exec("scheduler", "Lined up 6 reminders.", 48),
    route("actor", "Sync calendar", 12),
    execError("actor", "Calendar access expired. The Google token was revoked on Sep 30.", 11),
  ],
});
await seedRun("mission", "failed", 12, sync, ["Sync calendar", "Calendar access expired"]);

// 4. Done (recent): the Analyst finished the Q3 summary.
hop = 0;
await seedMission({
  name: "Q3 performance summary",
  status: "complete",
  startedMin: 120,
  events: [route("analyst", "Summarize Q3", 119), exec("analyst", "Finished the Q3 summary.", 100)],
});

// 5. Queued: planned, nothing delegated yet.
hop = 0;
await seedMission({ name: "Review-velocity drive", status: "planned", startedMin: 5, events: [] });

// 6. Paused by the human.
hop = 0;
await seedMission({
  name: "Slow-season offer",
  status: "paused",
  startedMin: 300,
  events: [route("planner", "Draft 90-day plan", 299), exec("planner", "Drafted a dated plan.", 290), route("drafter", "Draft seasonal offer", 289)],
});

// Standalone runs the lead requested (no mission).
await seedRun("browser", "running", 4, null, ["Opened the vendor pricing page"]);
await seedRun("follow_up", "queued", 1, null);
await seedRun("playbook", "succeeded", 200, null, ["Ran the review-reply playbook"]);

// ── scheduled skills ───────────────────────────────────────────────────────
async function seedSchedule(o: {
  slug: string;
  name: string;
  description: string;
  tools: string[];
  cron: string;
  run: { status: "succeeded" | "awaiting_approval" | "failed" | "running"; min: number; error?: string; credits?: number };
}) {
  const skill = await prisma.skill.create({
    data: {
      workspaceId,
      name: o.name,
      slug: `${TAG}-${o.slug}`,
      description: o.description,
      source: "registry",
      skillMd: `# ${o.name}\n\n${o.description}\n`,
      declaredTools: o.tools,
      trustTier: "built_in",
      installedBy: TAG,
    },
  });
  const schedule = await prisma.scheduledSkill.create({
    data: {
      workspaceId,
      skillId: skill.id,
      triggerType: "cron",
      cronExpr: o.cron,
      createdBy: userId,
      approvalMode: o.run.status === "awaiting_approval" ? "supervised" : "scheduled",
      lastRunAt: minAgo(o.run.min),
      nextRunAt: new Date(now.getTime() + 86_400_000),
    },
  });
  await prisma.skillRun.create({
    data: {
      scheduleId: schedule.id,
      workspaceId,
      skillId: skill.id,
      trigger: "cron",
      status: o.run.status,
      startedAt: minAgo(o.run.min),
      finishedAt: o.run.status === "succeeded" || o.run.status === "failed" ? minAgo(o.run.min - 2) : null,
      creditsUsed: o.run.credits ?? 0,
      error: o.run.error ?? null,
    },
  });
}

await seedSchedule({
  slug: "weekly-seo-report",
  name: "Weekly SEO report",
  description: "Pulls rankings and traffic every Monday and writes the summary for your team.",
  tools: ["web-search.query", "files.write"],
  cron: "0 9 * * 1",
  run: { status: "succeeded", min: 140, credits: 40 },
});
await seedSchedule({
  slug: "review-replies",
  name: "Review replies",
  description: "Drafts replies to new reviews and asks before posting them.",
  tools: ["email.send"],
  cron: "0 */4 * * *",
  run: { status: "awaiting_approval", min: 20, credits: 6 },
});

// ── notifications ──────────────────────────────────────────────────────────
const notes: Array<{ kind: "approval_needed" | "run_failed" | "alert_fired"; title: string; body: string; href: string; min: number }> = [
  { kind: "approval_needed", title: "Writer wants to send 14 emails", body: "Drafts are ready. Nothing sends until you approve.", href: "/dashboard/approvals", min: 70 },
  { kind: "run_failed", title: "Operator couldn't sync your calendar", body: "Calendar access expired. Reconnect to resume.", href: "/dashboard/runs", min: 11 },
  { kind: "alert_fired", title: "Brief published", body: "Weekly competitor brief is in Files.", href: "/dashboard/files", min: 90 },
];
for (const [i, n] of notes.entries()) {
  await prisma.notification.create({
    data: { workspaceId, userId, kind: n.kind, title: n.title, body: n.body, href: n.href, dedupKey: `${TAG}:${i}`, createdAt: minAgo(n.min) },
  });
}

// ── usage meter: a credit pool with 62% used this period ───────────────────
const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
const included = 1000;
const used = 620;
await prisma.creditBalance.upsert({
  where: { workspaceId },
  create: { workspaceId, includedCredits: included, usedCredits: used, periodStart },
  update: { includedCredits: included, usedCredits: used, periodStart },
});
await prisma.spendCap.upsert({
  where: { workspaceId },
  create: { workspaceId, capCredits: included },
  update: { capCredits: included },
});
const actions = [
  ["agent.run", 380],
  ["web.search", 140],
  ["llm.draft", 100],
] as const;
for (const [action, credits] of actions) {
  // Fixed idempotency keys: the ledger is append-only, so a re-run is a no-op.
  await prisma.usageEvent.createMany({
    data: [{ workspaceId, action, credits, idempotencyKey: `${TAG}:${workspaceId}:${action}`, evidenceRef: TAG }],
    skipDuplicates: true,
  });
}

console.log("seed-demo: done — missions in every state, runs, schedules, approvals, notifications and usage.");
await prisma.$disconnect();
