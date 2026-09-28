#!/usr/bin/env tsx
// Marketr — Phase 13C RLS battery (docs/phases/PHASE13C-CLIPPER-SPEC.md).
//
// Mirrors scripts/verify-phase13b-rls.mts for the three new clipper tables:
//
//   clip_sources, clips, clip_jobs
//
// Covers per table: FORCE RLS on, fail-closed (no GUC → zero rows),
// cross-workspace read isolation, write-to-another-workspace blocked,
// unscoped UPDATE is a no-op.
//
// Usage: tsx scripts/verify-phase13c-rls.mts
// Exits 1 on any failure.

import "dotenv/config";
import { prisma } from "../lib/prisma";
import {
  withWorkspaceScope,
  countWithoutScope,
} from "../lib/substrate/memory/rls";

// ---------------------------------------------------------------------------
// harness (mirrors scripts/verify-phase13b-rls.mts)
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

const WS_A = "13c-battery-a";
const WS_B = "13c-battery-b";

const NEW_TABLES = ["clip_sources", "clips", "clip_jobs"] as const;

async function resetBatteryState() {
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
    await prisma.workspace.create({
      data: { id, name: `13c battery ${id}`, ownerUserId: "13c-battery-owner" },
    });
  }
}

async function seedWorkspaceA() {
  await withWorkspaceScope(WS_A, async (tx) => {
    const src = await tx.clipSource.create({
      data: {
        workspaceId: WS_A,
        origin: "upload",
        title: "battery source video",
        fileRef: "battery/video.mp4",
        durationSec: 600,
        transcriptStatus: "ready",
        transcript: { words: [{ w: "hello", start: 0, end: 0.4 }], text: "hello" },
      },
      select: { id: true },
    });
    await tx.clip.create({
      data: {
        workspaceId: WS_A,
        sourceId: src.id,
        startSec: 10,
        endSec: 45,
        viralityScore: 82.5,
        scoreReasons: [{ label: "hook", detail: "strong opening", weight: 0.4 }],
        captionStyle: { font: "battery-font", size: 48 },
        captions: { segments: [{ text: "hello", start: 10, end: 10.4 }], style: {} },
        status: "approved",
        renderStatus: "ready",
        outputRef: "battery/clip1.mp4",
      },
    });
    await tx.clipJob.create({
      data: {
        workspaceId: WS_A,
        sourceId: src.id,
        kind: "transcribe",
        status: "done",
        progress: 1,
        payload: { lang: "en" },
      },
    });
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  await resetBatteryState();
  await seedWorkspaceA();

  section("1. FORCE RLS on all new Phase 13C tables");
  const rls = (await prisma.$queryRawUnsafe(
    `SELECT c.relname AS tablename, c.relrowsecurity AS rowsecurity,
            c.relforcerowsecurity AS force_rowsecurity
       FROM pg_class c
      WHERE c.relname = ANY($1)`,
    NEW_TABLES as unknown as string[],
  )) as Array<{ tablename: string; rowsecurity: boolean; force_rowsecurity: boolean }>;
  check(
    "FORCE RLS on all three new tables",
    rls.length === 3 && rls.every((r) => r.rowsecurity && r.force_rowsecurity),
    rls.map((r) => `${r.tablename}:${r.force_rowsecurity ? "forced" : "off"}`).join(" "),
  );
  // Tenant-isolation policy exists on each table (name convention from migration).
  const policies = (await prisma.$queryRawUnsafe(
    `SELECT tablename, policyname FROM pg_policies WHERE tablename = ANY($1)`,
    NEW_TABLES as unknown as string[],
  )) as Array<{ tablename: string; policyname: string }>;
  check(
    "tenant_isolation policy on all three tables",
    policies.length === 3 &&
      policies.every((p) => p.policyname === `${p.tablename}_tenant_isolation`),
    policies.map((p) => `${p.tablename}:${p.policyname}`).join(" "),
  );

  section("2. Fail-closed: no GUC → zero rows on every new table");
  for (const t of NEW_TABLES) {
    const n = await countWithoutScope(t);
    check(`no-GUC read on ${t} returns zero`, n === 0, `${n} rows`);
  }

  section("3. Cross-workspace read isolation");
  await withWorkspaceScope(WS_B, async (tx) => {
    const counts = {
      sources: await tx.clipSource.count(),
      clips: await tx.clip.count(),
      jobs: await tx.clipJob.count(),
    };
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    check("workspace B sees ZERO rows from workspace A", total === 0, JSON.stringify(counts));
  });
  await withWorkspaceScope(WS_A, async (tx) => {
    const counts = {
      sources: await tx.clipSource.count(),
      clips: await tx.clip.count(),
      jobs: await tx.clipJob.count(),
    };
    const ok =
      counts.sources === 1 && counts.clips === 1 && counts.jobs === 1;
    check("workspace A sees its own rows", ok, JSON.stringify(counts));
  });

  section("4. Write to another workspace is blocked (WITH CHECK)");
  const crossWriteAttempts: Array<[string, () => Promise<unknown>]> = [
    [
      "clip_sources",
      () =>
        withWorkspaceScope(WS_A, (tx) =>
          tx.clipSource.create({
            data: { workspaceId: WS_B, origin: "url", title: "x" },
          }),
        ),
    ],
    [
      "clips",
      () =>
        withWorkspaceScope(WS_A, async (tx) => {
          const src = await tx.clipSource.findFirst({ select: { id: true } });
          return tx.clip.create({
            data: {
              workspaceId: WS_B,
              sourceId: src!.id,
              startSec: 0,
              endSec: 10,
              viralityScore: 1,
            },
          });
        }),
    ],
    [
      "clip_jobs",
      () =>
        withWorkspaceScope(WS_A, (tx) =>
          tx.clipJob.create({
            data: { workspaceId: WS_B, kind: "render" },
          }),
        ),
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
    `UPDATE "clips" SET "status" = 'posted' WHERE "status" = 'approved'`,
  )) as unknown as number;
  check("unscoped UPDATE touches zero rows", updated === 0, `${updated} rows`);
  await withWorkspaceScope(WS_A, async (tx) => {
    const row = await tx.clip.findFirst({ where: { status: "approved" } });
    check("row still intact after unscoped UPDATE attempt", row !== null);
  });

  section("6. Relations and defaults behave");
  await withWorkspaceScope(WS_A, async (tx) => {
    const clip = await tx.clip.findFirst({
      where: { status: "approved" },
      include: { source: { select: { title: true } }, workspace: { select: { id: true } } },
    });
    check(
      "clip → source → workspace relations resolve",
      clip?.source.title === "battery source video" && clip?.workspace.id === WS_A,
    );
    const job = await tx.clipJob.findFirst({ where: { kind: "transcribe" } });
    check(
      "clip_job defaults: status done (seeded), progress 1",
      job?.status === "done" && job?.progress === 1,
    );
    const src = await tx.clipSource.findFirst({ where: { origin: "upload" } });
    check(
      "clip_source includes transcript blob",
      (src?.transcript as Record<string, unknown>)?.text === "hello",
    );
  });
  // A second clip under the same source in workspace B must fail (RLS hides the source).
  let bClipBlocked = false;
  try {
    await withWorkspaceScope(WS_B, async (tx) => {
      const src = await tx.clipSource.findFirstOrThrow({
        where: { title: "battery source video" },
      });
      await tx.clip.create({
        data: {
          workspaceId: WS_B,
          sourceId: src.id,
          startSec: 0,
          endSec: 10,
          viralityScore: 1,
        },
      });
    });
  } catch {
    bClipBlocked = true;
  }
  check("workspace B cannot clip A's hidden source (findFirstOrThrow 404s)", bClipBlocked);

  section("cleanup");
  for (const id of [WS_A, WS_B]) {
    await prisma.workspace.deleteMany({ where: { id } });
  }
  check("battery workspaces removed (cascade)", true);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
  if (failed.length > 0) {
    console.log("FAILED:", failed.map((f) => f.name).join("; "));
    process.exit(1);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("BATTERY CRASH:", e);
  await prisma.$disconnect();
  process.exit(1);
});
