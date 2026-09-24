// Marketr — Physical attribution kit (P2) verification battery.
//
// Run against a FRESH database:
//   dropdb --if-exists marketr_pa && createdb marketr_pa
//   DATABASE_URL=<redacted>
//     npx prisma migrate deploy
//   DATABASE_URL=<redacted>
//     npx tsx scripts/verify-physical-attribution.mts
// Run 3x green on fresh DBs before calling this done.
//
// Covers:
//   B1  bundle create provisions all four artifacts (number via fake
//       provider, QR generatable, vanity slug, WAVE- promo code)
//   B2  slug uniqueness: same-workspace conflict auto-suffixed; slugs are
//       GLOBALLY unique (cross-workspace conflict auto-suffixed) so
//       /r/<slug> resolves deterministically
//   B3  /r/<slug>: 302 + scan logged + UTM defaults merged; scan-query params
//       win over destination params on conflict; double-scan same day collapses
//   B4  unknown slug → 404 (no scan); disabled bundle → 410 (no scan)
//   B5  identified scan (?lead=) logs a qr_code touch before redirect;
//       foreign lead id logs no touch
//   B6  promo redeem: new lead creation, touch + redemption row, idempotent
//       re-redeem, match existing lead by phone, invalid/disabled code errors
//   B7  promoCode on lead creation (applyPromoCodeToLead) and on the public
//       form (handlePublicSubmit) logs the promo_code touch; bad codes are
//       silently ignored
//   B8  tenant isolation: bundles/stats/promo scoped per workspace
//   B9  attribution models credit qr_code/promo_code touches
//       (first/last/linear splits) via getAttributionReport
//   B10 public redeem route: 201 / 404 / 400 / 429 (rate limit)
//   B11 /r route handler: 302 redirect, 404 unknown
//   B12 bundleStats: scans/calls/redemptions/leads/revenue
//   B13 invalid destination URL rejected
//
// Strategy: exercise the real lib modules; the two public route handlers
// are exercised directly with fabricated Requests.

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}
process.env.CALLS_PROVIDER = "fake";

import { randomUUID } from "node:crypto";

const { prisma } = await import("@/lib/prisma");
const stages = await import("@/lib/crm/stages");
const dedup = await import("@/lib/crm/dedup");
const pubform = await import("@/lib/crm/public-form");
const { createLeadRecord } = await import("@/lib/crm/leads");
const touchesLib = await import("@/lib/attribution/touches");
const reportLib = await import("@/lib/attribution/report");
const bundlesLib = await import("@/lib/physical/bundles");
const qrLib = await import("@/lib/physical/qr");
const { POST: redeemPOST } = await import("@/app/api/attribution/bundles/redeem/route");
const { GET: vanityGET } = await import("@/app/r/[slug]/route");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const RUN = `zz-pa-battery-${Date.now()}-${process.pid}`;
const tag = (s: string) => `${RUN}-${s}`;

async function makeWorkspace() {
  return prisma.workspace.create({
    data: { name: tag("ws"), ownerUserId: `battery-${process.pid}` },
  });
}
async function makePipeline(workspaceId: string, name: string) {
  return prisma.pipeline.create({
    data: { workspaceId, name, stages: stages.DEFAULT_STAGES as never },
  });
}
async function mustCreate(workspaceId: string, actor: string, input: Parameters<typeof createLeadRecord>[2]) {
  const res = await createLeadRecord(workspaceId, actor, input);
  if (!res.ok) throw new Error(`createLeadRecord failed: ${res.error}`);
  return res.lead;
}
function redeemReq(body: unknown) {
  return new Request("http://localhost/api/attribution/bundles/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "9.9.9.9" },
    body: JSON.stringify(body),
  });
}
function vanityReq(slug: string, query = "") {
  return new Request(`http://localhost/r/${slug}${query}`, {
    headers: { "x-forwarded-for": "9.9.9.9", "user-agent": "battery" },
  });
}

const wsA = await makeWorkspace();
const wsB = await makeWorkspace();
const pipeA = await makePipeline(wsA.id, tag("pipe-a"));
const pipeB = await makePipeline(wsB.id, tag("pipe-b"));

// ── B1: one-click bundle creation ───────────────────────────────────────────
const bundleA = await bundlesLib.createBundle({
  workspaceId: wsA.id,
  name: tag("Fall Mailer"),
  campaignName: tag("fall-mailer-2026"),
  destinationUrl: "https://example.com/offer?ref=print",
  areaCode: "336",
});
check("bundle create returns all four artifacts",
  !!bundleA.id && !!bundleA.number?.e164 && !!bundleA.vanitySlug && /^WAVE-[A-Z2-9]{6}$/.test(bundleA.promoCode),
  JSON.stringify([bundleA.number?.e164, bundleA.vanitySlug, bundleA.promoCode]));
check("tracking number row created via fake provider",
  bundleA.number!.e164.startsWith("+1") || bundleA.number!.e164.startsWith("+"),
  bundleA.number!.e164);
const qrData = await qrLib.qrPngDataUrl(`https://x.test/r/${bundleA.vanitySlug}`, bundleA.qrStyle);
check("QR PNG generates", qrData.startsWith("data:image/png;base64,"));
const qrSvg = await qrLib.qrSvgString(`https://x.test/r/${bundleA.vanitySlug}`, bundleA.qrStyle);
check("QR SVG generates", qrSvg.includes("<svg"));
const numRow = await prisma.callNumber.findUnique({ where: { id: bundleA.numberId! } });
check("number carries bundle campaign label", numRow?.campaign === tag("fall-mailer-2026"));

// ── B2: slug uniqueness ─────────────────────────────────────────────────────
const same1 = await bundlesLib.createBundle({
  workspaceId: wsA.id, name: tag("Same"), campaignName: tag("c1"),
  destinationUrl: "https://example.com/a", vanitySlug: tag("shared-slug"),
});
const same2 = await bundlesLib.createBundle({
  workspaceId: wsA.id, name: tag("Same"), campaignName: tag("c2"),
  destinationUrl: "https://example.com/b", vanitySlug: tag("shared-slug"),
});
check("same-workspace slug conflict auto-suffixed", same1.vanitySlug !== same2.vanitySlug);
const crossWs = await bundlesLib.createBundle({
  workspaceId: wsB.id, name: tag("Cross"), campaignName: tag("c3"),
  destinationUrl: "https://example.com/c", vanitySlug: tag("shared-slug"),
});
check("cross-workspace slug conflict auto-suffixed (global uniqueness)",
  crossWs.vanitySlug !== bundlesLib.slugifyName(tag("shared-slug")) &&
  crossWs.vanitySlug.startsWith(bundlesLib.slugifyName(tag("shared-slug")) + "-"));
// A second explicit duplicate in the SAME workspace also suffixes.
const same3 = await bundlesLib.createBundle({
  workspaceId: wsA.id, name: tag("Same"), campaignName: tag("c4"),
  destinationUrl: "https://example.com/d", vanitySlug: tag("shared-slug"),
});
check("third duplicate also auto-suffixed",
  same3.vanitySlug !== same1.vanitySlug && same3.vanitySlug !== same2.vanitySlug);

// ── B3: vanity redirect + scans + UTM handling ──────────────────────────────
const r1 = await bundlesLib.handleVanityRedirect({
  slug: bundleA.vanitySlug, ip: "1.2.3.4", query: new URLSearchParams(), userAgent: "t", referer: null,
});
check("vanity redirect 302s", r1.status === 302 && !!r1.location, String(r1.status));
const loc1 = new URL(r1.location!);
check("UTM defaults merged into destination",
  loc1.searchParams.get("utm_source") === "physical" &&
  loc1.searchParams.get("utm_medium") === "qr" &&
  loc1.searchParams.get("utm_campaign") === tag("fall-mailer-2026"));
check("existing destination params preserved", loc1.searchParams.get("ref") === "print");
const r2 = await bundlesLib.handleVanityRedirect({
  slug: bundleA.vanitySlug, ip: "1.2.3.4", query: new URLSearchParams("utm_source=mailer"),
  userAgent: "t", referer: null,
});
check("UTM passthrough: scan params fill gaps",
  new URL(r2.location!).searchParams.get("utm_source") === "mailer");
// Pin the conflict precedence: scan-query params (placement tagging) win
// over params already on the destination URL; bundle defaults fill the rest.
const conflict = bundlesLib.mergeUtms(
  "https://example.com/e?utm_source=destination&utm_medium=web",
  { utmSource: "physical", utmMedium: "qr", utmCampaign: "camp" },
  new URLSearchParams("utm_source=flyer&x=1&lead=abc"),
);
const cu = new URL(conflict);
check("UTM conflict: scan param wins over destination param",
  cu.searchParams.get("utm_source") === "flyer" &&
  cu.searchParams.get("utm_medium") === "web" &&
  cu.searchParams.get("utm_campaign") === "camp" &&
  cu.searchParams.get("x") === "1" &&
  !cu.searchParams.has("lead"),
  conflict);
const scansAfterDup = await prisma.bundleScan.count({ where: { bundleId: bundleA.id } });
check("double-scan same IP/day collapses to one", scansAfterDup === 1, String(scansAfterDup));
await bundlesLib.handleVanityRedirect({
  slug: bundleA.vanitySlug, ip: "5.6.7.8", query: new URLSearchParams(), userAgent: "t", referer: null,
});
check("new IP counts a new scan",
  (await prisma.bundleScan.count({ where: { bundleId: bundleA.id } })) === 2);
check("scan stores hashed IP, not raw",
  (await prisma.bundleScan.findFirst({ where: { bundleId: bundleA.id } }))?.ipHash !== "1.2.3.4");

// ── B4: unknown / disabled ──────────────────────────────────────────────────
const r404 = await bundlesLib.handleVanityRedirect({
  slug: tag("no-such-slug"), ip: "1.2.3.4", query: new URLSearchParams(), userAgent: "t", referer: null,
});
check("unknown slug 404s without logging", r404.status === 404 && !r404.scanLogged);
await bundlesLib.setBundleStatus(wsA.id, bundleA.id, "disabled");
const r410 = await bundlesLib.handleVanityRedirect({
  slug: bundleA.vanitySlug, ip: "9.9.9.99", query: new URLSearchParams(), userAgent: "t", referer: null,
});
check("disabled bundle 410s without logging", r410.status === 410 && !r410.scanLogged);
check("disabled scan not counted",
  (await prisma.bundleScan.count({ where: { bundleId: bundleA.id } })) === 2);
await bundlesLib.setBundleStatus(wsA.id, bundleA.id, "active");

// ── B5: identified scan logs a qr_code touch ────────────────────────────────
const idLead = await mustCreate(wsA.id, "battery", {
  pipelineId: pipeA.id, name: tag("scan-lead"), source: "other",
});
const rId = await bundlesLib.handleVanityRedirect({
  slug: bundleA.vanitySlug, ip: "7.7.7.7",
  query: new URLSearchParams(`lead=${idLead.id}`), userAgent: "t", referer: null,
});
check("identified scan 302s", rId.status === 302);
const idTouch = await prisma.attributionTouch.findFirst({
  where: { leadId: idLead.id, channel: "qr_code" },
});
check("identified scan logs qr_code touch before redirect",
  !!idTouch && idTouch.source === "vanity-url" && idTouch.campaign === tag("fall-mailer-2026"),
  JSON.stringify(idTouch ? [idTouch.channel, idTouch.source] : null));
check("touch reports touchLogged", rId.touchLogged === true);
check("identification param is not forwarded to destination",
  !new URL(rId.location!).searchParams.has("lead"));
const foreignLead = await mustCreate(wsB.id, "battery", {
  pipelineId: pipeB.id, name: tag("foreign"), source: "other",
});
const rForeign = await bundlesLib.handleVanityRedirect({
  slug: bundleA.vanitySlug, ip: "8.8.8.8",
  query: new URLSearchParams(`lead=${foreignLead.id}`), userAgent: "t", referer: null,
});
check("foreign lead id redirects but logs no touch",
  rForeign.status === 302 && !rForeign.touchLogged &&
  (await prisma.attributionTouch.count({ where: { leadId: foreignLead.id } })) === 1); // only capture touch

// ── B6: promo redemption ────────────────────────────────────────────────────
const red1 = await bundlesLib.redeemPromoCode({
  code: bundleA.promoCode, email: tag("redeem@example.com"), name: tag("Redeemer"), ip: "1.1.1.1",
});
check("redeem creates lead + returns bundle", red1.created && red1.bundleId === bundleA.id);
const redTouch = await prisma.attributionTouch.findFirst({
  where: { leadId: red1.leadId, channel: "promo_code" },
});
check("redeem logs promo_code touch",
  !!redTouch && redTouch.campaign === tag("fall-mailer-2026") && redTouch.medium === "promo",
  JSON.stringify(redTouch ? [redTouch.channel, redTouch.campaign] : null));
check("redemption row recorded",
  (await prisma.bundleRedemption.count({ where: { bundleId: bundleA.id, leadId: red1.leadId } })) === 1);
const red2 = await bundlesLib.redeemPromoCode({
  code: bundleA.promoCode, email: tag("redeem@example.com"), ip: "1.1.1.1",
});
check("re-redeem is idempotent (same lead, no dup redemption)",
  !red2.created && red2.leadId === red1.leadId &&
  (await prisma.bundleRedemption.count({ where: { bundleId: bundleA.id } })) === 1);
const phoneLead = await mustCreate(wsA.id, "battery", {
  pipelineId: pipeA.id, name: tag("phone-lead"), phone: "+13365550199", source: "other",
});
const red3 = await bundlesLib.redeemPromoCode({
  code: bundleA.promoCode.toLowerCase(), phone: "(336) 555-0199", ip: "2.2.2.2",
});
check("redeem matches existing lead by phone (case-insensitive code)",
  !red3.created && red3.leadId === phoneLead.id);
let badCode = "";
try { await bundlesLib.redeemPromoCode({ code: "WAVE-XXXXXX", email: tag("x@x.com"), ip: "3.3.3.3" }); }
catch (e) { badCode = e instanceof Error ? e.message : ""; }
check("invalid code rejected", badCode === "Invalid or expired promo code", badCode);
await bundlesLib.setBundleStatus(wsA.id, bundleA.id, "disabled");
let disabledCode = "";
try { await bundlesLib.redeemPromoCode({ code: bundleA.promoCode, email: tag("y@y.com"), ip: "4.4.4.4" }); }
catch (e) { disabledCode = e instanceof Error ? e.message : ""; }
check("disabled bundle code rejected", disabledCode === "Invalid or expired promo code");
await bundlesLib.setBundleStatus(wsA.id, bundleA.id, "active");
let noContact = "";
try { await bundlesLib.redeemPromoCode({ code: bundleA.promoCode, ip: "5.5.5.5" }); }
catch (e) { noContact = e instanceof Error ? e.message : ""; }
check("redeem requires email or phone", noContact.includes("Email or phone"));

// ── B7: promoCode on lead creation + public form ────────────────────────────
const bundleB = await bundlesLib.createBundle({
  workspaceId: wsA.id, name: tag("Event"), campaignName: tag("event-2026"),
  destinationUrl: "https://example.com/event",
});
const leadRes = await mustCreate(wsA.id, "battery", {
  pipelineId: pipeA.id, name: tag("api-lead"), email: tag("api@example.com"), source: "website_form",
});
const applied = await bundlesLib.applyPromoCodeToLead(wsA.id, leadRes.id, bundleB.promoCode);
check("applyPromoCodeToLead attaches bundle",
  applied?.campaignName === tag("event-2026"));
const apiTouch = await prisma.attributionTouch.findFirst({
  where: { leadId: leadRes.id, channel: "promo_code" },
});
check("lead-form promo logs promo_code touch with bundle campaign",
  !!apiTouch && apiTouch.campaign === tag("event-2026"));
const ignored = await bundlesLib.applyPromoCodeToLead(wsA.id, leadRes.id, "WAVE-BOGUS1");
check("bad promo code silently ignored (lead survives)", ignored === null);

// Public form path
pubform.resetPublicFormLimiter();
const { token, prefix } = dedup.newFormToken();
await prisma.leadCaptureForm.create({
  data: { workspaceId: wsA.id, pipelineId: pipeA.id, name: tag("form"), tokenHash: dedup.hashFormToken(token), tokenPrefix: prefix },
});
const pfRes = await pubform.handlePublicSubmit({
  token,
  rawBody: JSON.stringify({ name: tag("pf-lead"), email: tag("pf@example.com"), promoCode: bundleB.promoCode }),
  ip: "9.9.9.10",
});
check("public form accepts promoCode", pfRes.status === 201, String(pfRes.status));
const pfLead = await prisma.lead.findFirst({ where: { workspaceId: wsA.id, email: tag("pf@example.com") } });
const pfTouch = pfLead
  ? await prisma.attributionTouch.findFirst({ where: { leadId: pfLead.id, channel: "promo_code" } })
  : null;
check("public form promo logs promo_code touch", !!pfTouch && pfTouch.campaign === tag("event-2026"));

// ── B8: tenant isolation ────────────────────────────────────────────────────
const wsBList = await bundlesLib.listBundles(wsB.id);
check("list is workspace-scoped", wsBList.every((b) => b.workspaceId === wsB.id) && !wsBList.some((b) => b.id === bundleA.id));
check("getBundle cross-workspace returns null", (await bundlesLib.getBundle(wsB.id, bundleA.id)) === null);
const crossApply = await bundlesLib.applyPromoCodeToLead(wsB.id, foreignLead.id, bundleA.promoCode);
check("promo code not redeemable from another workspace", crossApply === null);

// ── B9: models credit qr_code / promo_code touches ──────────────────────────
const wonLead = await mustCreate(wsA.id, "battery", {
  pipelineId: pipeA.id, name: tag("won"), source: "other", stage: "won", valueCents: 30000,
});
const t0 = new Date("2026-09-01T10:00:00Z");
// Remove the automatic capture touch so the test journey is exactly:
// qr_code (first) → website → promo_code (last).
await prisma.attributionTouch.deleteMany({ where: { leadId: wonLead.id } });
await touchesLib.logTouch({ workspaceId: wsA.id, leadId: wonLead.id, channel: "qr_code", source: "vanity-url", medium: "qr", campaign: tag("fall-mailer-2026"), touchType: "visit", occurredAt: new Date(t0.getTime()) });
await touchesLib.logTouch({ workspaceId: wsA.id, leadId: wonLead.id, channel: "website", touchType: "visit", occurredAt: new Date(t0.getTime() + 3600_000) });
await touchesLib.logTouch({ workspaceId: wsA.id, leadId: wonLead.id, channel: "promo_code", source: "promo", medium: "promo", campaign: tag("fall-mailer-2026"), touchType: "form", occurredAt: new Date(t0.getTime() + 7200_000) });
const { report } = await reportLib.getAttributionReport(wsA.id, { from: new Date("2026-01-01") });
const rev = (m: "first_touch" | "last_touch" | "linear", ch: string) =>
  report[m].channels.find((c) => c.channel === ch)?.revenueCents ?? -1;
check("first_touch credits qr_code $300", rev("first_touch", "qr_code") >= 30000, String(rev("first_touch", "qr_code")));
check("last_touch credits promo_code $300", rev("last_touch", "promo_code") >= 30000, String(rev("last_touch", "promo_code")));
// 3 touches → $100 each.
check("linear splits across all three touches",
  rev("linear", "qr_code") === 10000 && rev("linear", "promo_code") === 10000 && rev("linear", "website") === 10000,
  String([rev("linear", "qr_code"), rev("linear", "promo_code"), rev("linear", "website")]));
check("first_touch campaign row carries the bundle campaign",
  (report.first_touch.campaigns.find((c) => c.campaign === tag("fall-mailer-2026"))?.revenueCents ?? 0) === 30000);

// ── B10: public redeem route ────────────────────────────────────────────────
bundlesLib.resetRedeemRateLimits();
const rr1 = await redeemPOST(redeemReq({ code: bundleB.promoCode, email: tag("route@example.com"), name: "R" }));
check("redeem route 201", rr1.status === 201, String(rr1.status));
const rrBad = await redeemPOST(redeemReq({ code: "WAVE-NOPE12", email: tag("z@z.com") }));
check("redeem route 404s invalid code (no oracle)", rrBad.status === 404, String(rrBad.status));
const rrNoContact = await redeemPOST(redeemReq({ code: bundleB.promoCode }));
check("redeem route 400s without contact", rrNoContact.status === 400, String(rrNoContact.status));
bundlesLib.resetRedeemRateLimits();
let saw429 = false;
for (let i = 0; i < 12; i++) {
  const r = await redeemPOST(redeemReq({ code: bundleB.promoCode, email: tag(`rl${i}@x.com`) }));
  if (r.status === 429) { saw429 = true; break; }
}
check("redeem route rate-limits (429)", saw429);

// ── B11: /r route handler ───────────────────────────────────────────────────
const vr = await vanityGET(vanityReq(bundleB.vanitySlug), { params: Promise.resolve({ slug: bundleB.vanitySlug }) });
check("/r handler 302s", vr.status === 302 && !!vr.headers.get("location"), String(vr.status));
const vr404 = await vanityGET(vanityReq(tag("missing")), { params: Promise.resolve({ slug: tag("missing") }) });
check("/r handler 404s unknown slug", vr404.status === 404, String(vr404.status));

// ── B12: bundleStats ────────────────────────────────────────────────────────
const stats = await bundlesLib.bundleStats(bundleA, { from: new Date("2026-01-01") });
check("stats: scans counted", stats.scans === 4, String(stats.scans));
check("stats: calls counted", stats.calls === 0, String(stats.calls));
check("stats: redemptions counted", stats.redemptions === 2, String(stats.redemptions));
// Bundle campaign touches: qr_code (first) + promo_code (last) = $300 each;
// linear: $100 × 2 campaign touches.
check("stats: attributed revenue flows per model",
  stats.revenueCents.first_touch === 30000 &&
  stats.revenueCents.last_touch === 30000 &&
  stats.revenueCents.linear === 20000,
  JSON.stringify(stats.revenueCents));

// ── B13: invalid destination rejected ───────────────────────────────────────
let badDest = "";
try {
  await bundlesLib.createBundle({
    workspaceId: wsA.id, name: tag("bad"), campaignName: tag("bad"),
    destinationUrl: "ftp://example.com/x",
  });
} catch (e) { badCode = ""; badDest = e instanceof Error ? e.message : ""; }
check("non-http destination rejected", /http/.test(badDest), badDest);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:", failures.join(", "));
  process.exit(1);
}
await prisma.$disconnect();
