// Marketr — Phase 5 A1 verification battery.
//
//   npx tsx scripts/verify-phase5-attribution.mts
//
// Cases:
//   1. per-placement link create → scan event → ledger
//   2. promo-code redemption → ledger
//   3. CallRail webhook duplicate/out-of-order collapse
//   4. reconciliation: fake spend → ledger → variance 0 (+ approvalRef guard)
//   5. report card renders with caveats text present
//   6. QR render validation: good style passes, low-contrast fails closed
//   7. prisma fragment contains all five models
//
// Exit 0 = all pass. Any failure prints FAIL lines and exits 1.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { MemoryMediaStore, MissingApprovalRefError } = await import("../lib/media/store");
const links = await import("../lib/media/links");
const qr = await import("../lib/media/qr");
const promo = await import("../lib/media/promo");
const callrail = await import("../lib/media/callrail");
const recon = await import("../lib/media/reconciliation");
const report = await import("../lib/media/report");
const lift = await import("../lib/media/lift");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const WS = "ws_test_attribution";
const BUY = "buy_test_001";

// ---------------------------------------------------------------- 1. links
{
  const store = new MemoryMediaStore();
  const engine = new links.MarketrLinkEngine(store, "brand.link");

  const link = await engine.createLink({
    workspaceId: WS,
    buyId: BUY,
    placementRef: "board-47",
    destinationUrl: "https://acme.example/offer",
  });
  check("1a createLink mints slug", link.slug.startsWith("board-47-"), link.slug);
  check("1b UTM auto-tagged", link.utm.utm_source === "ooh" && link.utm.utm_content === "board-47", JSON.stringify(link.utm));
  check("1c publicUrl vanity", engine.publicUrl(link) === `https://brand.link/${link.slug}`);

  await engine.recordScan({ workspaceId: WS, slug: link.slug, userAgent: "ua", ip: "1.2.3.4" });
  await engine.recordScan({ workspaceId: WS, slug: link.slug, userAgent: "ua", ip: "1.2.3.4" });
  await engine.recordScan({ workspaceId: WS, slug: link.slug, userAgent: "ua2", ip: "5.6.7.8" });
  const a = await engine.getAnalytics(WS, link.slug);
  check("1d scans counted", a.scansCount === 3, `got ${a.scansCount}`);
  check("1e scan ledger rows", (await store.listScanEvents(link.id)).length === 3);
  check("1f unique IPs deduped", a.uniqueIpHashes === 2, `got ${a.uniqueIpHashes}`);
  check("1g raw IP never stored", (await store.listScanEvents(link.id)).every((e) => !/1\.2\.3\.4/.test(JSON.stringify(e))));

  const scan = await engine.recordScan({ workspaceId: WS, slug: link.slug });
  check("1h redirect carries UTM", scan !== null && scan.destination.includes("utm_source=ooh"), scan?.destination ?? "null");

  // dynamic destination: no reprint needed
  await engine.setDestination({ workspaceId: WS, linkId: link.id, destinationUrl: "https://acme.example/offer-v2" });
  const scan2 = await engine.recordScan({ workspaceId: WS, slug: link.slug });
  check("1i setDestination swaps target", scan2 !== null && scan2.destination.includes("offer-v2"));

  // campaign rollup via utm_content/tags
  await engine.createLink({ workspaceId: WS, buyId: BUY, placementRef: "shelter-main-st-03", destinationUrl: "https://acme.example/offer" });
  const roll = await engine.rollup(WS, BUY);
  check("1j campaign rollup", roll.links === 2 && roll.totalScans === 5, JSON.stringify({ links: roll.links, total: roll.totalScans }));

  // duplicate slug rejected; bad destination rejected
  let dupErr = "";
  try { await engine.createLink({ workspaceId: WS, buyId: BUY, placementRef: "board-47", slug: link.slug, destinationUrl: "https://acme.example/x" }); }
  catch (e) { dupErr = (e as Error).message; }
  check("1k duplicate slug rejected", dupErr.includes("already taken"), dupErr);
  check("1l placement guidance present", links.PLACEMENT_GUIDANCE.includes("dwell time"));

  // Dub adapter: fake in tests, analytics still local
  const dub = new links.DubLinkAdapter(store, "brand.link", { baseUrl: null });
  check("1m dub fake-mode not live", dub.live === false);
  const dl = await dub.createLink({ workspaceId: WS, buyId: BUY, placementRef: "dub-board-1", destinationUrl: "https://acme.example/d" });
  await dub.recordScan({ workspaceId: WS, slug: dl.slug });
  const da = await dub.getAnalytics(WS, dl.slug);
  check("1n dub analytics from local ledger", da.scansCount === 1);
}

// ---------------------------------------------------------------- 2. promo
{
  const store = new MemoryMediaStore();
  const svc = promo.createPromoService(store);
  const codes = await svc.generate({ workspaceId: WS, buyId: BUY, channelRefs: ["WXYZ-morning-drive", "gazette-full-page"], prefix: "FALL" });
  check("2a unique codes minted", codes.length === 2 && codes[0].code !== codes[1].code, codes.map((c) => c.code).join(","));
  check("2b code shape", codes.every((c) => /^[A-Z0-9][A-Z0-9-]{2,31}$/.test(c.code)));

  await svc.redeem(WS, codes[0].code, "order-1");
  await svc.redeem(WS, codes[0].code, "order-2");
  const after = (await store.getPromoCode(WS, codes[0].code))!;
  check("2c redemptions counted", after.redemptionsCount === 2, `got ${after.redemptionsCount}`);
  check("2d redemption ledger rows", (await store.listRedemptions(codes[0].id)).length === 2);

  let missErr = "";
  try { await svc.redeem(WS, "NOPE-0000"); } catch (e) { missErr = (e as Error).message; }
  check("2e unknown code rejected", missErr.includes("not found"), missErr);
}

// ---------------------------------------------------------------- 3. callrail
{
  const store = new MemoryMediaStore();
  const svc = callrail.createCallRailService(store, new callrail.FakeCallRailProvider());
  const num = await svc.provisionTrackingNumber({ workspaceId: WS, buyId: BUY, stationRef: "WXYZ-morning-drive", areaCode: "336" });
  check("3a number provisioned", /^\+1336\d{7}$/.test(num.numberE164), num.numberE164);

  const evt = (eventId: string, callId: string, type: string, occurredAt: string) => ({
    eventId, callId, type, trackingNumberE164: num.numberE164,
    callerE164: "+19195550100", durationSec: 95, occurredAt, raw: { eventId },
  });
  const body = (events: unknown[]) => JSON.stringify({ events });
  const post = (events: unknown[]) => {
    const rawBody = body(events);
    return svc.ingestWebhook({
      rawBody,
      signature: callrail.signFakeCallRailWebhook(rawBody),
      workspaceId: WS,
    });
  };

  const r1 = await post([evt("evt-a-started", "call-A", "started", "2026-09-20T10:00:00Z"), evt("evt-a-done", "call-A", "completed", "2026-09-20T10:02:00Z")]);
  check("3b webhook accepted", r1.accepted === true && r1.eventsApplied === 1, JSON.stringify(r1));

  // duplicate redelivery collapses
  const r2 = await post([evt("evt-a-done", "call-A", "completed", "2026-09-20T10:02:00Z")]);
  check("3c duplicate collapses", r2.accepted === true && r2.duplicate === true && r2.eventsApplied === 0, JSON.stringify(r2));

  // out-of-order: completed arrives before started — no downgrade, no double count
  const r3 = await post([
    evt("evt-b-done", "call-B", "completed", "2026-09-20T11:02:00Z"),
    evt("evt-b-started", "call-B", "started", "2026-09-20T11:00:00Z"),
  ]);
  check("3d out-of-order collapses", r3.accepted === true && r3.eventsApplied === 1, JSON.stringify(r3));

  const n = (await store.getCallNumberByE164(WS, num.numberE164))!;
  check("3e calls counted once each", n.callsCount === 2, `got ${n.callsCount}`);
  check("3f duration accumulated", n.totalDurationSec === 190, `got ${n.totalDurationSec}`);

  // bad signature → rejected
  const badRaw = body([evt("evt-x", "call-X", "completed", "2026-09-20T12:00:00Z")]);
  const rBad = await svc.ingestWebhook({ rawBody: badRaw, signature: "bogus", workspaceId: WS });
  check("3g bad signature rejected", rBad.accepted === false, JSON.stringify(rBad));

  // sweeper interface
  const stats = await svc.pollCallStats(WS, BUY);
  check("3h cost-per-call exposed", stats.calls === 2 && stats.costPerCallCents === 2500, JSON.stringify(stats));
}

// ---------------------------------------------------------------- 4. reconciliation
{
  const store = new MemoryMediaStore();
  const APPROVAL = "appr_test_001";
  await recon.recordSpend(store, { workspaceId: WS, buyId: BUY, kind: "estimate", amountCents: 25000, approvalRef: APPROVAL });
  await recon.recordSpend(store, { workspaceId: WS, buyId: BUY, kind: "encumbrance", amountCents: 25000, approvalRef: APPROVAL });
  await recon.recordSpend(store, { workspaceId: WS, buyId: BUY, kind: "spend", amountCents: 24850, approvalRef: APPROVAL });
  await recon.recordReceipt(store, { workspaceId: WS, buyId: BUY, platformInvoiceRef: "blip-inv-7781", amountCents: 24850, approvalRef: APPROVAL });

  const feed = new recon.FakePlatformSpendFeed();
  feed.seed([{ platform: "blip", invoiceRef: "blip-inv-7781", amountCents: 24850, periodStart: "2026-09-01", periodEnd: "2026-09-14" }]);
  const rep = await recon.reconcileBuy(store, feed, WS, BUY);
  check("4a variance 0", rep.varianceCents === 0, `got ${rep.varianceCents}`);
  check("4b within-rounding flag", rep.flags.some((f) => f.code === "WITHIN_ROUNDING"));
  check("4c no silent variance", rep.flags.some((f) => f.code === "VARIANCE") === false);

  // drift exercise: platform bills more than the ledger
  const feed2 = new recon.FakePlatformSpendFeed();
  feed2.seed([{ platform: "blip", invoiceRef: "blip-inv-7782", amountCents: 25100, periodStart: "2026-09-01", periodEnd: "2026-09-14" }]);
  const rep2 = await recon.reconcileBuy(store, feed2, WS, BUY);
  check("4d drift flagged", rep2.flags.some((f) => f.code === "VARIANCE") && rep2.varianceCents === 250, JSON.stringify(rep2.varianceCents));

  // approvalRef guard
  let guardErr = "";
  try {
    await recon.recordSpend(store, { workspaceId: WS, buyId: BUY, kind: "spend", amountCents: 100, approvalRef: "  " });
  } catch (e) { guardErr = (e as Error).name; }
  check("4e ledger rejects empty approvalRef", guardErr === "MissingApprovalRefError", guardErr);
  check("4f MissingApprovalRefError exported", MissingApprovalRefError !== undefined);
}

// ---------------------------------------------------------------- 5. report card
{
  const store = new MemoryMediaStore();
  const engine = new links.MarketrLinkEngine(store);
  const l = await engine.createLink({ workspaceId: WS, buyId: BUY, placementRef: "board-47", destinationUrl: "https://acme.example/o" });
  await engine.recordScan({ workspaceId: WS, slug: l.slug });
  const roll = await engine.rollup(WS, BUY);

  const svc = promo.createPromoService(store);
  const codes = await svc.generate({ workspaceId: WS, buyId: BUY, channelRefs: ["wxyz"] });
  await svc.redeem(WS, codes[0].code);

  const callSvc = callrail.createCallRailService(store, new callrail.FakeCallRailProvider());
  await callSvc.provisionTrackingNumber({ workspaceId: WS, buyId: BUY, stationRef: "wxyz" });

  const lp = new lift.FakeLiftProvider();
  const q = {
    brandQuery: "acme plumbing", baselineStart: "2026-07-20", baselineEnd: "2026-08-30",
    flightStart: "2026-09-01", flightEnd: "2026-09-14",
    boardMetros: ["raleigh"], holdoutMetros: ["charlotte"],
  };
  const [lr, direct, gbp] = await Promise.all([
    lift.computeLift(lp, q), lift.computeDirectTrafficLift(lp, q), lift.computeGbpLift(lp, q),
  ]);
  check("5a lift has holdout net", lr.hasHoldout === true && lr.netLiftPct !== null, String(lr.netLiftPct));

  await recon.recordSpend(store, { workspaceId: WS, buyId: BUY, kind: "spend", amountCents: 24850, approvalRef: "appr_1" });
  const rep = await recon.reconcileBuy(store, new recon.FakePlatformSpendFeed(), WS, BUY);

  const card = report.buildReportCard({
    buyId: BUY, buyLabel: "Test buy", flightStart: q.flightStart, flightEnd: q.flightEnd,
    links: roll, promo: promo.promoRollup(codes), calls: await callSvc.pollCallStats(WS, BUY),
    lift: lr, direct, gbp, recon: rep,
  });
  const html = report.renderReportCardHtml(card);
  const text = report.renderReportCardText(card);
  const missingHtml = report.ATTRIBUTION_CAVEATS.filter((c) => !html.includes(c));
  const missingText = report.ATTRIBUTION_CAVEATS.filter((c) => !text.includes(c));
  check("5b all caveats in HTML", missingHtml.length === 0, missingHtml.join(" | ").slice(0, 200));
  check("5c all caveats in text", missingText.length === 0, missingText.join(" | ").slice(0, 200));
  check("5d directional-not-causal printed", html.includes("Directional indicators, never causal claims."));
}

// ---------------------------------------------------------------- 6. QR validation
{
  const matrix = qr.encodeQr("https://brand.link/board-47-abc123", { errorCorrection: "H" });
  check("6a matrix encoded", matrix.size >= 21 && matrix.dark(0, 0) === true);

  const good = await qr.renderQr(matrix, {
    foreground: "#0B3D91", background: "#FFFFFF",
    dotStyle: "rounded", eyeStyle: "circle", quietZoneModules: 4,
    frame: { text: "Scan for 20% off" },
    logoDataUri: "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="%230B3D91"/></svg>').toString("base64"),
  });
  check("6b good style passes validation", good.validation.passed === true);
  check("6c PNG exported", good.png.length > 1000, `got ${good.png.length} bytes`);
  check("6d SVG exported", good.svg.includes("<svg") && good.svg.includes("Scan for 20% off"));

  let threw = "";
  try {
    await qr.renderQr(matrix, { foreground: "#888888", background: "#999999", quietZoneModules: 4 });
  } catch (e) { threw = (e as Error).message; }
  check("6e low-contrast fails closed", threw.includes("contrast"), threw.slice(0, 120));

  const v = qr.validateScannability(matrix, { foreground: "#000000", background: "#FFFFFF", quietZoneModules: 2 });
  check("6f quiet zone <4 fails", v.passed === false && v.checks.some((c) => c.name === "quiet_zone" && !c.passed));

  const v2 = qr.validateScannability(matrix, { foreground: "#000000", background: "#FFFFFF", quietZoneModules: 4, logoDataUri: "data:image/png;base64,AAA", logoSizePct: 60 });
  check("6g oversized logo fails finder check", v2.passed === false);

  const m2 = qr.encodeQr("https://brand.link/x", { errorCorrection: "M" });
  const v3 = qr.validateScannability(m2, { foreground: "#000000", background: "#FFFFFF", quietZoneModules: 4, logoDataUri: "data:image/png;base64,AAA" });
  check("6h logo without EC=H fails", v3.passed === false && v3.checks.some((c) => c.name === "error_correction" && !c.passed));

  const conv = await qr.renderCustomizedQr("https://brand.link/board-1", { foreground: "#111111", background: "#FFFFFF", dotStyle: "dots" });
  check("6i convenience render works", conv.validation.passed && conv.png.length > 1000);
}

// ---------------------------------------------------------------- 7. fragment
{
  const frag = readFileSync(resolve(ROOT, "prisma/fragments/phase5-attribution.prisma"), "utf8");
  for (const m of ["TrackingLink", "PromoCode", "CallNumber", "LiftSnapshot", "MediaReceipt", "ScanEvent", "RedemptionEvent", "CallWebhookEvent", "MediaSpendEntry"]) {
    check(`7 model ${m}`, frag.includes(`model ${m} {`), "missing");
  }
  check("7b workspace isolation", (frag.match(/workspaceId/g) ?? []).length >= 9);
  check("7c snake_case mapping", frag.includes('@@map("tracking_links")') && frag.includes('@map("workspace_id")'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
