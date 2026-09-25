// Marketr — Phase 4 demo data for the preview server / screenshots.
// Seeds: Studio creatives (addressed + EDDM, PDF-attached + ready), a full
// mail campaign run end-to-end in FAKE/TEST mode (nothing physically mails),
// and an EDDM concierge order with a generated mailhouse brief.
// Run:  DATABASE_URL=... npx tsx scripts/seed-demo-phase4.mts

const fs = await import("node:fs");
const envFile = fs.readFileSync(".env", "utf8");
const adminEmail = (envFile.match(/^ADMIN_EMAIL=(.*)$/m)?.[1] ?? "")
  .replace(/^"|"$/g, "")
  .trim()
  .toLowerCase();
if (!adminEmail) throw new Error("ADMIN_EMAIL missing in .env");
const userId = `admin:${adminEmail}`;

const { prisma } = await import("@/lib/prisma");
const creatives = await import("@/lib/studio/creatives");
const mailSvc = await import("@/lib/mail/service");
const eddm = await import("@/lib/mail/eddm");
const { generateEddmBriefPdf } = await import("@/lib/mail/eddm-brief");

// --- minimal one-page PDF with an exact MediaBox (points) -------------------
function demoPdf(widthIn: number, heightIn: number, label: string): Buffer {
  const w = Math.round(widthIn * 72);
  const h = Math.round(heightIn * 72);
  const content = `BT /F1 18 Tf 36 ${h - 60} Td (${label}) Tj ET`;
  const objs = [
    `1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj`,
    `2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj`,
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj`,
    `4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj`,
    `5 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const o of objs) {
    offsets.push(pdf.length);
    pdf += o + "\n";
  }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

// --- workspace ---------------------------------------------------------------
const wsRow = await prisma.workspace.findFirst({ where: { ownerUserId: userId } });
if (!wsRow) throw new Error("No workspace for admin user — run phase3 seed first");
const ws = wsRow;
console.log("workspace", ws.id);

// --- Studio creatives ----------------------------------------------------------
async function ensureCreative(
  name: string,
  formatTrack: string,
  size: string,
  widthIn: number,
  heightIn: number,
) {
  const existing = await prisma.mailCreative.findFirst({
    where: { workspaceId: ws.id, name },
  });
  if (existing?.creativeHash) {
    console.log("creative exists:", name);
    return existing;
  }
  const c = existing ??
    (await creatives.createCreative(prisma as never, ws.id, {
      name,
      channelTemplate: "print",
      formatTrack,
      size,
      source: "upload",
      createdBy: userId,
    } as never));
  const pdf = demoPdf(widthIn, heightIn, name);
  await creatives.setCreativePdf(prisma as never, ws.id, c.id, pdf, {
    createdBy: userId,
  });
  await creatives.markReady(prisma as never, ws.id, c.id, {
    attested: true,
    attestedBy: userId,
  });
  console.log("creative ready:", name);
  return c;
}

const addressed = await ensureCreative(
  "Spring Tune-Up — 4x6 Postcard",
  "addressed",
  "4x6_postcard",
  6,
  4,
);
const eddmFlat = await ensureCreative(
  "Neighborhood Offer — EDDM Flat",
  "eddm",
  "eddm_flat",
  11.5,
  6.5,
);

// --- mail campaign: full fake-mode loop -----------------------------------------
let campaign = await prisma.mailCampaign.findFirst({
  where: { workspaceId: ws.id, name: "March Service Reminder" },
});
if (!campaign) {
  campaign = await prisma.mailCampaign.create({
    data: {
      workspaceId: ws.id,
      name: "March Service Reminder",
      creativeId: addressed.id,
      status: "draft",
      audienceSource: { kind: "csv", note: "Phase 4 demo seed" },
    },
  });
  console.log("campaign created", campaign.id);
}
const pieceCount = await prisma.mailPiece.count({ where: { campaignId: campaign.id } });
if (pieceCount === 0) {
  const rows = [
    { name: "Angela Foster", line1: "1201 Elm St", city: "Greensboro", state: "NC", zip: "27401" },
    { name: "Marcus Webb", line1: "4520 W Market St", city: "Greensboro", state: "NC", zip: "27407" },
    { name: "Dana Ruiz", line1: "1812 Spring Garden St", city: "Greensboro", state: "NC", zip: "27403" },
    { name: "Chris Bell", line1: "2907 Battleground Ave", city: "Greensboro", state: "NC", zip: "27408" },
    { name: "Priya Nair", line1: "3702 High Point Rd", city: "Greensboro", state: "NC", zip: "27407" },
    { name: "Tom Okafor", line1: "210 E Cornwallis Dr", city: "Greensboro", state: "NC", zip: "27408" },
  ];
  const built = await mailSvc.buildPieces(ws.id, campaign.id, { kind: "csv", rows });
  console.log("pieces built:", built.created);
  const verified = await mailSvc.verifyAddresses(ws.id, campaign.id);
  console.log("verified:", JSON.stringify(verified));
  const estimate = await mailSvc.estimateCampaign(ws.id, campaign.id);
  console.log(
    "estimate: sendable",
    estimate.sendablePieces,
    "totalWithMargin $",
    (estimate.totalWithMarginCents / 100).toFixed(2),
  );
  const { approval } = await mailSvc.requestApproval(ws.id, campaign.id, {
    requestedBy: userId,
  });
  await mailSvc.decideApproval(ws.id, approval.id, "approve", userId, "Demo approval — fake mode");
  console.log("approval granted", approval.id);
  const exec = await mailSvc.executeCampaign(ws.id, campaign.id);
  console.log(
    "executed: sent",
    exec.sent,
    "renderedOnly",
    exec.renderedOnly,
    "spend $",
    (exec.spendCents / 100).toFixed(2),
  );
} else {
  console.log("campaign pieces exist, skipping run (status preserved)");
}

// --- EDDM concierge order ---------------------------------------------------------
let order = await eddm.getEddmOrder(ws.id, "").catch(() => null);
const existing = await prisma.eddmOrder.findFirst({
  where: { workspaceId: ws.id, name: "Downtown Greensboro EDDM Drop" },
});
if (!existing) {
  order = await eddm.createEddmOrder({
    workspaceId: ws.id,
    name: "Downtown Greensboro EDDM Drop",
    mailhouse: "Demo Mailhouse Co.",
    createdBy: userId,
  });
  await eddm.setEddmRoutes(
    ws.id,
    order.id,
    [
      { zip: "27401", routeId: "C001", households: 482, selected: true },
      { zip: "27401", routeId: "C002", households: 517, selected: true },
      { zip: "27403", routeId: "C014", households: 463, selected: true },
      { zip: "27408", routeId: "C021", households: 529, selected: true },
    ],
    "retail",
  );
  await eddm.setEddmCreative(ws.id, order.id, eddmFlat.id);
  const { estimate } = await eddm.saveEddmEstimate(ws.id, order.id, {
    postageTier: "retail",
    printCentsPerPiece: 14,
  });
  console.log(
    "eddm estimate: pieces",
    estimate.pieceCount,
    "total $",
    (estimate.totalCents / 100).toFixed(2),
  );
  const brief = await generateEddmBriefPdf({
    workspaceId: ws.id,
    orderId: order.id,
    origin: "http://localhost:3000",
    actorUserId: userId,
  });
  console.log("eddm brief:", brief.pdfPath);
  await prisma.eddmOrder.update({
    where: { id: order.id },
    data: { status: "briefed", briefPdfUrl: brief.briefPdfUrl },
  });
  console.log("eddm order briefed");
} else {
  console.log("eddm order exists, skipping");
}

console.log("done");
await prisma.$disconnect();
