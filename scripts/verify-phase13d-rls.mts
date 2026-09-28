#!/usr/bin/env tsx
// Marketr — Phase 13D RLS battery (docs/phases/PHASE13D-VOICE-AGENTS-SPEC.md).
//
// Mirrors scripts/verify-phase13c-rls.mts for the five new voice tables:
//
//   Worker B (voiceovers) : voiceover_jobs, pronunciation_entries  ← this file's sections
//   Worker A (follow-up)  : voice_agents, call_scripts, call_sessions ← sibling appends
//
// Covers per table: FORCE RLS on, fail-closed (no GUC → zero rows),
// cross-workspace read isolation, write-to-another-workspace blocked,
// unscoped UPDATE is a no-op.
//
// Worker-B sections are marked [13D-B]; the sibling appends [13D-A] sections
// WITHOUT touching [13D-B] code.
//
// Usage: tsx scripts/verify-phase13d-rls.mts
// Exits 1 on any failure.

import "dotenv/config";
import { prisma } from "../lib/prisma";
import {
  withWorkspaceScope,
  countWithoutScope,
} from "../lib/substrate/memory/rls";

// ---------------------------------------------------------------------------
// harness (mirrors scripts/verify-phase13c-rls.mts)
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(title: string) {
  console.log(`\n## ${title}`);
}

const WS_A = "13d-battery-a";
const WS_B = "13d-battery-b";

// [13D-B] Worker B tables (voiceovers). Sibling: APPEND [13D-A] arrays.
const TABLES_B = ["voiceover_jobs", "pronunciation_entries"] as const;
// [13D-A] Worker A tables (follow-up)
const TABLES_A = ["voice_agents", "call_scripts", "call_sessions"] as const;
const ALL_TABLES: string[] = [...TABLES_B];
ALL_TABLES.push(...TABLES_A);

async function resetBatteryState() {
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({
      data: { id, name: `13d battery ${id}`, ownerUserId: "13d-battery-owner" },
    });
  }
}

// [13D-B] Seed Worker B tables in workspace A.
async function seedWorkspaceA_B() {
  await withWorkspaceScope(WS_A, async (tx) => {
    await tx.voiceoverJob.create({
      data: {
        workspaceId: WS_A,
        script: "Battery voiceover script.",
        voiceId: "alloy",
        voiceBackend: "voicestudio",
        status: "ready",
        progress: 1,
        audioRef: "battery/audio-key",
      },
    });
    await tx.pronunciationEntry.create({
      data: {
        workspaceId: WS_A,
        term: "Marketr",
        phonetic: "marketer",
        source: "knowledge_graph",
      },
    });
  });
}

// [13D-A] Seed Worker A tables in workspace A.
async function seedWorkspaceA_A() {
  await withWorkspaceScope(WS_A, async (tx) => {
    const pipeline = await tx.pipeline.create({
      data: {
        workspaceId: WS_A,
        name: "battery-a",
        stages: [{ id: "new", label: "New" }],
      },
      select: { id: true },
    });
    const agent = await tx.voiceAgent.create({
      data: {
        workspaceId: WS_A,
        name: "battery-a agent",
        purpose: "followup",
        voiceId: "battery-voice",
      },
      select: { id: true },
    });
    const script = await tx.callScript.create({
      data: {
        workspaceId: WS_A,
        agentId: agent.id,
        name: "battery-a script",
        body: { opening: "Hi, I'm an AI assistant calling on behalf of Battery A Co." },
        status: "approved",
      },
      select: { id: true },
    });
    const lead = await tx.lead.create({
      data: {
        workspaceId: WS_A,
        pipelineId: pipeline.id,
        name: "Battery A Lead",
        phone: "+15550109999",
        stage: "new",
      },
      select: { id: true },
    });
    await tx.callSession.create({
      data: {
        workspaceId: WS_A,
        agentId: agent.id,
        leadId: lead.id,
        scriptId: script.id,
        channel: "voice",
        consentProof: { status: "opted_in" },
        status: "rehearsal",
        auditTrail: [],
      },
    });
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  await resetBatteryState();
  await seedWorkspaceA_B();
  await seedWorkspaceA_A();

  section("1. FORCE RLS on all new Phase 13D tables");
  const rls = (await prisma.$queryRawUnsafe(
    `SELECT c.relname AS tablename, c.relrowsecurity AS rowsecurity,
            c.relforcerowsecurity AS force_rowsecurity
       FROM pg_class c
      WHERE c.relname = ANY($1)`,
    ALL_TABLES as unknown as string[],
  )) as Array<{ tablename: string; rowsecurity: boolean; force_rowsecurity: boolean }>;
  check(
    `FORCE RLS on all ${ALL_TABLES.length} tables`,
    rls.length === ALL_TABLES.length &&
      rls.every((r) => r.rowsecurity && r.force_rowsecurity),
    rls.map((r) => `${r.tablename}:${r.force_rowsecurity ? "forced" : "off"}`).join(" "),
  );
  const policies = (await prisma.$queryRawUnsafe(
    `SELECT tablename, policyname FROM pg_policies WHERE tablename = ANY($1)`,
    ALL_TABLES as unknown as string[],
  )) as Array<{ tablename: string; policyname: string }>;
  check(
    "tenant_isolation policy on all tables",
    policies.length === ALL_TABLES.length &&
      policies.every((p) => p.policyname === `${p.tablename}_tenant_isolation`),
    policies.map((p) => `${p.tablename}:${p.policyname}`).join(" "),
  );

  section("2. Fail-closed: no GUC → zero rows on every new table");
  for (const t of ALL_TABLES) {
    const n = await countWithoutScope(t);
    check(`no-GUC read on ${t} returns zero`, n === 0, `${n} rows`);
  }

  section("3. Cross-workspace read isolation");
  // [13D-B] Worker B counts. [13D-A] counts alongside.
  await withWorkspaceScope(WS_B, async (tx) => {
    const counts = {
      voiceoverJobs: await tx.voiceoverJob.count(),
      pronunciationEntries: await tx.pronunciationEntry.count(),
      voiceAgents: await tx.voiceAgent.count(),
      callScripts: await tx.callScript.count(),
      callSessions: await tx.callSession.count(),
    };
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    check("workspace B sees ZERO rows from workspace A", total === 0, JSON.stringify(counts));
  });
  await withWorkspaceScope(WS_A, async (tx) => {
    const counts = {
      voiceoverJobs: await tx.voiceoverJob.count(),
      pronunciationEntries: await tx.pronunciationEntry.count(),
      voiceAgents: await tx.voiceAgent.count(),
      callScripts: await tx.callScript.count(),
      callSessions: await tx.callSession.count(),
    };
    const ok =
      counts.voiceoverJobs === 1 &&
      counts.pronunciationEntries === 1 &&
      counts.voiceAgents === 1 &&
      counts.callScripts === 1 &&
      counts.callSessions === 1;
    check("workspace A sees its own rows", ok, JSON.stringify(counts));
  });

  section("4. Write to another workspace is blocked (WITH CHECK)");
  const crossWriteAttempts: Array<[string, () => Promise<unknown>]> = [
    // [13D-B]
    [
      "voiceover_jobs",
      () =>
        withWorkspaceScope(WS_A, (tx) =>
          tx.voiceoverJob.create({
            data: { workspaceId: WS_B, script: "x", voiceId: "alloy" },
          }),
        ),
    ],
    [
      "pronunciation_entries",
      () =>
        withWorkspaceScope(WS_A, (tx) =>
          tx.pronunciationEntry.create({
            data: { workspaceId: WS_B, term: "X", phonetic: "ex" },
          }),
        ),
    ],
    // [13D-A] Worker A cross-write attempts (appended; B's above untouched).
    [
      "voice_agents",
      () =>
        withWorkspaceScope(WS_A, (tx) =>
          tx.voiceAgent.create({
            data: { workspaceId: WS_B, name: "x", purpose: "followup", voiceId: "x" },
          }),
        ),
    ],
    [
      "call_scripts",
      () =>
        withWorkspaceScope(WS_A, async (tx) => {
          const agent = await tx.voiceAgent.findFirst({ select: { id: true } });
          return tx.callScript.create({
            data: { workspaceId: WS_B, agentId: agent!.id, name: "x", body: {} },
          });
        }),
    ],
    [
      "call_sessions",
      () =>
        withWorkspaceScope(WS_A, async (tx) => {
          const agent = await tx.voiceAgent.findFirst({ select: { id: true } });
          const lead = await tx.lead.findFirst({ select: { id: true } });
          return tx.callSession.create({
            data: {
              workspaceId: WS_B,
              agentId: agent!.id,
              leadId: lead!.id,
              channel: "voice",
              consentProof: {},
              auditTrail: [],
            },
          });
        }),
    ],
  ];
  for (const [label, attempt] of crossWriteAttempts) {
    let blocked = false;
    let detail = "";
    try {
      await attempt();
    } catch (e) {
      blocked = /row-level security/i.test((e as Error).message);
      detail = (e as Error).message.slice(0, 90);
    }
    check(`cross-workspace INSERT into ${label} blocked`, blocked, detail);
  }

  section("5. Unscoped UPDATE is a no-op (fail-closed on writes too)");
  const updated = (await prisma.$executeRawUnsafe(
    `UPDATE "voiceover_jobs" SET "status" = 'processing' WHERE "status" = 'ready'`,
  )) as unknown as number;
  check("unscoped UPDATE touches zero rows", updated === 0, `${updated} rows`);
  await withWorkspaceScope(WS_A, async (tx) => {
    const row = await tx.voiceoverJob.findFirst({ where: { status: "ready" } });
    check("row still intact after unscoped UPDATE attempt", row !== null);
  });

  // [13D-A] same guarantee for the follow-up tables.
  const updatedA = (await prisma.$executeRawUnsafe(
    `UPDATE "voice_agents" SET "name" = 'tampered'`,
  )) as unknown as number;
  check("unscoped UPDATE on voice_agents touches zero rows", updatedA === 0, `${updatedA} rows`);
  await withWorkspaceScope(WS_A, async (tx) => {
    const n = await tx.voiceAgent.count({ where: { name: "battery-a agent" } });
    check("battery-a agent intact after unscoped UPDATE", n === 1, `${n} rows`);
  });

  section("6. Defaults behave");
  await withWorkspaceScope(WS_A, async (tx) => {
    const job = await tx.voiceoverJob.create({
      data: { workspaceId: WS_A, script: "defaults check", voiceId: "nova" },
    });
    check(
      "voiceover job defaults (pending/0/voicestudio)",
      job.status === "pending" && job.progress === 0 && job.voiceBackend === "voicestudio",
      `${job.status}/${job.progress}/${job.voiceBackend}`,
    );
    await tx.voiceoverJob.delete({ where: { id: job.id } });
  });

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed` +
      (failed.length ? " — FAILURES ABOVE" : ""),
  );
  await prisma.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
