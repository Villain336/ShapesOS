// Marketr — Phase 6 demo data for the preview server / screenshots.
// Seeds: O1 outreach (2 campaigns at different ladder depths, sending domain,
// prospects, sequences, events), O2 digital PR (opportunities, draft,
// relationships, placement), L1 listings (tier-labeled channels, profiles,
// citation brief), R1 reviews (reply queue + velocity), A1 AEO (prompt set,
// per-engine runs, mentions, source impact, actions), 2 pending approvals,
// and a compiled + finalized Intelligence Report (12 audits + 90-day plan).
// Run:  npx tsx scripts/seed-demo-phase6.mts   (from ~/workspace/marketr)
// Idempotent: skips when a "Demo —" outreach campaign already exists.
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
const { bindingHashOf } = await import("@/lib/authority/approvals");

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

const existing = await prisma.outreachCampaign.findFirst({
  where: { workspaceId: ws, name: { startsWith: "Demo —" } },
});
if (existing) {
  console.log("demo outreach campaign exists, skipping seed:", existing.name);
  process.exit(0);
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);
const sha = (s: string) => `demo-${Buffer.from(s).toString("hex").slice(0, 32)}`;

// --- O1: sending domain -------------------------------------------------------
const domain = await prisma.sendingDomain.create({
  data: {
    workspaceId: ws,
    domain: "out.demo-triadhomeservices.com",
    isPrimary: false,
    spfOk: true,
    dkimOk: true,
    dmarcPolicy: "p=quarantine",
    warmupStartedAt: daysAgo(35),
    warmupStage: 35,
    trackingCnameOk: true,
    status: "ready",
  },
});
console.log("sending domain", domain.domain);

// Depth-1 campaign: prospecting only (draft)
const camp1 = await prisma.outreachCampaign.create({
  data: {
    workspaceId: ws,
    name: "Demo — Prospect Harvest",
    depth: 1,
    status: "draft",
    dailyCap: 30,
    authStatusJson: { spf: true, dkim: true, dmarc: true },
    createdBy: userId,
  },
});

// Depth-2 campaign: AI drafts for human send (active)
const camp2 = await prisma.outreachCampaign.create({
  data: {
    workspaceId: ws,
    name: "Demo — Guest Post Sprint",
    depth: 2,
    status: "active",
    sendingDomainId: domain.id,
    dailyCap: 40,
    warmupVerifiedAt: daysAgo(2),
    authStatusJson: { spf: true, dkim: true, dmarc: true, warmup: "ready" },
    createdBy: userId,
  },
});
console.log("campaigns", camp1.id, camp2.id);

const prospectData = [
  { domain: "triadhomeblog.com", url: "https://triadhomeblog.com/write-for-us", contactName: "Maya Chen", email: "maya@triadhomeblog.com", emailVerified: true, qualityScore: 88, relevanceScore: 92, status: "replied" as const },
  { domain: "ncremodelingguide.com", url: "https://ncremodelingguide.com/contribute", contactName: "Devon Park", email: "devon@ncremodelingguide.com", emailVerified: true, qualityScore: 81, relevanceScore: 85, status: "contacted" as const },
  { domain: "greensborolivingmag.com", url: "https://greensborolivingmag.com/submissions", contactName: "Priya Nair", email: "priya@greensborolivingmag.com", emailVerified: true, qualityScore: 94, relevanceScore: 90, status: "placed" as const },
  { domain: "hvacinsiderweekly.com", url: "https://hvacinsiderweekly.com/guest-posts", contactName: "Tom Alvarez", email: "tom@hvacinsiderweekly.com", emailVerified: false, qualityScore: 72, relevanceScore: 95, status: "qualified" as const },
  { domain: "energywisehomes.com", url: "https://energywisehomes.com/write", contactName: "Sara Lindqvist", email: "sara@energywisehomes.com", emailVerified: true, qualityScore: 77, relevanceScore: 83, status: "new" as const },
  { domain: "southernhomepros.com", url: "https://southernhomepros.com/contributors", contactName: null, email: null, emailVerified: false, qualityScore: 64, relevanceScore: 70, status: "new" as const },
];
const prospects = [];
for (const p of prospectData) {
  prospects.push(
    await prisma.outreachProspect.create({
      data: { workspaceId: ws, campaignId: camp2.id, ...p },
    })
  );
}
// Two prospects on the depth-1 campaign
for (const p of prospectData.slice(3, 5)) {
  await prisma.outreachProspect.create({
    data: { workspaceId: ws, campaignId: camp1.id, ...p, status: "new" },
  });
}
console.log("prospects", prospects.length);

// Sequences + events on the depth-2 campaign
const seqSpecs: Array<{ prospect: number; status: "draft" | "scheduled" | "sending" | "completed"; sentCount: number; events: string[] }> = [
  { prospect: 0, status: "completed", sentCount: 3, events: ["sent", "opened", "replied"] },
  { prospect: 1, status: "sending", sentCount: 2, events: ["sent", "opened", "clicked"] },
  { prospect: 2, status: "completed", sentCount: 2, events: ["sent", "opened", "replied", "placement_verified"] },
  { prospect: 3, status: "scheduled", sentCount: 0, events: [] },
];
for (const s of seqSpecs) {
  const seq = await prisma.outreachSequence.create({
    data: {
      workspaceId: ws,
      campaignId: camp2.id,
      prospectId: prospects[s.prospect].id,
      depth: 2,
      stepsJson: [
        { step: 1, subject: "Guest post idea for {{site}}", body: "Hi {{name}} — quick pitch…" },
        { step: 2, subject: "Re: Guest post idea", body: "Following up…" },
        { step: 3, subject: "Last nudge", body: "Closing the loop…" },
      ],
      status: s.status,
      sentCount: s.sentCount,
    },
  });
  for (const ev of s.events) {
    await prisma.outreachEvent.create({
      data: {
        workspaceId: ws,
        sequenceId: seq.id,
        ts: daysAgo(s.events.indexOf(ev)),
        event: ev as "sent",
        payloadHash: sha(`${seq.id}-${ev}`),
        detail: { step: 1 },
      },
    });
  }
}
console.log("sequences + events seeded");

// --- O2: digital PR ------------------------------------------------------------
const opp1 = await prisma.prOpportunity.create({
  data: {
    workspaceId: ws,
    source: "connectively",
    journalist: "Dana Whitfield",
    outlet: "Triad Business Journal",
    queryText: "Seeking HVAC contractors on how heat pumps perform in NC winters — need quotes by Friday.",
    deadline: new Date(Date.now() + 3 * 86400_000),
    matchScore: 91,
    expertiseTags: ["hvac", "energy-efficiency", "small-business"],
    status: "drafting",
  },
});
const opp2 = await prisma.prOpportunity.create({
  data: {
    workspaceId: ws,
    source: "qwoted",
    journalist: "Marcus Bell",
    outlet: "EnergyTech Weekly",
    queryText: "Looking for home-service founders using AI scheduling tools — what's actually working?",
    deadline: new Date(Date.now() + 6 * 86400_000),
    matchScore: 84,
    expertiseTags: ["ai", "home-services", "operations"],
    status: "matched",
  },
});
const opp3 = await prisma.prOpportunity.create({
  data: {
    workspaceId: ws,
    source: "journo_request",
    journalist: "Elena Ruiz",
    outlet: "Southern Home & Living",
    queryText: "Spring HVAC tune-up checklist — expert tips for homeowners.",
    deadline: daysAgo(9),
    matchScore: 88,
    expertiseTags: ["hvac", "home-maintenance"],
    status: "placed",
  },
});
await prisma.prDraft.create({
  data: {
    workspaceId: ws,
    opportunityId: opp1.id,
    researchBriefJson: { angle: "heat-pump ROI in Piedmont NC", stats: ["38% lower winter bills (DOE)"] },
    quoteSkeleton: "“In the Triad we see heat pumps cut winter heating bills by a third…” — quote skeleton, human to finalize.",
    checklistJson: { noAttachments: true, subjectUnder49: true, deAiPass: true },
    deAiPassed: true,
    status: "draft",
  },
});
await prisma.prRelationship.create({
  data: {
    workspaceId: ws,
    journalist: "Dana Whitfield",
    outlet: "Triad Business Journal",
    historyJson: [{ date: daysAgo(40).toISOString(), kind: "pitch", outcome: "replied" }],
    followUpCount: 1,
  },
});
await prisma.prRelationship.create({
  data: {
    workspaceId: ws,
    journalist: "Elena Ruiz",
    outlet: "Southern Home & Living",
    historyJson: [{ date: daysAgo(9).toISOString(), kind: "pitch", outcome: "placed" }],
    followUpCount: 0,
  },
});
await prisma.prPlacement.create({
  data: {
    workspaceId: ws,
    opportunityId: opp3.id,
    url: "https://southernhomeandliving.example/spring-hvac-tuneup-checklist",
    outlet: "Southern Home & Living",
    publishDate: daysAgo(7),
    visibilityImpactJson: { referralSessions: 214, brandedSearchLift: 0.12 },
  },
});
console.log("PR seeded: 3 opportunities, 1 draft, 2 relationships, 1 placement");

// --- L1: listings (honest tiers) ------------------------------------------------
const channels: Array<{ channel: string; tier: "api_synced" | "aggregator" | "manual" | "guided_claim"; status: "connected" | "syncing" | "error" | "disconnected" }> = [
  { channel: "gbp", tier: "api_synced", status: "connected" },
  { channel: "bing", tier: "api_synced", status: "syncing" },
  { channel: "apple", tier: "guided_claim", status: "disconnected" },
  { channel: "yelp", tier: "manual", status: "disconnected" },
];
for (const c of channels) {
  await prisma.listingChannel.create({
    data: {
      workspaceId: ws,
      channel: c.channel,
      tier: c.tier,
      status: c.status,
      lastSyncAt: c.status === "connected" ? daysAgo(1) : null,
      lastVerifiedAt: c.status === "connected" ? daysAgo(1) : null,
      syncErrorsJson: [],
      configJson: { locationRef: "demo-gso-main" },
    },
  });
}
const nap = { name: "Demo — Triad Home Services", street: "412 W Market St", city: "Greensboro", state: "NC", zip: "27401", phone: "(336) 555-0147", website: "https://demo-triadhomeservices.com" };
for (const ch of ["gbp", "bing"]) {
  await prisma.listingProfile.create({
    data: {
      workspaceId: ws,
      channel: ch,
      locationRef: "demo-gso-main",
      napJson: nap,
      hoursJson: { mon_fri: "8:00-18:00", sat: "9:00-14:00", sun: "closed" },
      attributesJson: { women_led: false, veteran_led: true },
      photosJson: [],
      verificationStatus: ch === "gbp" ? "verified" : "pending",
    },
  });
}
await prisma.citationBrief.create({
  data: {
    workspaceId: ws,
    competitorGapJson: { competitor: "Greensboro HVAC Co", theirCitations: 84, ourCitations: 41, gapDirectories: ["yelp", "angi", "homeadvisor", "thumbtack"] },
    directoriesJson: [
      { directory: "yelp", prefilled_nap: nap, status: "pending", verified_at: null },
      { directory: "angi", prefilled_nap: nap, status: "submitted", verified_at: null },
      { directory: "homeadvisor", prefilled_nap: nap, status: "pending", verified_at: null },
    ],
    checklistStatus: "in_progress",
  },
});
console.log("listings seeded: 4 tier-labeled channels, 2 profiles, 1 citation brief");

// --- R1: reviews ----------------------------------------------------------------
const reviewRows: Array<{ reviewId: string; source: "gbp" | "apple"; rating: number; sentiment: "pos" | "neu" | "neg"; reviewText: string; reviewerName: string; draftReply: string | null; status: "pending" | "approved" | "posted" | "rejected" | "escalated"; replyState: "none" | "pending_mod" | "approved" | "rejected" }> = [
  { reviewId: "demo-rev-001", source: "gbp", rating: 5, sentiment: "pos", reviewText: "Tech arrived on time, fixed our AC in one visit. Fair price, great communication.", reviewerName: "James W.", draftReply: "Thank you, James! Glad our team got your AC back up quickly. We appreciate your business.", status: "pending", replyState: "none" },
  { reviewId: "demo-rev-002", source: "gbp", rating: 2, sentiment: "neg", reviewText: "Waited 3 days for a callback during the heat wave. Frustrating.", reviewerName: "Angela M.", draftReply: "We're sorry about the delayed callback during the heat wave. We'd like to make this right — please call us at (336) 555-0147.", status: "pending", replyState: "none" },
  { reviewId: "demo-rev-003", source: "gbp", rating: 5, sentiment: "pos", reviewText: "New heat pump install — crew was professional and cleaned up everything.", reviewerName: "Robert T.", draftReply: "Thanks, Robert! Enjoy the new heat pump — call us anytime you need us.", status: "posted", replyState: "approved" },
  { reviewId: "demo-rev-004", source: "apple", rating: 4, sentiment: "pos", reviewText: "Good service, slightly pricey but quality work.", reviewerName: "Lisa K.", draftReply: "Thanks for the feedback, Lisa — we price for quality and stand behind every job.", status: "approved", replyState: "none" },
];
for (const r of reviewRows) {
  await prisma.reviewQueue.create({
    data: {
      workspaceId: ws,
      locationRef: "demo-gso-main",
      reviewId: r.reviewId,
      source: r.source,
      rating: r.rating,
      sentiment: r.sentiment,
      reviewText: r.reviewText,
      reviewerName: r.reviewerName,
      draftReply: r.draftReply,
      guardrailFlags: r.sentiment === "neg" ? ["negative_requires_human"] : [],
      status: r.status,
      replyState: r.replyState,
      postedAt: r.status === "posted" ? daysAgo(1) : null,
    },
  });
}
await prisma.reviewVelocity.create({
  data: {
    workspaceId: ws,
    locationRef: "demo-gso-main",
    requestsSent: 120,
    reviewsReceived: 34,
    velocity7d: 2.1,
    velocity30d: 8.4,
    funnelJson: { sent: 120, delivered: 118, opened: 71, reviewed: 34 },
  },
});
console.log("reviews seeded: 4 queue items, 1 velocity row");

// --- A1: AEO --------------------------------------------------------------------
const prompts = [
  "best hvac company greensboro nc", "heat pump installer near me", "ac repair greensboro reviews",
  "furnace replacement cost north carolina", "emergency hvac service triad", "duct cleaning greensboro nc",
  "hvac maintenance plan greensboro", "who installs mini splits in greensboro", "triad home services reviews",
  "best rated hvac contractor piedmont nc", "heat pump vs furnace nc climate", "ac tune up special greensboro",
  "commercial hvac greensboro nc", "hvac financing options north carolina", "indoor air quality testing greensboro",
  "smart thermostat installation greensboro", "hvac company with good reviews greensboro", "24 hour ac repair greensboro nc",
  "energy audit home greensboro nc", "attic insulation contractor triad", "water heater installation greensboro",
  "generac generator installer greensboro nc", "hvac rebates north carolina 2026", "local hvac company greensboro",
];
const promptSet = await prisma.aeoPromptSet.create({
  data: { workspaceId: ws, version: 1, promptsJson: prompts, createdBy: userId, active: true },
});
const engines = ["openai", "anthropic", "gemini", "perplexity"] as const;
const ownedDomain = "demo-triadhomeservices.com";
const mentionRate: Record<string, number> = { openai: 0.62, anthropic: 0.55, gemini: 0.71, perplexity: 0.48 };
for (const engine of engines) {
  const run = await prisma.aeoRun.create({
    data: {
      workspaceId: ws,
      promptSetId: promptSet.id,
      promptSetVersion: 1,
      engine,
      completedAt: daysAgo(1),
      reps: 3,
      status: "completed",
      costEstimateCents: 120,
    },
  });
  for (let pi = 0; pi < 8; pi++) {
    for (let rep = 0; rep < 3; rep++) {
      const hit = ((pi * 7 + rep * 13 + engine.length) % 10) / 10 < (mentionRate[engine] ?? 0.5);
      await prisma.aeoMention.create({
        data: {
          runId: run.id,
          promptIdx: pi,
          rep,
          mentioned: hit,
          position: hit ? (pi % 3) + 1 : null,
          sentiment: hit ? (pi % 5 === 0 ? "neutral" : "positive") : null,
          competitors: hit ? ["greensborohvac.example", "piedmontcomfort.example"] : [],
          citedSources: hit ? [ownedDomain, "southernhomeandliving.example"] : [],
          judgeModel: "demo-nano-judge",
          judgeConfidence: hit ? 0.91 : 0.97,
        },
      });
    }
  }
  const impactDomains = [ownedDomain, "greensborohvac.example", "piedmontcomfort.example", "southernhomeandliving.example"];
  for (let i = 0; i < impactDomains.length; i++) {
    await prisma.aeoSourceImpact.create({
      data: {
        workspaceId: ws,
        engine,
        domain: impactDomains[i],
        citationFrequency: [46, 31, 22, 12][i] ?? 5,
        citationEfficiency: [0.83, 0.61, 0.44, 0.29][i] ?? 0.2,
        cooccurrenceLift: [1.9, 1.2, 0.8, 0.4][i] ?? 0.1,
      },
    });
  }
}
await prisma.aeoAction.create({
  data: {
    workspaceId: ws,
    kind: "owned_fix",
    sourceRef: ownedDomain,
    geo16Pillars: ["speakable", "faq_schema", "author_eat"],
    fixProposalJson: { page: "/heat-pumps", fixes: ["Add FAQPage schema with 6 Q&A", "Add speakable markup to pricing section", "Author byline + credentials"] },
    expectedLift: 0.22,
    status: "proposed",
  },
});
await prisma.aeoAction.create({
  data: {
    workspaceId: ws,
    kind: "third_party_plan",
    sourceRef: "southernhomeandliving.example",
    actionPlanJson: { steps: ["Pitch updated heat-pump cost data to editor", "Offer expert quote for seasonal guide", "Request author bio link to /heat-pumps"], owner: "human" },
    expectedLift: 0.14,
    status: "proposed",
  },
});
console.log("AEO seeded: prompt set, 4 engine runs, mentions, source impact, 2 actions");

// --- Pending approvals (visible on the command-center badge) ----------------------
const approvalRows: Array<{ type: "review_reply_post" | "aeo_content_fix"; bindingJson: Record<string, unknown> }> = [
  {
    type: "review_reply_post",
    bindingJson: {
      kind: "review_reply_post",
      locationRef: "demo-gso-main",
      reviewId: "demo-rev-002",
      replyText: "We're sorry about the delayed callback during the heat wave. We'd like to make this right — please call us at (336) 555-0147.",
      channel: "gbp",
    },
  },
  {
    type: "aeo_content_fix",
    bindingJson: {
      kind: "aeo_content_fix",
      page: "/heat-pumps",
      pillars: ["speakable", "faq_schema", "author_eat"],
      diffSummary: "Add FAQPage schema, speakable markup, author byline",
    },
  },
];
for (const a of approvalRows) {
  const created = await prisma.authorityApproval.create({
    data: {
      workspaceId: ws,
      type: a.type,
      status: "pending",
      bindingJson: a.bindingJson as unknown as Parameters<typeof prisma.authorityApproval.create>[0]["data"]["bindingJson"],
      bindingHash: bindingHashOf(a.bindingJson),
      createdBy: userId,
      approversJson: [],
      twoPersonRequired: a.type === "review_reply_post",
    },
  });
  await prisma.authorityApprovalEvent.create({
    data: {
      approvalId: created.id,
      workspaceId: ws,
      actor: userId,
      action: "submitted",
      payloadHash: sha(`${created.id}-submitted`),
      prevHash: "genesis",
      eventHash: sha(`${created.id}-event`),
    },
  });
}
console.log("approvals seeded: 2 pending");

// --- I1: Intelligence Report (real generator, finalized) -------------------------
const { compileReport, setReportStatus } = await import("@/lib/authority/intelligence/reports");
const { report } = await compileReport(ws, userId);
await setReportStatus(report.id, ws, userId, "ready");
const check = await prisma.intelligenceReport.findUnique({ where: { id: report.id } });
const audits = (check?.auditsJson as unknown[]) ?? [];
const plan = (check?.plan90dJson ?? {}) as { initiatives?: unknown[] };
console.log(`intelligence report ready: ${check?.id} — ${audits.length} audits, ${(check?.opportunitiesJson as unknown[])?.length ?? 0} opportunities, ${plan.initiatives?.length ?? 0} initiatives`);

console.log("\nPhase 6 demo seed complete.");
