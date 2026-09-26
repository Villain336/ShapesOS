// Marketr — Phase 10 M2: demo seed for the M7 radar backtest.
//
// Seeds the August 2026 Spam Update window (began 2026-08-18T16:27Z, ended
// 2026-08-21T08:49Z — the real incident from status.search.google.com) as a
// platform_event, plus synthetic page_impact rows for a demo project, so the
// M7 verification battery can exercise the radar's backtest without live GSC.
//
// Run:  npx tsx scripts/seed-phase10-radar.mts   (from ~/workspace/marketr)
// Idempotent: skips when the seeded event already exists. Demo rows are
// clearly synthetic (project domain "demo.example.com", pages under it).
// Existing records untouched. FORCE RLS: runs inside one scoped transaction
// with the tenant GUC pinned.

import fs from "node:fs";

const envFile = fs.readFileSync(".env", "utf8");
const adminEmail = (envFile.match(/^ADMIN_EMAIL=(.*)$/m)?.[1] ?? "")
  .replace(/^"|"$/g, "")
  .trim()
  .toLowerCase();
if (!adminEmail) throw new Error("ADMIN_EMAIL missing in .env");
const userId = `admin:${adminEmail}`;

const { prisma } = await import("@/lib/prisma");
const { classifyEventHeuristicOnly } = await import("@/lib/intelligence/radar/classifier");

const wsRow = await prisma.workspace.findFirst({ where: { ownerUserId: userId } });
if (!wsRow) throw new Error("admin workspace not found — run an earlier phase seed first");
const ws = wsRow.id;
console.log("workspace", ws);

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

await prisma.$transaction(async (tx: Tx) => {
  await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ws}, true)`;

  const existing = await tx.platformEvent.findFirst({
    where: { source: "status_dashboard", title: "August 2026 spam update" },
  });
  if (existing) {
    console.log("demo radar event exists, skipping seed:", existing.id);
    return;
  }

  // Demo project the synthetic impacts attach to (no real GSC behind it).
  let project = await tx.project.findFirst({ where: { workspaceId: ws, domain: "demo.example.com" } });
  if (!project) {
    project = await tx.project.create({
      data: { workspaceId: ws, domain: "demo.example.com", locale: "en-US", searchEngine: "google" },
    });
    console.log("created demo project", project.id);
  }

  // Classify with the real classifier so the seed exercises the pipeline —
  // the Aug 2026 Spam Update must come out as rollout.
  const classification = classifyEventHeuristicOnly({
    externalId: "LEubPCm2octf2uMqCFKE",
    source: "status_dashboard",
    title: "August 2026 spam update",
    summary:
      "Service: Ranking. Released the August 2026 spam update, which applies globally and to all " +
      "languages. The rollout may take a few days to complete. The rollout was complete as of August 21, 2026.",
    startedAt: new Date("2026-08-18T16:27:00Z"),
    endedAt: new Date("2026-08-21T08:49:00Z"),
    url: "https://status.search.google.com/incidents/LEubPCm2octf2uMqCFKE",
  });
  if (classification.eventType !== "rollout") {
    throw new Error(`seed classifier sanity failed: expected rollout, got ${classification.eventType}`);
  }

  const event = await tx.platformEvent.create({
    data: {
      workspaceId: ws,
      source: "status_dashboard",
      eventType: "rollout",
      title: "August 2026 spam update",
      startedAt: new Date("2026-08-18T16:27:00Z"),
      endedAt: new Date("2026-08-21T08:49:00Z"),
      url: "https://status.search.google.com/incidents/LEubPCm2octf2uMqCFKE",
      classificationConfidence: classification.confidence,
    },
  });
  console.log("created platform_event", event.id);

  // Synthetic per-page impacts: 3 pages genuinely hit (declined), 1 improved,
  // matching the correlation fixtures — the M7 backtest asserts these exact rows.
  const impacts = [
    {
      page: "https://demo.example.com/guides/best-widgets",
      query: "best widgets 2026",
      deltaClicks: -180,
      deltaImpressions: -900,
      impactScore: 0.88,
      confidenceBand: [0.72, 0.96] as [number, number],
    },
    {
      page: "https://demo.example.com/guides/widget-reviews",
      query: "widget reviews",
      deltaClicks: -95,
      deltaImpressions: -400,
      impactScore: 0.64,
      confidenceBand: [0.46, 0.8] as [number, number],
    },
    {
      page: "https://demo.example.com/blog/widget-news",
      query: "widget news",
      deltaClicks: -42,
      deltaImpressions: -210,
      impactScore: 0.41,
      confidenceBand: [0.24, 0.6] as [number, number],
    },
    {
      page: "https://demo.example.com/pricing",
      query: "widget pricing",
      deltaClicks: 120,
      deltaImpressions: 700,
      impactScore: 0.73,
      confidenceBand: [0.55, 0.88] as [number, number],
    },
  ];
  await tx.pageImpact.createMany({
    data: impacts.map((i) => ({
      workspaceId: ws,
      platformEventId: event.id,
      projectId: project!.id,
      page: i.page,
      query: i.query,
      deltaClicks: i.deltaClicks,
      deltaImpressions: i.deltaImpressions,
      impactScore: i.impactScore,
      confidenceBand: [i.confidenceBand[0], i.confidenceBand[1]],
    })),
  });
  console.log(`created ${impacts.length} page_impact rows`);
});

await prisma.$disconnect();
console.log("seed-phase10-radar complete");
