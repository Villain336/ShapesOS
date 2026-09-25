// Marketr — Phase 7 F4 (CTV/commercials buying path) verification battery.
//
// Run: npx tsx scripts/verify-phase7-ctv.mts
// Run 3x green before calling the track done (spec §10, gate 7).
//
// Covers:
//   V1 ffprobe validator blocks non-compliant creative on fixtures
//      (wrong resolution, wrong duration, wrong loudness, letterboxed,
//      wrong codec) and passes a compliant :15.
//   V2 per-spot QR/pURL mint correctly and scan back to the spot
//      (Phase 5 engine extension).
//   V3 Vibe adapter without creds → honest not-configured error.
//   V4 Vibe test-mode never touches the real API (fetch spy).
//   V5 concierge pause → alert-only (no fake pause, no state change).
//   V6 budget-move attempt through the Vibe adapter → rejected + routed to F1.
//   V7 no deterministic ROAS rendered anywhere in the attribution view.
//   V8 workspace isolation on the F4 store.
//   V9 IO state machine: legal transitions pass, illegal ones throw;
//      MNTN honesty notes are present in the generated IO.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

let failures = 0;
let passes = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passes++; console.log(`  PASS ${name}${detail ? " — " + detail : ""}`); }
  else { failures++; console.error(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}
function section(name: string) { console.log(`\n## ${name}`); }

// ---------------------------------------------------------------------------
// Fixture generation (ffmpeg)
// ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "ctv-verify-"));

async function makeFixture(name: string, args: string[]): Promise<string> {
  const out = join(dir, name);
  await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, out]);
  return out;
}

async function fixtures() {
  // Compliant :15 — 1920×1080 H.264, 10 Mbps, stereo AAC 48 kHz @ −23 LUFS.
  // NOTE: testsrc alone compresses to ~1 Mbps (below the 6 Mbps ready-to-serve
  // floor); the noise filter makes the frame content incompressible so the
  // encoder actually delivers the 10 Mbps target like a real spot would.
  const good = await makeFixture("good.mp4", [
    "-f", "lavfi", "-i", "testsrc=duration=15:size=1920x1080:rate=30,noise=alls=30:allf=t",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=15:sample_rate=48000",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-b:v", "10M",
    "-c:a", "aac", "-ac", "2", "-ar", "48000",
    "-af", "loudnorm=I=-23:TP=-2:LRA=7",
    "-shortest",
  ]);
  // Wrong resolution.
  const badRes = await makeFixture("bad-res.mp4", [
    "-f", "lavfi", "-i", "testsrc=duration=15:size=1280x720:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=15:sample_rate=48000",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-b:v", "8M",
    "-c:a", "aac", "-ac", "2", "-ar", "48000",
    "-af", "loudnorm=I=-23:TP=-2:LRA=7",
    "-shortest",
  ]);
  // Wrong duration (20 s).
  const badDur = await makeFixture("bad-dur.mp4", [
    "-f", "lavfi", "-i", "testsrc=duration=20:size=1920x1080:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=20:sample_rate=48000",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-b:v", "10M",
    "-c:a", "aac", "-ac", "2", "-ar", "48000",
    "-af", "loudnorm=I=-23:TP=-2:LRA=7",
    "-shortest",
  ]);
  // Wrong loudness (−16 LUFS).
  const badLoud = await makeFixture("bad-loud.mp4", [
    "-f", "lavfi", "-i", "testsrc=duration=15:size=1920x1080:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=15:sample_rate=48000",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-b:v", "10M",
    "-c:a", "aac", "-ac", "2", "-ar", "48000",
    "-af", "loudnorm=I=-16:TP=-2:LRA=7",
    "-shortest",
  ]);
  // Letterboxed: 2.35:1 content padded into 16:9.
  const badBars = await makeFixture("bad-bars.mp4", [
    "-f", "lavfi", "-i", "testsrc=duration=15:size=1920x816:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=15:sample_rate=48000",
    "-vf", "pad=1920:1080:0:132:black",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-b:v", "10M",
    "-c:a", "aac", "-ac", "2", "-ar", "48000",
    "-af", "loudnorm=I=-23:TP=-2:LRA=7",
    "-shortest",
  ]);
  // Wrong codec (MPEG-4 Part 2 in MP4).
  const badCodec = await makeFixture("bad-codec.mp4", [
    "-f", "lavfi", "-i", "testsrc=duration=15:size=1920x1080:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=15:sample_rate=48000",
    "-c:v", "mpeg4", "-b:v", "10M",
    "-c:a", "aac", "-ac", "2", "-ar", "48000",
    "-af", "loudnorm=I=-23:TP=-2:LRA=7",
    "-shortest",
  ]);
  return { good, badRes, badDur, badLoud, badBars, badCodec };
}

// ---------------------------------------------------------------------------

import * as validator from "@/lib/flywheel/ctv/validator";
import * as spotKit from "@/lib/flywheel/ctv/spot-kit";
import * as concierge from "@/lib/flywheel/ctv/concierge";
import * as vibe from "@/lib/flywheel/ctv/vibe";
import * as attribution from "@/lib/flywheel/ctv/attribution";
import * as seats from "@/lib/flywheel/ctv/seats";
import * as ctvStore from "@/lib/flywheel/ctv/store";
import * as mediaStore from "@/lib/media/store";
import * as mediaLinks from "@/lib/media/links";

section("V1 — ffprobe validator blocks non-compliant creative");
const fx = await fixtures();
const good = await validator.validateCreative(fx.good);
ok("compliant :15 passes", good.pass, good.checks.filter((c) => !c.passed).map((c) => c.name).join(","));
const badRes = await validator.validateCreative(fx.badRes);
ok("1280×720 blocked", !badRes.pass && badRes.checks.some((c) => c.name === "resolution" && !c.passed));
const badDur = await validator.validateCreative(fx.badDur);
ok("20 s duration blocked", !badDur.pass && badDur.checks.some((c) => c.name === "duration" && !c.passed));
const badLoud = await validator.validateCreative(fx.badLoud);
ok("−16 LUFS blocked", !badLoud.pass && badLoud.checks.some((c) => c.name === "loudness" && !c.passed),
  badLoud.checks.find((c) => c.name === "loudness")?.detail ?? "");
const badBars = await validator.validateCreative(fx.badBars);
ok("letterboxed creative blocked", !badBars.pass && badBars.checks.some((c) => c.name === "no_black_bars" && !c.passed),
  badBars.checks.find((c) => c.name === "no_black_bars")?.detail ?? "");
const badCodec = await validator.validateCreative(fx.badCodec);
ok("mpeg4 codec blocked", !badCodec.pass && badCodec.checks.some((c) => c.name === "codec" && !c.passed));
let threw = false;
try { validator.assertCreativePasses(badRes); } catch { threw = true; }
ok("assertCreativePasses throws on failure", threw);

section("V2 — per-spot QR/pURL mint + scan back");
mediaStore.useMemoryMediaStore();
const mstore = mediaStore.getMediaStore();
const engine = new mediaLinks.MarketrLinkEngine(mstore, "tv.test.local");
const passValidation: validator.CreativeValidation = {
  pass: true, checks: [], durationSeconds: 15,
  publisherRulesVersion: "test", probe: {},
};
const kit = await spotKit.mintSpotKit({
  workspaceId: "ws_verify",
  campaignId: "camp_verify",
  campaignName: "Verify Flight",
  validation: passValidation,
  destinationUrl: "https://shop.example.com/tv",
  spots: [
    { placementLabel: "tubi-primetime", showGenre: "drama", daypart: "prime", demo: "25-54" },
    { placementLabel: "roku-daytime", showGenre: "news", daypart: "daytime", demo: "35-64" },
  ],
  domain: "tv.test.local",
}, engine);
ok("two spots minted with unique URLs", kit.spots.length === 2 && new Set(kit.spots.map((s) => s.publicUrl)).size === 2);
ok("couch-distance sizing", kit.spots.every((s) => s.qrWidthCm >= 25), `width=${kit.spots[0]?.qrWidthCm}cm`);
ok("QR svg rendered", kit.spots.every((s) => s.qrSvg.includes("<svg")));
let mintBlocked = false;
try {
  await spotKit.mintSpotKit({
    workspaceId: "ws_verify", campaignId: "camp_verify", campaignName: "x",
    validation: { ...passValidation, pass: false }, destinationUrl: "https://shop.example.com/tv",
    spots: [{ placementLabel: "x" }],
  }, engine);
} catch { mintBlocked = true; }
ok("kit minting blocked on failed validation", mintBlocked);
const slug = kit.spots[0]!.publicUrl.split("/").pop()!;
const scan = await engine.recordScan({ workspaceId: "ws_verify", slug, userAgent: "tv-test", ip: "10.0.0.9" });
ok("scan resolves to destination", !!scan && scan.destination.includes("utm_source=ctv"));
const analytics = await engine.getAnalytics("ws_verify", slug);
ok("scan counted in analytics", analytics.scansCount === 1 && analytics.uniqueIpHashes === 1);
const landing = await spotKit.checkLandingTaps("https://shop.example.com/tv");
ok("landing tap check runs", typeof landing.taps === "number");

section("V3 — Vibe without creds → honest not-configured");
{
  const cfg = vibe.resolveVibeConfig({ ...process.env, VIBE_TEST_MODE: "false", VIBE_CLIENT_ID: undefined, VIBE_CLIENT_SECRET: undefined, VIBE_API_TOKEN: undefined } as unknown as NodeJS.ProcessEnv);
  ok("test mode off without creds", cfg.testMode === false);
  const adapter = new vibe.VibeAdapter(cfg);
  let notConfigured = false;
  let msg = "";
  try { await adapter.listAdvertisers(); } catch (e) {
    notConfigured = e instanceof vibe.VibeNotConfiguredError;
    msg = e instanceof Error ? e.message : "";
  }
  ok("not-configured error raised", notConfigured);
  ok("error message is honest + guides setup", /not connected|no credentials/i.test(msg) && /developers\.vibe\.co/.test(msg));
  ok("revision pinned to verified spec", cfg.revision === "2026-06-01" && vibe.VIBE_API_REVISION === "2026-06-01");
}

section("V4 — Vibe test-mode never touches real spend");
{
  let networkCalls = 0;
  const spyFetch = (async () => { networkCalls++; throw new Error("network must not be touched in test mode"); }) as typeof fetch;
  const adapter = new vibe.VibeAdapter(vibe.resolveVibeConfig({ VIBE_TEST_MODE: "true" } as unknown as NodeJS.ProcessEnv), spyFetch);
  ok("test mode is the default", adapter.testMode === true);
  const created = await adapter.createCampaign({ advertiserId: "adv_1", name: "Test", approvalObjectId: "appr_1" });
  ok("test create succeeds locally", created.testMode === true && created.id.startsWith("vibe_test_"));
  const paused = await adapter.pauseCampaign(created.id, "appr_1");
  ok("test pause succeeds locally", paused.status === "PAUSED");
  const report = await adapter.campaignReport(created.id);
  ok("test report is labeled fixture", (report as { testMode: boolean }).testMode === true);
  ok("zero network calls in test mode", networkCalls === 0);
  ok("ops were logged to the test fake", adapter.testOpLog.length >= 3);
  let needsApproval = false;
  try { await adapter.createCampaign({ advertiserId: "adv_1", name: "No approval" } as never); } catch { needsApproval = true; }
  ok("mutations require an approval object", needsApproval);
}

section("V5 — concierge pause is alert-only");
{
  const store = ctvStore.createMemoryCtvStore();
  const camp = await store.createCampaign({
    workspaceId: "ws_verify", name: "Concierge Flight", platform: "mntn", mode: "concierge",
    status: "live", approvalObjectId: "appr_1", budgetCents: 500000, currency: "USD",
    flightStart: null, flightEnd: null, targetingJson: null, creativeIds: [], creativeHashes: [],
    vibeAdvertiserId: null, vibeCampaignId: null, vibeTestMode: true, vibeConfigRef: null, createdBy: "tester",
  });
  const alert = await concierge.requestConciergePause(store, "ws_verify", camp.id, "mntn", "tester", "CPA blowout");
  ok("pause returns an alert, not a pause", alert.alerted === true);
  ok("alert copy is the canonical copy", alert.copy === concierge.CONCIERGE_ALERT_ONLY_COPY);
  const after = await store.getCampaign("ws_verify", camp.id);
  ok("campaign status unchanged (still live)", after?.status === "live");
  const events = await store.auditList("ws_verify");
  ok("alert-only pause is audit-logged", events.some((e) => e.action === "concierge_pause_alerted"));
}

section("V6 — budget moves through the Vibe adapter are rejected → F1");
{
  const store = ctvStore.createMemoryCtvStore();
  const adapter = new vibe.VibeAdapter(vibe.resolveVibeConfig({ VIBE_TEST_MODE: "true" } as unknown as NodeJS.ProcessEnv));
  let rejected = false;
  let routed = "";
  try {
    adapter.rejectBudgetMove(store, "ws_verify", "tester", "updateStrategy budget DAILY 5000→8000");
  } catch (e) {
    rejected = e instanceof vibe.VibeBudgetMoveRejectedError;
    routed = (e as vibe.VibeBudgetMoveRejectedError).f1Route ?? "";
  }
  ok("budget move rejected", rejected);
  ok("rejection routes to F1", routed.includes("reallocation"));
  let updateBudgetRejected = false;
  try {
    await adapter.updateCampaign("vibe_test_camp_1", { name: "x", budget: 999 } as never, "appr_1");
  } catch (e) {
    updateBudgetRejected = e instanceof vibe.VibeBudgetMoveRejectedError;
  }
  ok("updateCampaign with budget field rejected", updateBudgetRejected);
}

section("V7 — no deterministic ROAS anywhere");
{
  const view = attribution.buildAttributionView({
    campaignId: "camp_verify",
    pixelUrl: "https://x/api/flywheel/ctv/pixel/p1?t=abc",
    pixelImpressions: 12000,
    viewThroughWindowDays: 14,
    conversionsInViewThroughWindow: 40,
    qrScans: 137,
    searchLift: { baselineDaily: [100, 102, 98, 101, 99, 100, 103], flightDaily: [118, 121, 115, 119, 122, 117, 120] },
    geoHoldout: { testDmas: ["Raleigh-Durham"], controlDmas: ["Charlotte"], plannedImpressions: 500000, expectedConversionRate: 0.002 },
  });
  let noRoas = false;
  try { attribution.assertNoDeterministicRoas(view); noRoas = true; } catch { noRoas = false; }
  ok("attribution view passes the no-deterministic-ROAS guard", noRoas);
  const json = JSON.stringify(view);
  ok("no 'roas' key in the view", !/"roas"/i.test(json));
  ok("probabilistic disclaimer present", json.includes("probabilistic"));
  ok("QR scans labeled deterministic slice", json.includes("deterministic slice"));
  ok("view-through labeled modeled", (view.layers.viewThrough.inference as string) === "device_graph_modeled");
  // The guard must actually fire on a violating payload.
  let guardFires = false;
  try { attribution.assertNoDeterministicRoas({ deterministic_roas: 4.2, probabilistic: true }); } catch { guardFires = true; }
  ok("guard fires on a deterministic-ROAS payload", guardFires);
}

section("V8 — workspace isolation");
{
  const store = ctvStore.createMemoryCtvStore();
  const camp = await store.createCampaign({
    workspaceId: "ws_a", name: "A", platform: "vibe", mode: "api",
    status: "draft", approvalObjectId: null, budgetCents: null, currency: "USD",
    flightStart: null, flightEnd: null, targetingJson: null, creativeIds: [], creativeHashes: [],
    vibeAdvertiserId: null, vibeCampaignId: null, vibeTestMode: true, vibeConfigRef: null, createdBy: null,
  });
  ok("cross-workspace read blocked", (await store.getCampaign("ws_b", camp.id)) === null);
  ok("own-workspace read works", (await store.getCampaign("ws_a", camp.id))?.id === camp.id);
}

section("V9 — IO state machine + honesty notes");
{
  const store = ctvStore.createMemoryCtvStore();
  const camp = await store.createCampaign({
    workspaceId: "ws_verify", name: "IO Flight", platform: "mntn", mode: "concierge",
    status: "draft", approvalObjectId: "appr_1", budgetCents: 500000, currency: "USD",
    flightStart: null, flightEnd: null, targetingJson: null, creativeIds: [], creativeHashes: [],
    vibeAdvertiserId: null, vibeCampaignId: null, vibeTestMode: true, vibeConfigRef: null, createdBy: "tester",
  });
  const { ioDocument } = concierge.generateIo({
    workspaceId: "ws_verify", campaignId: camp.id, vendor: "mntn",
    advertiserName: "Acme", audience: "in-market 25-54", geo: ["US-NC"],
    budgetCents: 500000, flightStart: "2026-10-01", flightEnd: "2026-10-31",
    validation: passValidation, approvalObjectId: "appr_1", spotCount: 12,
  });
  const notes = (ioDocument.honestyNotes as string[]).join(" ");
  ok("MNTN minimum conflict surfaced", /no minimums/i.test(notes) && /\$5K/i.test(notes));
  ok("no 'direct premium' claim repeated", !/direct premium/i.test(notes));
  ok("alert-only notice embedded in IO", /cannot pause this buy/i.test(String(ioDocument.alertOnlyNotice)));
  const io = await store.createIo({
    workspaceId: "ws_verify", campaignId: camp.id, vendor: "mntn",
    ioPayload: { ioDocument }, state: "draft", placedBy: null, placedAt: null, vendorConfirmation: null,
  });
  const moved = await concierge.transitionIo(store, "ws_verify", io.id, "pending_vendor_approval", "tester");
  ok("draft → pending_vendor_approval", moved.state === "pending_vendor_approval");
  let illegal = false;
  try { await concierge.transitionIo(store, "ws_verify", io.id, "live", "tester"); } catch { illegal = true; }
  ok("pending_vendor_approval → live blocked (must be human-placed first)", illegal);
  const events = await store.auditList("ws_verify");
  ok("IO transition audit-logged", events.some((e) => e.action === "io_state_transition"));
}

section("V10 — BYO seats fail closed");
{
  const store = ctvStore.createMemoryCtvStore();
  for (const dsp of ["ttd", "dv360", "amazon", "basis"] as const) {
    const adapter = seats.createSeatAdapter(dsp, store, process.env);
    const status = await adapter.reportStatus("ws_verify", "tester");
    ok(`${dsp} status none without seat`, status.status === "none");
    let failed = false;
    try {
      await adapter.pauseCampaign({ workspaceId: "ws_verify", actor: "tester", externalCampaignId: "x", approvalObjectId: "appr_1" });
    } catch (e) {
      failed = e instanceof seats.SeatNotConnectedError;
    }
    ok(`${dsp} pause fails closed`, failed);
    ok(`${dsp} guidance names the seat`, /seat/i.test(status.guidance.setupSteps.join(" ")));
  }
}

rmSync(dir, { recursive: true, force: true });

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
