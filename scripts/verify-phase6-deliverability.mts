// Marketr — Phase 6 DELIVERABILITY + LISTING-HONESTY battery (O1/L1).
//
// Run: npx tsx scripts/verify-phase6-deliverability.mts
// Run 3x green before calling this done.
//
// Verifies: Postmaster-style deliverability surface (reputation, spam
// ceiling, bounce blend, warmup), GBP 10-edits/min queue spacing (bursts
// queue, never drop), honest three-tier listing labels (unknown channels
// default to manual — never a more automated tier), LDE sandbox behind
// its feature flag, Apple guided-claim (no automation), placement
// verification fixture.

import { prisma } from "../lib/prisma";
import { prismaDomainStore } from "../lib/authority/outreach/domains";
import { prismaCampaignStore } from "../lib/authority/outreach/campaigns";
import { prismaSequenceStore } from "../lib/authority/outreach/sequences";
import {
  deliverabilityForDomain, fakeSpamRatePct,
} from "../lib/authority/outreach/deliverability";
import {
  GBP_EDITS_PER_MINUTE, GBP_EDIT_SPACING_MS, scheduleNextEdit,
  validateGbpEdit, createGbpProfileManager,
} from "../lib/authority/listings/gbp";
import {
  TIER_LABELS, channelTier, CHANNEL_DEFINITIONS,
} from "../lib/authority/listings/tiers";
import { ldeFlagEnabled, resolveLdePrototype } from "../lib/authority/listings/lde";
import { fixturePlacementOutcome } from "../lib/authority/outreach/placement";

const WS = `battery_phase6_deliv_${Date.now().toString(36)}`;
let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string) { passed += 1; console.log(`  ✓ ${name}`); }
function bad(name: string, detail: string) {
  failed += 1; failures.push(`${name}: ${detail}`);
  console.log(`  ✗ ${name} — ${detail}`);
}
async function expectThrow(name: string, fn: () => Promise<unknown> | unknown, match?: RegExp) {
  try { await fn(); bad(name, "expected a throw, but it succeeded"); }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (match && !match.test(msg)) bad(name, `wrong message: ${msg}`);
    else ok(name);
  }
}

async function main() {
  console.log("Phase 6 DELIVERABILITY + LISTING-HONESTY battery");
  const ws = await prisma.workspace.create({ data: { name: `Battery ${WS}`, ownerUserId: "battery" } });
  const wsId = ws.id;
  const domains = prismaDomainStore();

  // --- 1. Deliverability surface -------------------------------------------
  console.log("\n[deliverability]");
  const dom = await domains.create(wsId, {
    domain: "send.example.com", spfOk: true, dkimOk: true, dmarcPolicy: "reject",
    trackingCnameOk: true, warmupStartedAt: new Date(Date.now() - 45 * 86400_000),
  });
  const campaigns = prismaCampaignStore();
  const sequences = prismaSequenceStore();
  const d = await deliverabilityForDomain({ domains, sequences, campaigns }, wsId, dom);
  if (d.domain === "send.example.com") ok("deliverability reports the domain string");
  else bad("deliverability domain", `got ${JSON.stringify((d as never as { domain: unknown }).domain)}`);
  if (["high", "medium", "low", "bad"].includes(d.reputation)) ok(`reputation label: ${d.reputation}`);
  else bad("reputation", String(d.reputation));
  if (d.spamRatePct < d.spamCeilingPct && d.spamOk) ok(`spam ${d.spamRatePct}% under ${d.spamCeilingPct}% ceiling`);
  else bad("spam ceiling", `${d.spamRatePct}% vs ${d.spamCeilingPct}%`);
  if (d.warmupDays >= 45 && d.warmupOk) ok(`warmup ${d.warmupDays}d >= ${d.warmupRequiredDays}d required`);
  else bad("warmup", `${d.warmupDays}d`);
  if (d.bounceStatus === "healthy" && d.bounceRatePct === 0) ok("bounce 0% on fresh domain");
  else bad("bounce", `${d.bounceRatePct}% ${d.bounceStatus}`);
  if (Array.isArray(d.checklistFailures) && d.checklistFailures.length === 0) ok("no checklist failures on healthy domain");
  else bad("checklist", JSON.stringify(d.checklistFailures));
  // Deterministic fake spam rate stays under the 0.3% ceiling for many seeds.
  let spamOk = true;
  for (let i = 0; i < 200; i += 1) if (fakeSpamRatePct(`seed_${i}`) >= 0.3) spamOk = false;
  if (spamOk) ok("fake spam rate always under 0.3% ceiling (200 seeds)");
  else bad("fake spam rate", "exceeded ceiling");

  // --- 2. GBP 10-edits/min queue --------------------------------------------
  console.log("\n[gbp queue]");
  if (GBP_EDITS_PER_MINUTE === 10 && GBP_EDIT_SPACING_MS === 6000) ok("10 edits/min = 6s spacing");
  else bad("gbp constants", `${GBP_EDITS_PER_MINUTE}/min ${GBP_EDIT_SPACING_MS}ms`);
  // Burst of 25 edits: all scheduled, none dropped, spacing respected.
  const queued: Date[] = [];
  let now = new Date();
  for (let i = 0; i < 25; i += 1) {
    const next = scheduleNextEdit(queued, now);
    queued.push(next);
    now = next;
  }
  let spacingOk = true;
  for (let i = 1; i < queued.length; i += 1) {
    if (queued[i].getTime() - queued[i - 1].getTime() < GBP_EDIT_SPACING_MS) spacingOk = false;
  }
  if (queued.length === 25 && spacingOk) ok("25-edit burst: all queued, 6s spacing, none dropped");
  else bad("gbp burst", `queued=${queued.length} spacingOk=${spacingOk}`);
  const lastGapMin = (queued[24].getTime() - Date.now()) / 60000;
  if (lastGapMin >= 2 && lastGapMin <= 3) ok(`burst drains over ~${lastGapMin.toFixed(1)} min (queues, never drops)`);
  else bad("gbp drain", `${lastGapMin.toFixed(1)} min`);
  await expectThrow("Q&A edit kind rejected (API discontinued Nov 2025)", () =>
    validateGbpEdit({ profileId: "p", locationRef: "l", kind: "qna", payload: {} }), /discontinued/i);
  const scheduled: { at: Date }[] = [];
  const mgr = createGbpProfileManager(async (_edit, at) => { scheduled.push({ at }); });
  const r1 = await mgr.updateLocations({ profileId: "p1", locationRef: "loc1", kind: "nap", payload: { name: "Acme" } });
  const r2 = await mgr.updateLocations({ profileId: "p1", locationRef: "loc1", kind: "hours", payload: { hours: "9-5" } });
  if (r1.ok && r2.ok && scheduled.length === 2) ok("profile manager enqueues via callback");
  else bad("profile manager", JSON.stringify({ r1, r2 }));

  // --- 3. Honest three-tier labels -------------------------------------------
  console.log("\n[listing honesty]");
  const labels = Object.values(TIER_LABELS);
  for (const want of ["API-synced", "Aggregator-distributed", "Manual submission", "Guided claim"]) {
    if (labels.includes(want as never)) ok(`tier label present: ${want}`);
    else bad("tier labels", `missing ${want}`);
  }
  const gbp = channelTier("gbp");
  if (gbp.tier === "api_synced") ok("GBP honestly labeled API-synced");
  else bad("gbp tier", gbp.tier);
  const apple = channelTier("apple");
  if (apple.tier === "guided_claim") ok("Apple honestly labeled guided claim (no automation)");
  else bad("apple tier", apple.tier);
  const unknown = channelTier("some_random_directory_xyz");
  if (unknown.tier === "manual") ok("unknown channel defaults to manual — never a more automated tier");
  else bad("unknown tier", unknown.tier);
  if (!unknown.canDo.join(" ").match(/automat/i)) ok("unknown channel cannotDo lists no automation");
  else bad("unknown canDo", unknown.canDo.join(","));
  // Every defined channel has an honest capability note.
  const missingNote = CHANNEL_DEFINITIONS.filter((c) => !c.capabilityNote || !c.cannotDo.length);
  if (missingNote.length === 0) ok(`${CHANNEL_DEFINITIONS.length} channels all carry capability notes`);
  else bad("capability notes", missingNote.map((c) => c.channel).join(","));

  // --- 4. LDE sandbox behind flag --------------------------------------------
  console.log("\n[lde]");
  if (!ldeFlagEnabled({ MARKETR_LDE_PROTOTYPE: "" } as never)) ok("LDE disabled without flag");
  else bad("lde flag", "enabled without flag");
  if (ldeFlagEnabled({ MARKETR_LDE_PROTOTYPE: "1" } as never)) ok("LDE enabled with flag=1");
  else bad("lde flag", "not enabled with flag=1");
  await expectThrow("LDE prototype blocked without flag", () =>
    resolveLdePrototype({ env: { MARKETR_LDE_PROTOTYPE: "" } as never }), /feature flag/i);
  const lde = resolveLdePrototype({ env: { MARKETR_LDE_PROTOTYPE: "1" } as never, fake: true });
  if (lde) ok("LDE sandbox resolves behind the flag (fake)");

  // --- 5. Placement verification fixture --------------------------------------
  console.log("\n[placement]");
  const outcomes = new Set<string>();
  for (let i = 0; i < 50; i += 1) outcomes.add(fixturePlacementOutcome(`seq_${i}`));
  if (outcomes.size > 1) ok(`placement fixture varies: ${[...outcomes].join(",")}`);
  else bad("placement fixture", "constant outcome");

  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.workspace.deleteMany({ where: { id: wsId } });
  if (failed > 0) { console.log("FAILURES:", failures); process.exit(1); }
  console.log("DELIVERABILITY/HONESTY BATTERY GREEN");
}

main().catch((err) => { console.error("battery crashed:", err); process.exit(2); });
