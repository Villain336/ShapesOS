// Marketr — Phase 8 demo data for the preview server / screenshots.
// Seeds: G1 Business Graph (client company, products with prices, competitor,
// location, employees, creative assets, keywords, channels, edges, facts),
// G2 Campaign object ("Demo — Spring Launch" with link-not-replace links to a
// Phase 4 mail drop, a Phase 5 media buy, and a Phase 7 experiment, plus a
// Phase 2 keyword list on a seeded project), G3 Growth Memory (episodic
// event from the Test Lab archive sink, a user-told semantic fact anchored
// to the client node, an agent-inferred fact, a procedural learning, and one
// human-reviewed anonymized playbook pattern).
// Run:  npx tsx scripts/seed-demo-phase8.mts   (from ~/workspace/marketr)
// Idempotent: skips when a "Demo — Spring Launch" growth campaign exists.
// Demo rows are all prefixed "Demo —"; existing records untouched.
//
// NOTE: Phase 8 substrate tables run FORCE ROW LEVEL SECURITY (fail-closed on
// the app.workspace_id GUC), so the whole seed runs inside one scoped
// transaction with the tenant + playbook-reviewer GUCs pinned.

import fs from "node:fs";
import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";

type JsonObj = Prisma.InputJsonValue;

const envFile = fs.readFileSync(".env", "utf8");
const adminEmail = (envFile.match(/^ADMIN_EMAIL=(.*)$/m)?.[1] ?? "")
  .replace(/^"|"$/g, "")
  .trim()
  .toLowerCase();
if (!adminEmail) throw new Error("ADMIN_EMAIL missing in .env");
const userId = `admin:${adminEmail}`;

const { prisma } = await import("@/lib/prisma");

const wsRow = await prisma.workspace.findFirst({ where: { ownerUserId: userId } });
if (!wsRow) throw new Error("admin workspace not found — run an earlier phase seed first");
const ws = wsRow.id;
console.log("workspace", ws);

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

await prisma.$transaction(async (tx: Tx) => {
  await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ws}, true)`;
  await tx.$executeRaw`SELECT set_config('app.playbook_reviewer', '1', true)`;

  const existing = await tx.growthCampaign.findFirst({
    where: { workspaceId: ws, name: "Demo — Spring Launch" },
  });
  if (existing) {
    console.log("demo campaign exists, skipping seed:", existing.id);
    return;
  }

  // -----------------------------------------------------------------------
  // G1 — Business Graph
  // -----------------------------------------------------------------------
  const asOf = daysAgo(1);

  const node = (
    entityType: string,
    canonicalKey: string,
    displayName: string,
    core: JsonObj = {},
    properties: JsonObj = {},
  ) =>
    tx.graphNode.upsert({
      where: { workspaceId_canonicalKey: { workspaceId: ws, canonicalKey } },
      update: { displayName, core, properties, lastSeen: new Date(), asOf, asOfSource: "onboarding" },
      create: {
        workspaceId: ws,
        entityType: entityType as never,
        canonicalKey,
        displayName,
        core,
        properties,
        asOf,
        asOfSource: "onboarding",
      },
    });

  const fact = (
    entityRef: string,
    factType: string,
    payload: JsonObj,
    observedAt: Date,
  ) => {
    const contentHash = hash(JSON.stringify(payload));
    const sourceRecordId = `demo-onboarding-${entityRef}-${factType}`;
    return tx.graphFact.upsert({
      where: {
        workspaceId_source_sourceRecordId_factType_contentHash: {
          workspaceId: ws,
          source: "onboarding",
          sourceRecordId,
          factType,
          contentHash,
        },
      },
      update: {},
      create: {
        workspaceId: ws,
        source: "onboarding",
        sourceRecordId,
        entityRef,
        factType,
        payload,
        observedAt,
        contentHash,
      },
    });
  };

  const edge = (fromNodeId: string, toNodeId: string, edgeType: string, properties: JsonObj = {}) =>
    tx.graphEdge.create({
      data: {
        workspaceId: ws,
        fromNodeId,
        toNodeId,
        edgeType,
        properties,
        confidence: 0.98,
        validAt: asOf,
      },
    });

  const client = await node("customer", "customer:demo-acme-plumbing", "Demo — Acme Plumbing Co.", {
    city: "Greensboro",
    state: "NC",
    website: "demo-acme-plumbing.example.com",
  }, { founded: 2011, employees: 14, reviewRating: 4.7 });

  const prod1 = await node("product", "product:demo-emergency-drain-repair", "Demo — Emergency Drain Repair", {
    priceCents: 18900,
    priceLabel: "$189 flat",
  }, { sku: "DRN-EMG" });
  const prod2 = await node("product", "product:demo-water-heater-install", "Demo — Water Heater Install", {
    priceCents: 145000,
    priceLabel: "$1,450 installed",
  }, { sku: "WHI-50G" });
  const prod3 = await node("product", "product:demo-maintenance-plan", "Demo — Annual Maintenance Plan", {
    priceCents: 2900,
    priceLabel: "$29/mo",
  }, { sku: "MNT-ANN" });

  const competitor = await node("competitor", "competitor:demo-triad-rooter-pros", "Demo — Triad Rooter Pros", {
    domain: "demo-triad-rooter.example.com",
  }, { estimatedMonthlyAdSpend: 4200 });

  const location = await node("location", "location:demo-greensboro-nc", "Demo — Greensboro, NC", {
    city: "Greensboro",
    state: "NC",
    lat: 36.0726,
    lng: -79.792,
  }, { serviceRadiusMiles: 25 });

  const emp1 = await node("employee", "employee:demo-maria-chen", "Demo — Maria Chen", { role: "Owner / GM" }, { tenureYears: 9 });
  const emp2 = await node("employee", "employee:demo-darius-wells", "Demo — Darius Wells", { role: "Lead technician" }, { tenureYears: 4 });

  const asset1 = await node("creative_asset", "creative_asset:demo-spring-mailer", "Demo — Spring mailer (6x9 postcard)", {
    channel: "direct_mail",
  }, { creativeHash: "demo-hash-mailer-9f2c" });
  const asset2 = await node("creative_asset", "creative_asset:demo-drain-billboard", "Demo — Drain billboard (I-40)", {
    channel: "ooh",
  }, { creativeHash: "demo-hash-billboard-41ab" });

  const kw1 = await node("keyword", "keyword:demo-plumber-greensboro-nc", "Demo — plumber greensboro nc", {
    volume: 2900,
    intent: "transactional",
  });
  const kw2 = await node("keyword", "keyword:demo-emergency-drain-repair-near-me", "Demo — emergency drain repair near me", {
    volume: 880,
    intent: "transactional",
  });

  const chSearch = await node("channel", "channel:paid_search", "Paid search");
  const chMail = await node("channel", "channel:direct_mail", "Direct mail");
  const chEmail = await node("channel", "channel:email", "Email");

  await edge(client.id, prod1.id, "sells");
  await edge(client.id, prod2.id, "sells");
  await edge(client.id, prod3.id, "sells");
  await edge(client.id, competitor.id, "competes_with", { overlapScore: 0.72 });
  await edge(client.id, location.id, "located_in");
  await edge(client.id, emp1.id, "employs");
  await edge(client.id, emp2.id, "employs");
  await edge(prod1.id, chSearch.id, "marketed_via");
  await edge(prod1.id, chMail.id, "marketed_via");
  await edge(prod2.id, chSearch.id, "marketed_via");
  await edge(asset1.id, chMail.id, "used_in");
  await edge(asset2.id, chSearch.id, "used_in");
  await edge(kw1.id, prod1.id, "targets");
  await edge(kw2.id, prod1.id, "targets");

  await fact("customer:demo-acme-plumbing", "company_profile", {
    legalName: "Acme Plumbing Co. (demo)",
    city: "Greensboro",
    state: "NC",
    employees: 14,
  }, asOf);
  await fact("product:demo-emergency-drain-repair", "price", { priceCents: 18900, currency: "USD" }, asOf);
  await fact("product:demo-water-heater-install", "price", { priceCents: 145000, currency: "USD" }, asOf);
  await fact("competitor:demo-triad-rooter-pros", "competitor_profile", {
    domain: "demo-triad-rooter.example.com",
    estimatedMonthlyAdSpend: 4200,
  }, asOf);
  console.log("G1 graph seeded: 15 nodes, 14 edges, 4 facts");

  // -----------------------------------------------------------------------
  // G2 — Campaign object ("Demo — Spring Launch") with link-not-replace links
  // -----------------------------------------------------------------------

  // Phase 2 fragment: project + keyword list (none seeded as demo yet).
  let project = await tx.project.findFirst({
    where: { workspaceId: ws, domain: "demo-acme-plumbing.example.com" },
  });
  if (!project) {
    project = await tx.project.create({
      data: { workspaceId: ws, domain: "demo-acme-plumbing.example.com", locale: "en-US", searchEngine: "google" },
    });
  }
  for (const phrase of ["Demo — plumber greensboro nc", "Demo — emergency drain repair near me", "Demo — water heater installation greensboro"]) {
    await tx.keyword.upsert({
      where: { projectId_phrase: { projectId: project.id, phrase } },
      update: { list: "Demo — Spring Launch keywords" },
      create: { projectId: project.id, phrase, volume: 1200, difficulty: 0.42, list: "Demo — Spring Launch keywords" },
    });
  }

  // Phase 4 fragment: mail drop (none seeded as demo yet).
  let mailDrop = await tx.mailCampaign.findFirst({
    where: { workspaceId: ws, name: "Demo — Spring Launch mail drop" },
  });
  if (!mailDrop) {
    mailDrop = await tx.mailCampaign.create({
      data: {
        workspaceId: ws,
        name: "Demo — Spring Launch mail drop",
        audienceSource: { kind: "csv", ref: "demo-spring-prospects.csv" },
        pieceCount: 2500,
        verifiedCount: 2381,
        estCostCents: 187500,
        actualCostCents: 183200,
        status: "complete",
        mailedAt: daysAgo(21),
        inHomeStart: daysAgo(16),
        inHomeEnd: daysAgo(12),
      },
    });
  }

  // Phase 5 fragment: reuse the seeded demo media buy.
  const mediaBuy = await tx.mediaBuy.findFirst({ where: { workspaceId: ws } });

  // Phase 7 fragment: reuse the seeded demo experiment.
  const experiment = await tx.experiment.findFirst({
    where: { workspaceId: ws, name: { startsWith: "Demo" } },
  });

  const stages = [
    "research", "offer", "audience", "messaging", "landing_page", "ads",
    "email_sms", "social", "retargeting", "crm_pipeline", "lead_scoring", "reporting",
  ];
  const stageStates: Record<string, string> = {};
  for (const s of stages) {
    stageStates[s] = ["research", "offer", "audience", "messaging", "landing_page", "ads"].includes(s)
      ? "complete"
      : ["email_sms", "social", "retargeting"].includes(s)
        ? "in_progress"
        : "not_started";
  }

  const campaign = await tx.growthCampaign.create({
    data: {
      workspaceId: ws,
      name: "Demo — Spring Launch",
      objective: "launch",
      status: "active",
      stages: {
        items: stages.map((key) => ({
          key,
          status: stageStates[key],
          note: key === "ads" ? "Search + social live" : undefined,
        })),
      },
      budgetRollupCents: 512500,
      reportingConfig: { primaryKpi: "booked_jobs", targetJobs: 120, keywordList: "Demo — Spring Launch keywords" },
      createdBy: adminEmail,
    },
  });

  await tx.campaignLink.createMany({
    data: [
      { campaignId: campaign.id, linkedType: "mail_campaign", linkedId: mailDrop.id, role: "primary", linkSource: "human", linkedBy: userId },
      ...(mediaBuy ? [{ campaignId: campaign.id, linkedType: "media_buy" as const, linkedId: mediaBuy.id, role: "primary" as const, linkSource: "human" as const, linkedBy: userId }] : []),
      ...(experiment ? [{ campaignId: campaign.id, linkedType: "experiment" as const, linkedId: experiment.id, role: "supporting" as const, linkSource: "human" as const, linkedBy: userId }] : []),
    ],
  });
  console.log("G2 campaign seeded:", campaign.id, "(mail +", mediaBuy ? "buy" : "no-buy", "+", experiment ? "experiment" : "no-experiment", "linked)");

  // -----------------------------------------------------------------------
  // G3 — Growth Memory: all three stores
  // -----------------------------------------------------------------------

  // Episodic: a run record from the Test Lab archive sink.
  const episode = await tx.memoryEpisode.create({
    data: {
      workspaceId: ws,
      episodeType: "run",
      actor: "test-lab",
      summary:
        "Demo — Test Lab experiment 'Homepage hero: Free estimate vs Get pricing' completed with an inconclusive verdict after 21 days (SRM pass, underpowered for the stated MDE).",
      refs: {
        experimentId: experiment?.id ?? null,
        campaignId: campaign.id,
        kind: "test_lab_archive",
      },
      startedAt: daysAgo(21),
      endedAt: daysAgo(1),
    },
  });

  // Procedural: what was learned (F3 archive-sink schema).
  await tx.memoryLearning.create({
    data: {
      workspaceId: ws,
      hypothesis: "A 'Free estimate' CTA on the homepage hero converts more booked jobs than 'Get pricing'.",
      action: "Ran a 21-day A/B test on the homepage hero CTA (50/50 split, ~4.1k visitors/arm).",
      result: "inconclusive",
      metricDelta: { bookedJobs: { control: 96, variant: 104, liftPct: 8.3, note: "below MDE; not significant" } },
      observedAt: daysAgo(1),
      contextRefs: { experimentId: experiment?.id ?? null, campaignId: campaign.id, channel: "web" },
      source: "test_lab",
      sourceEpisodeId: episode.id,
    },
  });

  // Semantic: a user-told fact anchored to the client node (decay-to-floor: survives prune).
  await tx.memoryFact.create({
    data: {
      workspaceId: ws,
      subjectNodeId: client.id,
      predicate: "prefers_contact_channel",
      object: { value: "phone", detail: "Owner picks up 8am–5pm; no after-hours email threads" },
      confidence: 1.0,
      validAt: daysAgo(14),
      sourceEpisodeId: episode.id,
      origin: "user_told",
    },
  });

  // Semantic: an agent-inferred fact (fades on decay — contrast for the UI).
  await tx.memoryFact.create({
    data: {
      workspaceId: ws,
      subjectNodeId: prod1.id,
      predicate: "best_performing_channel",
      object: { value: "paid_search", evidence: "38% of booked jobs attributed last 90d" },
      confidence: 0.71,
      validAt: daysAgo(7),
      origin: "agent_inferred",
    },
  });

  // Cross-client playbook: anonymized + human-reviewed (passes the review gate).
  await tx.playbookLearning.upsert({
    where: { id: "demo-playbook-free-estimate-cta" },
    update: {},
    create: {
      id: "demo-playbook-free-estimate-cta",
      patternTitle: "Demo — Home-services: 'free estimate' CTA beats 'get pricing' on hero buttons",
      patternBody:
        "Across 3 anonymized home-services clients, hero CTAs framed as a free estimate produced 9–14% more booked jobs than price-first CTAs. Mechanism: price-first framing triggers cost anxiety before value is established. Apply to: hero, above-fold service cards. Never claim: exact lift transfers across verticals.",
      supportingClientCount: 3,
      firstObserved: daysAgo(60),
      lastObserved: daysAgo(1),
      anonymizationReviewedBy: userId,
      reviewedAt: daysAgo(1),
    },
  });
  console.log("G3 memory seeded: 1 episode, 1 learning, 2 facts, 1 playbook pattern");

  // Hand the capture script the campaign id for the detail-page screenshot.
  fs.writeFileSync("/tmp/phase8-demo-ids.json", JSON.stringify({ campaignId: campaign.id }, null, 2));
  console.log("wrote /tmp/phase8-demo-ids.json");
});

await prisma.$disconnect();
console.log("done");
