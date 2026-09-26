// Marketr — Phase 7 demo data for the preview server / screenshots.
// Seeds: F1 reallocation (mode-a proposal pending approval + active SRA,
// policy decision, curves, floors, run), F2 recycling brief (winning mailer
// → billboard variant, ready), F3 Test Lab (experiment with honest results),
// F4 CTV (concierge campaign pending vendor approval + IO + spot +
// validation + pixel), F5 DSP (adapters, fee schedule, margin ledger),
// F6 launch checklist (seeded + a few items completed with evidence).
// Run:  npx tsx scripts/seed-demo-phase7.mts   (from ~/workspace/marketr)
// Idempotent: skips when a "Demo —" reallocation proposal already exists.
// Demo rows are all prefixed "Demo —"; existing records untouched.

import fs from "node:fs";

const envFile = fs.readFileSync(".env", "utf8");
const adminEmail = (envFile.match(/^ADMIN_EMAIL=(.*)$/m)?.[1] ?? "")
  .replace(/^"|"$/g, "")
  .trim()
  .toLowerCase();
if (!adminEmail) throw new Error("ADMIN_EMAIL missing in .env");
const userId = `admin:${adminEmail}`;

const { prisma } = await import("@/lib/prisma");

let wsRow = await prisma.workspace.findFirst({ where: { ownerUserId: userId } });
if (!wsRow) {
  wsRow = await prisma.workspace.create({
    data: {
      name: `${adminEmail}'s workspace`,
      ownerUserId: userId,
      plan: "self_hosted",
      members: { create: { userId, role: "owner" } },
    },
  });
  console.log("created admin workspace", wsRow.id);
}
const ws = wsRow.id;
console.log("workspace", ws);

const existing = await prisma.reallocationProposal.findFirst({
  where: { workspaceId: ws, sourceCampaignRef: { startsWith: "Demo —" } },
});
if (existing) {
  console.log("demo reallocation proposal exists, skipping seed:", existing.id);
  process.exit(0);
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);
const sha = (s: string) => `demo-${Buffer.from(s).toString("hex").slice(0, 32)}`;

// --- F1: Standing Reallocation Approval (mode b envelope) ----------------------
const sra = await prisma.sraEnvelope.create({
  data: {
    workspaceId: ws,
    name: "Demo — Q3 Guardrail SRA",
    channels: ["paid_search", "paid_social"],
    perShiftCapCents: 100000,
    dailyAggregateCapCents: 150000,
    weeklyAggregateCapCents: 250000,
    perChannelBandPct: 10,
    explorationFloorPct: 10,
    cooldownHours: 72,
    validFrom: daysAgo(1),
    validUntil: new Date(Date.now() + 29 * 86400_000),
    revocationId: sha("sra-revocation"),
    status: "active",
    signerIds: [userId, `${userId}:second`],
    signatureHash: sha("sra-signatures"),
    createdBy: userId,
  },
});
console.log("SRA", sra.id);

// --- F1: mode-a proposal (pending human approval) -----------------------------
const proposal = await prisma.reallocationProposal.create({
  data: {
    workspaceId: ws,
    mode: "a",
    sourceChannel: "paid_search",
    destChannel: "paid_social",
    sourceCampaignRef: "Demo — Search: Brand + Geo",
    destCampaignRef: "Demo — Social: Retargeting",
    amountCents: 25000,
    marginalRoasDelta: 0.34,
    decisionRecord: {
      dataWindow: "2026-08-25→2026-09-24",
      sourceCurve: { type: "hill", r2: 0.87, marginalRoas: 1.42 },
      destCurve: { type: "hill", r2: 0.91, marginalRoas: 2.08 },
      modelVersion: "opt-v1",
      antiChurnCheck: "ok — ≤20%/step",
      cooldownCheck: "ok — no shift in 96h",
    },
    status: "proposed",
  },
});
await prisma.policyDecision.create({
  data: {
    proposalId: proposal.id,
    workspaceId: ws,
    decision: "allow",
    reasons: [
      "within ±10% per-channel band",
      "under $1k cumulative two-person threshold",
      "no cooldown violation",
      "measurement health: green",
    ],
    sraId: null,
    revocationCheckedAt: new Date(),
  },
});
console.log("proposal (mode a, proposed)", proposal.id);

// Curves + floors + run
for (const [ch, r2, mr] of [["paid_search", 0.87, 1.42], ["paid_social", 0.91, 2.08]] as const) {
  await prisma.marginalCurve.create({
    data: {
      workspaceId: ws,
      channel: ch,
      curveType: "hill",
      params: { alpha: 2.1, beta: 11800, gamma: 0.62, marginalRoas: mr },
      adstock: { decay: 0.5, lagDays: 2 },
      seasonality: [1, 1, 1, 1, 1.05, 1.12, 1.08],
      rSquared: r2,
      dataWindow: "2026-08-25→2026-09-24",
      modelVersion: "opt-v1",
    },
  });
  await prisma.channelFloor.create({
    data: { workspaceId: ws, channel: ch, learningViableMinCentsDay: 5000, stabilizationHours: 72 },
  });
}
await prisma.reallocationRun.create({
  data: {
    workspaceId: ws,
    mode: "a",
    proposalsCount: 1,
    executedCount: 0,
    deniedCount: 0,
    frozen: false,
    dataHealthSnapshot: { attributionLag: "ok", measurementHealth: "green", regime: "stable" },
  },
});
console.log("F1 seeded: SRA + proposal + decision + curves + floors + run");

// --- F2: recycling brief -------------------------------------------------------
const brief = await prisma.recyclingBrief.create({
  data: {
    workspaceId: ws,
    sourceAssetId: "mail_campaign:demo-march-service-reminder",
    sourceChannel: "direct_mail",
    triggerSignalJson: {
      kind: "winner_signal",
      signalId: "attribution:fall-mailer-2026",
      metricValue: 4.2,
      metricUnit: "roas",
      observedAt: daysAgo(10).toISOString(),
      source: "phase2-attribution",
    },
    targetChannels: ["dooh", "audio"],
    variantSpecsJson: {
      dooh: { aspectRatio: "16:9", copyDensityCeiling: "7 words", ctaFormats: ["qr", "purl"], notes: "6-second read at 40ft", rulesVersion: "v1" },
      audio: { aspectRatio: "n/a", copyDensityCeiling: "30 seconds", ctaFormats: ["vanity_url"], notes: "spokesperson read, warm tone", rulesVersion: "v1" },
    },
    creativeHashLineageJson: [
      { entry: "source", assetId: "mail_campaign:demo-march-service-reminder", hash: sha("source-creative"), committedAt: daysAgo(10).toISOString() },
    ],
    status: "ready",
    approvalId: sha("recycling-approval"),
    studioRoutingJson: [
      { channel: "dooh", routedAt: daysAgo(2).toISOString(), reviewQueueId: sha("studio-dooh") },
      { channel: "audio", routedAt: daysAgo(2).toISOString(), reviewQueueId: sha("studio-audio") },
    ],
    createdBy: userId,
  },
});
await prisma.recyclingBriefEvent.create({
  data: {
    briefId: brief.id,
    workspaceId: ws,
    actor: userId,
    action: "brief_approved",
    payloadHash: sha(`${brief.id}-approved`),
    prevHash: "genesis",
    eventHash: sha(`${brief.id}-event`),
    detail: { routedToStudio: 2 },
  },
});
console.log("F2 seeded: recycling brief ready (mailer → DOOH + audio)");

// --- F3: Test Lab — experiment with honest results ------------------------------
await prisma.experimentIdea.create({
  data: {
    workspaceId: ws,
    title: "Demo — Homepage hero CTA copy test",
    sourceSignal: "phase2:landing-page-conversion-decline",
    pieIceScore: 7.4,
    status: "promoted",
  },
});
const exp = await prisma.experiment.create({
  data: {
    workspaceId: ws,
    name: "Demo — Homepage hero: 'Free estimate' vs 'Get pricing'",
    hypothesis: "A concrete pricing CTA will lift quote-request conversion vs. the generic 'Free estimate' CTA on the homepage hero.",
    pieIceScore: 7.4,
    channel: "web",
    variantsJson: [
      { key: "control", label: "Free estimate", weight: 0.5 },
      { key: "variant", label: "Get pricing", weight: 0.5 },
    ],
    audience: "all homepage visitors",
    primaryMetric: "quote_request_rate",
    metricType: "binomial",
    guardrailMetricsJson: ["bounce_rate", "revenue_per_visitor"],
    status: "complete",
    profitGuardrailJson: { metric: "revenue_per_visitor", minDelta: 0 },
    minRuntimeDays: 14,
    statedMde: 0.15,
    verdict: "inconclusive",
    baselineRate: 0.032,
    monthlyTraffic: 5200,
    launchedAt: daysAgo(21),
    completedAt: daysAgo(2),
    qaReportJson: { aaDryRun: "pass", trackingVerified: true, sampleRatio: "ok" },
    createdBy: userId,
  },
});
await prisma.experimentResult.create({
  data: {
    experimentId: exp.id,
    statsJson: {
      prob_to_beat: 0.71,
      expected_loss: 0.004,
      sequential_ci: { lower: -0.012, upper: 0.031 },
      frequentist_p: 0.28,
      peek_note: "sequential inference — safe to peek, no winner declared",
    },
    srmJson: { status: "pass", pValue: 0.42 },
    guardrailChecksJson: [
      { metric: "bounce_rate", status: "ok" },
      { metric: "revenue_per_visitor", status: "ok" },
    ],
    verdict: "inconclusive",
    archivedToMemory: true,
  },
});
console.log("F3 seeded: experiment complete, verdict inconclusive (honesty contract)");

// --- F4: CTV — concierge campaign -----------------------------------------------
const ctv = await prisma.ctvCampaign.create({
  data: {
    workspaceId: ws,
    name: "Demo — Fall CTV Flight",
    platform: "mntn",
    mode: "concierge",
    status: "pending_vendor_approval",
    budgetCents: 500000,
    flightStart: daysAgo(0),
    flightEnd: new Date(Date.now() + 60 * 86400_000),
    targetingJson: { geo: ["Greensboro DMA"], demos: ["A25-54"], genres: ["home-improvement"] },
    creativeIds: ["demo-ctv-spot-30s"],
    creativeHashes: [sha("ctv-spot-30s")],
    createdBy: userId,
  },
});
await prisma.ctvIo.create({
  data: {
    workspaceId: ws,
    campaignId: ctv.id,
    vendor: "mntn",
    ioPayload: {
      flight: "2026-09-25 → 2026-11-24",
      budget: "$5,000",
      targeting: "Greensboro DMA, A25-54, home-improvement genres",
      creativeBrief: "30s spot: heat-pump winter savings, couch-distance QR end card",
      alertOnly: true,
    },
    state: "pending_vendor_approval",
  },
});
const spot = await prisma.ctvSpot.create({
  data: {
    workspaceId: ws,
    campaignId: ctv.id,
    placementLabel: "Demo — Prime daypart, home-improvement genre",
    showGenre: "home-improvement",
    daypart: "prime",
    demo: "A25-54",
    creativeId: "demo-ctv-spot-30s",
    qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
    status: "active",
  },
});
await prisma.ctvCreativeValidation.create({
  data: {
    workspaceId: ws,
    campaignId: ctv.id,
    creativeId: "demo-ctv-spot-30s",
    creativeSha256: sha("ctv-spot-30s"),
    ffprobeJson: { width: 1920, height: 1080, codec: "h264", duration: 30.0, loudnessLufs: -23.0 },
    pass: true,
    checks: [
      { name: "resolution_1080p", passed: true, detail: "1920x1080" },
      { name: "duration_30s", passed: true, detail: "30.0s" },
      { name: "codec_h264", passed: true, detail: "h264" },
      { name: "loudness", passed: true, detail: "-23.0 LUFS" },
    ],
    durationSeconds: 30.0,
    publisher: "mntn",
    publisherRulesVersion: "iab-dec2025-draft",
  },
});
await prisma.ctvPixel.create({
  data: {
    workspaceId: ws,
    campaignId: ctv.id,
    pixelUrl: `https://demo-triadhomeservices.com/px/${sha("ctv-pixel")}`,
    pixelToken: sha("ctv-pixel-token"),
    viewThroughWindowDays: 14,
    impressionsCount: 18420,
  },
});
console.log("F4 seeded: CTV concierge campaign (MNTN, pending vendor approval)");

// --- F5: DSP readiness -----------------------------------------------------------
const dspKinds = ["amazon", "ttd", "dv360", "basis"] as const;
const dspRows: Record<string, { id: string }> = {};
for (const dsp of dspKinds) {
  const row = await prisma.dspAdapter.create({
    data: {
      workspaceId: ws,
      dsp,
      seatStatus: dsp === "amazon" ? "pending" : "none",
      configRef: null,
      connectedBy: null,
    },
  });
  dspRows[dsp] = { id: row.id };
}
await prisma.feeSchedule.create({
  data: {
    workspaceId: ws,
    dsp: "amazon",
    version: 1,
    feeLinesJson: {
      takeRate: 0,
      techFeeCentsPerMille: 0,
      minimumMonthlyCents: 500000,
      notes: "self-service floor removed Nov 2025; practical $5–10K/mo",
    },
    effectiveFrom: daysAgo(30),
    createdBy: userId,
  },
});
await prisma.marginLedgerRow.create({
  data: {
    workspaceId: ws,
    period: "2026-09",
    dspAdapterId: dspRows["amazon"].id,
    dsp: "amazon",
    clientBilledCents: 500000,
    platformFeesCents: 60000,
    passthroughCents: 410000,
    marketrMarginCents: 30000,
    feeScheduleVersion: 1,
    note: "Demo — September CTV/test spend accounting",
    postedBy: userId,
  },
});
console.log("F5 seeded: 4 DSP adapters (amazon pending), fee schedule, margin ledger");

// --- F6: launch checklist ---------------------------------------------------------
const { seedLaunchChecklist, completeChecklistItem } = await import("@/lib/flywheel/launch/store");
await seedLaunchChecklist(ws);
const completions: Array<[string, string, string]> = [
  ["secret-history-scan", "docs/phase7-research.md", "Scanned 2026-09-25 — zero real secrets"],
  ["sbom-audit", "docs/phase7-research.md", "Vendored GrowthBook stats core pinned"],
  ["open-core-brief", "docs/phase7-research.md", "Options mapped; split decision deferred"],
];
for (const [key, evidence, note] of completions) {
  try {
    await completeChecklistItem({ workspaceId: ws, key, evidenceUrl: evidence, note });
    console.log("checklist complete:", key);
  } catch (e) {
    console.log("checklist skip:", key, (e as Error).message);
  }
}

console.log("\nPhase 7 demo seed complete.");
