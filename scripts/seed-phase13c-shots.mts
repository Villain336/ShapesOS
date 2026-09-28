// Marketr — Phase 13C screenshot seed/cleanup.
// Usage: npx tsx scripts/seed-phase13c-shots.mts [--clean]
// Seeds one source, four clips (varied states), one finished job for the
// admin's workspace, marked with the SEED-13C prefix. --clean removes them.
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { withWorkspaceScope } from "../lib/substrate/memory/rls";

const stripQuotes = (v: string) =>
  v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === '"' || v[0] === "'")
    ? v.slice(1, -1)
    : v;

const env = Object.fromEntries(
  fs
    .readFileSync("/home/hatch/workspace/marketr/.env", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), stripQuotes(l.slice(i + 1).trim())];
    }),
);
const ADMIN_EMAIL = env.ADMIN_EMAIL;
if (!ADMIN_EMAIL) throw new Error("missing ADMIN_EMAIL in .env");

const prisma = new PrismaClient();
const TAG = "SEED-13C";

async function main() {
  const userId = `admin:${ADMIN_EMAIL}`;
  let ws = await prisma.workspace.findFirst({
    where: {
      OR: [{ ownerUserId: userId }, { members: { some: { userId } } }],
    },
    orderBy: { createdAt: "desc" },
  });
  if (!ws) {
    ws = await prisma.workspace.create({
      data: {
        name: `${ADMIN_EMAIL}'s workspace`,
        ownerUserId: userId,
        plan: "self_hosted",
        members: { create: { userId, role: "owner" } },
      },
    });
    console.log("created workspace", ws.id);
  }

  if (process.argv.includes("--clean")) {
    // RLS is enforced per-workspace; seed rows are workspace-scoped so a
    // plain workspaceId filter is exact and safe. Deletes run inside the
    // workspace scope or RLS blocks them (fail-closed).
    await withWorkspaceScope(ws.id, async (tx) => {
      const jobs = await tx.clipJob.deleteMany({
        where: { workspaceId: ws.id, error: { contains: TAG } },
      });
      const clips = await tx.clip.deleteMany({
        where: { workspaceId: ws.id, source: { title: { contains: TAG } } },
      });
      const sources = await tx.clipSource.deleteMany({
        where: { workspaceId: ws.id, title: { contains: TAG } },
      });
      console.log(`cleaned: ${sources.count} sources, ${clips.count} clips, ${jobs.count} jobs`);
    });
    return;
  }

  const seeded = await withWorkspaceScope(ws.id, async (tx) => {
    const source = await tx.clipSource.create({
    data: {
      workspaceId: ws.id,
      origin: "url",
      sourceUrl: "https://example.com/founder-keynote.mp4",
      title: `${TAG} Founder keynote — Sept 2026`,
      durationSec: 1800,
      transcriptStatus: "ready",
      transcript: {
        words: [
          { w: "The", start: 12, end: 12.3 },
          { w: "moment", start: 12.4, end: 12.8 },
          { w: "everything", start: 12.9, end: 13.4 },
          { w: "changed.", start: 13.5, end: 14.1 },
        ],
        text: "The moment everything changed.",
      },
    },
  });

  const clipRows = [
    {
      startSec: 12, endSec: 48, viralityScore: 92,
      hookText: "The moment everything changed for our launch.",
      status: "draft", renderStatus: "pending",
      scoreReasons: [{ label: "Hook strength", detail: "Opens with a payoff line", weight: 0.3 }],
    },
    {
      startSec: 120, endSec: 165, viralityScore: 84,
      hookText: "Nobody tells founders this about pricing.",
      status: "draft", renderStatus: "pending",
      scoreReasons: [{ label: "Contrarian take", detail: "Challenges a common belief", weight: 0.25 }],
    },
    {
      startSec: 300, endSec: 340, viralityScore: 78,
      hookText: "The one metric that actually matters.",
      status: "approved", renderStatus: "ready",
      outputRef: "/renders/seed-clip-3.mp4",
      scoreReasons: [{ label: "Specificity", detail: "Names one concrete metric", weight: 0.2 }],
    },
    {
      startSec: 500, endSec: 545, viralityScore: 71,
      hookText: "What I would do differently next time.",
      status: "queued", renderStatus: "ready",
      outputRef: "/renders/seed-clip-4.mp4",
      postizRef: "draft_postiz_seed123",
      scoreReasons: [{ label: "Story arc", detail: "Reflection with a lesson", weight: 0.2 }],
    },
  ];
  for (const c of clipRows) {
    await tx.clip.create({
      data: {
        workspaceId: ws.id,
        sourceId: source.id,
        startSec: c.startSec,
        endSec: c.endSec,
        viralityScore: c.viralityScore,
        scoreReasons: c.scoreReasons,
        hookText: c.hookText,
        captionStyle: { font: "Inter", color: "#FFFFFF", highlightColor: "#7c3aed", position: "bottom", wordHighlight: true },
        status: c.status,
        renderStatus: c.renderStatus,
        outputRef: (c as { outputRef?: string }).outputRef ?? null,
        postizRef: (c as { postizRef?: string }).postizRef ?? null,
      },
    });
  }

  await tx.clipJob.create({
    data: {
      workspaceId: ws.id,
      kind: "generate",
      status: "done",
      progress: 1,
      sourceId: source.id,
      error: `${TAG} seed marker`,
    },
  });

    console.log(`seeded source ${source.id} + 4 clips + 1 job in workspace ${ws.id}`);
    return source.id;
  });

  console.log(`seed complete: ${seeded}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
