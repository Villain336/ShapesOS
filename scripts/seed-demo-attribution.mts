// Marketr — demo attribution data for the preview server / screenshots.
// Creates (or reuses) the admin user's workspace and seeds two measurement
// bundles with scans, a promo redemption, and won revenue so
// /dashboard/attribution renders with realistic data.
// Run:  CALLS_PROVIDER=fake npx tsx scripts/seed-demo-attribution.mts
// Needs DATABASE_URL in env (uses the preview .env when run from repo root).

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
process.env.CALLS_PROVIDER = "fake";

const fs = await import("node:fs");
const envFile = fs.readFileSync(".env", "utf8");
const adminEmail = (envFile.match(/^ADMIN_EMAIL=(.*)$/m)?.[1] ?? "")
  .replace(/^"|"$/g, "")
  .trim()
  .toLowerCase();
if (!adminEmail) throw new Error("ADMIN_EMAIL missing in .env");
const userId = `admin:${adminEmail}`;

const { prisma } = await import("@/lib/prisma");
const stages = await import("@/lib/crm/stages");
const { createLeadRecord } = await import("@/lib/crm/leads");
const touchesLib = await import("@/lib/attribution/touches");
const bundlesLib = await import("@/lib/physical/bundles");

// Workspace the admin login resolves to (mirrors getOrCreateWorkspace).
let ws = await prisma.workspace.findFirst({ where: { ownerUserId: userId } });
if (!ws) {
  ws = await prisma.workspace.create({
    data: {
      name: "Launchabl demo",
      ownerUserId: userId,
      plan: "self_hosted",
      members: { create: { userId, role: "owner" } },
    },
  });
  console.log("created workspace", ws.id);
} else {
  console.log("reusing workspace", ws.id);
}

let pipeline = await prisma.pipeline.findFirst({ where: { workspaceId: ws.id } });
if (!pipeline) {
  pipeline = await prisma.pipeline.create({
    data: { workspaceId: ws.id, name: "Sales", stages: stages.DEFAULT_STAGES as never },
  });
}

const existing = await prisma.attributionBundle.count({ where: { workspaceId: ws.id } });
if (existing >= 2) {
  console.log(`already have ${existing} bundles — skipping seed`);
  await prisma.$disconnect();
  process.exit(0);
}

async function mustCreateLead(input: Parameters<typeof createLeadRecord>[2]) {
  const res = await createLeadRecord(ws!.id, "demo-seed", input);
  if (!res.ok) throw new Error(`createLeadRecord failed: ${res.error}`);
  return res.lead;
}

// ── Bundle 1: Fall Mailer ───────────────────────────────────────────────────
const mailer = await bundlesLib.createBundle({
  workspaceId: ws.id,
  name: "Fall Mailer 2026",
  campaignName: "fall-mailer-2026",
  destinationUrl: "https://launchabl.example.com/fall-offer?utm_source=direct",
  areaCode: "336",
  vanitySlug: "fall-offer",
});
console.log("bundle:", mailer.vanitySlug, mailer.promoCode);

// Anonymous scans across a week of IPs.
const scanIps = ["203.0.113.11", "203.0.113.12", "198.51.100.7", "192.0.2.44", "203.0.113.98", "198.51.100.120"];
for (const ip of scanIps) {
  await bundlesLib.handleVanityRedirect({
    slug: mailer.vanitySlug, ip, query: new URLSearchParams(), userAgent: "demo", referer: null,
  });
}

// Identified scan → lead with qr_code touch.
const scanLead = await mustCreateLead({ pipelineId: pipeline.id, name: "Priya N.", email: "priya@example.com", source: "other" });
await bundlesLib.handleVanityRedirect({
  slug: mailer.vanitySlug, ip: "203.0.113.200",
  query: new URLSearchParams(`lead=${scanLead.id}`), userAgent: "demo", referer: null,
});

// Promo redemption → new lead + promo_code touch.
const red = await bundlesLib.redeemPromoCode({
  code: mailer.promoCode, email: "marcus@example.com", name: "Marcus T.", ip: "198.51.100.9",
});
console.log("redeemed:", red.created, "lead", red.leadId);

// Won deal: qr_code (first) → website → promo_code (last), $500.
const wonLead = await mustCreateLead({
  pipelineId: pipeline.id, name: "Denise W.", email: "denise@example.com",
  source: "other", stage: "won", valueCents: 50000,
});
await prisma.attributionTouch.deleteMany({ where: { leadId: wonLead.id } });
const t0 = new Date("2026-09-18T14:00:00Z");
await touchesLib.logTouch({ workspaceId: ws.id, leadId: wonLead.id, channel: "qr_code", source: "vanity-url", medium: "qr", campaign: "fall-mailer-2026", touchType: "visit", occurredAt: t0 });
await touchesLib.logTouch({ workspaceId: ws.id, leadId: wonLead.id, channel: "website", touchType: "visit", occurredAt: new Date(t0.getTime() + 26 * 3600_000) });
await touchesLib.logTouch({ workspaceId: ws.id, leadId: wonLead.id, channel: "promo_code", source: "promo", medium: "promo", campaign: "fall-mailer-2026", touchType: "form", occurredAt: new Date(t0.getTime() + 30 * 3600_000) });

// ── Bundle 2: Downtown Billboard (early traction, no revenue yet) ───────────
const board = await bundlesLib.createBundle({
  workspaceId: ws.id,
  name: "Downtown Billboard",
  campaignName: "downtown-billboard-q4",
  destinationUrl: "https://launchabl.example.com/billboard",
  areaCode: "336",
  vanitySlug: "downtown-deal",
});
for (const ip of ["203.0.113.31", "198.51.100.77"]) {
  await bundlesLib.handleVanityRedirect({
    slug: board.vanitySlug, ip, query: new URLSearchParams(), userAgent: "demo", referer: null,
  });
}
console.log("bundle:", board.vanitySlug, board.promoCode);

console.log("demo attribution data seeded");
await prisma.$disconnect();
