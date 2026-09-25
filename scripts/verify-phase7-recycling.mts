// Marketr — Phase 7 F2 creative-recycling verification battery.
//
// Run: npx tsx scripts/verify-phase7-recycling.mts
// Run 3x green before calling this done.
//
// Exercises the REAL lib modules on the memory-store twins (no DB):
//   1. brief generation on fixture signals (all 4 kinds) — deterministic
//      variant specs, creative-hash lineage minted, lineage verifies.
//   2. lineage integrity — tampering a variant spec breaks the chain.
//   3. approval-gating proof — routing/rewrite/regeneration all refuse to
//      move without human approval; publish intent is blocked and audited;
//      the status union has no publish state.
//   4. adaptation rules — unsupported pairs throw, never improvise.
//   5. supervised rewrite — scope gate (headline/cta only), mock output is
//      loudly labeled, live without keys fails closed.
//   6. workspace isolation, audit hash chain, signal collection/dedupe.

import {
  buildBrief, createBrief, approveBrief, recordRegeneratedAsset, markBriefReady,
  createMemoryRecyclingBriefStore, fakeStudioRouter,
  assertNoAutoPublish, RecyclingGateError,
} from "../lib/flywheel/recycling/briefs";
import {
  createMemoryRecyclingAuditStore, type RecyclingAuditAction,
} from "../lib/flywheel/recycling/audit";
import {
  collectSignals, fixtureSignalReader, DEFAULT_READERS,
} from "../lib/flywheel/recycling/signals";
import {
  adaptBrief, ruleFor, SUPPORTED_PAIRS, UnsupportedChannelPairError,
} from "../lib/flywheel/recycling/adaptation";
import {
  assertRewriteScope, proposeVariantRewrite, resolveRewriteProvider,
  RewriteScopeViolationError, RewriteNotConfiguredError, RewriteGateError,
} from "../lib/flywheel/recycling/rewrite";
import {
  verifyLineage, type RecyclingSignal, type ChannelName,
} from "../lib/flywheel/recycling/types";
import { sha256Hex } from "../lib/media/safety";

const WS = `battery_recycling_${Date.now().toString(36)}`;
const WS2 = `${WS}_other`;
const ACTOR = "battery_actor";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string) { passed += 1; console.log(`  ✓ ${name}`); }
function bad(name: string, detail: string) {
  failed += 1; failures.push(`${name}: ${detail}`);
  console.log(`  ✗ ${name} — ${detail}`);
}
async function expectThrow(name: string, fn: () => Promise<unknown> | unknown, match?: RegExp) {
  try {
    await fn();
    bad(name, "expected a throw, but it succeeded");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (match && !match.test(msg)) bad(name, `threw but message did not match ${match}: ${msg}`);
    else ok(name);
  }
}
function expectNoThrow(name: string, fn: () => unknown) {
  try { fn(); ok(name); } catch (err) {
    bad(name, `unexpected throw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function fixtureSignal(kind: RecyclingSignal["kind"], sourceChannel: ChannelName, metricValue = 10): RecyclingSignal {
  return {
    id: `sig_${kind}`,
    workspaceId: WS,
    kind,
    sourceAssetId: `asset_${kind}`,
    sourceChannel,
    metricValue,
    metricUnit: kind === "attribution_revenue" ? "revenue_cents" : kind === "mail_response" ? "response_rate" : kind === "qr_scan_rate" ? "scans_per_day" : "cooccurrence_lift",
    observedAt: new Date().toISOString(),
    source: "fake",
    detail: { fixture: true },
  };
}

async function main() {
  console.log("Phase 7 F2 recycling battery — no-auto-publish adversarial");

  // --- 1. Brief generation on fixture signals (all 4 kinds) -----------------
  console.log("\n[briefs] generation");
  const store = createMemoryRecyclingBriefStore();
  const audit = createMemoryRecyclingAuditStore();
  const cases: Array<{ kind: RecyclingSignal["kind"]; ch: ChannelName; targets: ChannelName[] }> = [
    { kind: "attribution_revenue", ch: "landing", targets: ["ad", "email", "social"] },
    { kind: "qr_scan_rate", ch: "dooh", targets: [] }, // dooh has no outbound pairs — expect throw below
    { kind: "aeo_lift", ch: "landing", targets: ["ad"] },
    { kind: "mail_response", ch: "mail", targets: ["billboard", "dooh", "email"] },
  ];
  const made: string[] = [];
  for (const c of cases) {
    const sig = fixtureSignal(c.kind, c.ch);
    if (c.targets.length === 0) {
      await expectThrow(`no outbound pairs from ${c.ch} refuses brief`, () =>
        buildBrief({ signal: sig, targetChannels: ["email"], createdBy: ACTOR }),
        /No recycling rule/);
      continue;
    }
    const payload = buildBrief({ signal: sig, targetChannels: c.targets, createdBy: ACTOR });
    if (Object.keys(payload.variantSpecs).length === c.targets.length) {
      ok(`brief generated for ${c.kind} → ${c.targets.join(",")}`);
    } else bad(`brief ${c.kind}`, "wrong variant spec count");
    const brief = await createBrief(store, audit, payload);
    made.push(brief.id);
    if (brief.status === "draft") ok(`brief born draft (${c.kind})`);
    else bad(`brief ${c.kind} status`, brief.status);
    // Lineage: 1 source + 1 per target, all verify.
    if (brief.creativeHashLineage.length === 1 + c.targets.length) ok(`lineage entries = 1+N (${c.kind})`);
    else bad(`lineage count ${c.kind}`, String(brief.creativeHashLineage.length));
    const v = verifyLineage(brief);
    if (v.ok) ok(`lineage verifies (${c.kind})`);
    else bad(`lineage ${c.kind}`, `broken at ${v.ok ? "?" : (v as { brokenAt: number }).brokenAt}`);
    // Every spec carries the deterministic rule surface.
    for (const t of c.targets) {
      const spec = brief.variantSpecs[t];
      if (spec.rulesVersion && spec.aspectRatio && spec.copyDensityCeiling.maxWords > 0 && spec.ctaFormats.length > 0) {
        ok(`variant spec rule surface complete (${t})`);
      } else bad(`spec ${t}`, "missing rule fields");
    }
  }
  // Billboards get the 7-word ceiling — the legibility invariant.
  const mailBrief = await store.get(made[2], WS);
  if (mailBrief?.variantSpecs["billboard"]?.copyDensityCeiling.maxWords === 7) {
    ok("billboard copy ceiling = 7 words");
  } else bad("billboard ceiling", JSON.stringify(mailBrief?.variantSpecs["billboard"]?.copyDensityCeiling));

  // --- 2. Lineage tamper-evidence -------------------------------------------
  console.log("\n[lineage] tamper evidence");
  const brief = (await store.get(made[0], WS))!;
  const tampered = structuredClone(brief);
  tampered.variantSpecs[tampered.targetChannels[0]].copyDensityCeiling.maxWords = 9999;
  const tv = verifyLineage(tampered);
  if (!tv.ok) ok("tampered variant spec breaks lineage");
  else bad("tamper", "lineage still verifies after edit");
  const tampered2 = structuredClone(brief);
  tampered2.creativeHashLineage[0] = { ...tampered2.creativeHashLineage[0], hash: "0".repeat(64) };
  if (!verifyLineage(tampered2).ok) ok("swapped hash breaks lineage");
  else bad("hash swap", "lineage still verifies");

  // --- 3. Approval gating (the invariant) ------------------------------------
  console.log("\n[gates] approval required");
  const draft = await store.get(made[0], WS);
  // Rewrite before approval is refused.
  await expectThrow("rewrite on unapproved brief blocked", () =>
    proposeVariantRewrite({
      variantChannel: draft!.targetChannels[0],
      sourceCopy: { headline: "Win big", cta: "Shop now" },
      ruleNotes: [],
      provider: resolveRewriteProvider({ fake: true }),
      briefApproved: draft!.status === "approved" || draft!.status === "regenerating",
    }), /human-approved/);
  // Regeneration before approval is refused.
  await expectThrow("regenerated asset on draft brief blocked", () =>
    recordRegeneratedAsset({
      store, audit, id: draft!.id, workspaceId: WS, actor: ACTOR,
      variantChannel: draft!.targetChannels[0],
      creativeHash: sha256Hex("fake-bytes"), assetRef: "studio_x",
    }), /human-approved|regenerating/);
  // Approve → routes to studio, draft → approved → regenerating.
  const { brief: approved, receipts } = await approveBrief({
    store, audit, id: draft!.id, workspaceId: WS, actor: ACTOR, note: "battery approval",
  });
  if (approved.status === "regenerating") ok("approved brief → regenerating (variants routed)");
  else bad("approve transition", approved.status);
  if (receipts.length === draft!.targetChannels.length) ok("one routing receipt per variant");
  else bad("receipts", `${receipts.length} vs ${draft!.targetChannels.length} targets`);
  if (receipts.every((r) => r.provider === "fake" && r.studioRef.startsWith("studio_pending:"))) {
    ok("fake router receipts are review-queue refs, never publishes");
  } else bad("receipts", "unexpected receipt shape");
  // The router contract has no publish verb — prove it structurally.
  if (!("publish" in fakeStudioRouter)) ok("StudioRouter contract exposes no publish verb");
  else bad("router contract", "publish verb present");
  // Double approval is refused.
  await expectThrow("second approval refused", () =>
    approveBrief({ store, audit, id: draft!.id, workspaceId: WS, actor: ACTOR }), /Only draft/);
  // Publish intent smuggled into a brief is blocked.
  const smuggled = structuredClone(approved) as unknown as Record<string, unknown>;
  smuggled.autoPublish = true;
  await expectThrow("smuggled autoPublish blocked", () =>
    Promise.resolve(assertNoAutoPublish(smuggled as never)), /Publish intent/);
  expectNoThrow("clean brief passes publish check", () => assertNoAutoPublish(approved));
  // Regenerate every variant with studio-attested hashes, then ready.
  for (const t of approved.targetChannels) {
    await recordRegeneratedAsset({
      store, audit, id: approved.id, workspaceId: WS, actor: "studio_human",
      variantChannel: t, creativeHash: sha256Hex(`bytes-${t}`), assetRef: `studio_asset_${t}`,
    });
  }
  ok("all variants regenerated with studio-attested hashes");
  const ready = await markBriefReady({ store, audit, id: approved.id, workspaceId: WS, actor: ACTOR });
  if (ready.status === "ready") ok("brief ready when every variant regenerated");
  else bad("ready", ready.status);
  const vReady = verifyLineage(ready);
  if (vReady.ok) ok("lineage verifies end-to-end (source → variant → regenerated)");
  else bad("e2e lineage", "broken");
  // markBriefReady with a missing variant refuses.
  const b2 = await createBrief(store, audit, buildBrief({
    signal: fixtureSignal("mail_response", "mail"), targetChannels: ["email", "social"], createdBy: ACTOR,
  }));
  await approveBrief({ store, audit, id: b2.id, workspaceId: WS, actor: ACTOR });
  await recordRegeneratedAsset({
    store, audit, id: b2.id, workspaceId: WS, actor: "studio_human",
    variantChannel: "email", creativeHash: sha256Hex("bytes-email"), assetRef: "studio_e",
  });
  await expectThrow("ready with missing variant blocked", () =>
    markBriefReady({ store, audit, id: b2.id, workspaceId: WS, actor: ACTOR }), /still regenerating/);
  // Non-hex creative hash is refused (studio must attest real bytes).
  await expectThrow("non-sha256 creative hash refused", () =>
    recordRegeneratedAsset({
      store, audit, id: b2.id, workspaceId: WS, actor: "studio_human",
      variantChannel: "social", creativeHash: "not-a-hash", assetRef: "studio_s",
    }), /64-char hex/);

  // --- 4. Adaptation rules ----------------------------------------------------
  console.log("\n[rules] deterministic pairs");
  await expectThrow("unsupported pair throws", () => adaptBrief("email", ["ctv"]), /No recycling rule/);
  await expectThrow("empty targets throws", () => adaptBrief("mail", []), /No recycling rule|at least one/);
  if (SUPPORTED_PAIRS.length >= 10) ok(`${SUPPORTED_PAIRS.length} supported pairs in the rule table`);
  else bad("pair count", String(SUPPORTED_PAIRS.length));
  expectNoThrow("ruleFor returns deterministic spec", () => ruleFor("mail", "billboard"));
  const r1 = JSON.stringify(ruleFor("mail", "billboard"));
  const r2 = JSON.stringify(ruleFor("mail", "billboard"));
  if (r1 === r2) ok("rules are deterministic across calls");
  else bad("determinism", "differed");
  await expectThrow("unknown channel rejected", () => adaptBrief("mail", ["tv_network" as never]), /Unknown target|No recycling/);

  // --- 5. Supervised rewrite ---------------------------------------------------
  console.log("\n[rewrite] supervised only");
  await expectThrow("body rewrite refused", () => assertRewriteScope(["headline", "body"]), /only "headline" and "cta"/);
  await expectThrow("art-direction rewrite refused", () => assertRewriteScope(["layout"]), /only "headline" and "cta"/);
  expectNoThrow("headline+cta scope passes", () => assertRewriteScope(["headline", "cta"]));
  const mock = resolveRewriteProvider({ fake: true });
  const rw = await proposeVariantRewrite({
    variantChannel: "email",
    sourceCopy: { headline: "Win big this spring", cta: "Shop now" },
    ruleNotes: ["≤150 words"],
    provider: mock,
    briefApproved: true,
  });
  if (rw.headline.startsWith("[FAKE REWRITE") && rw.cta.startsWith("[FAKE REWRITE") && rw.provenance.labeled) {
    ok("mock rewrite output loudly labeled fake, provenance recorded");
  } else bad("mock rewrite", JSON.stringify(rw));
  // Live without keys → honest not-configured (never a pretend rewrite).
  const env = process.env as Record<string, string | undefined>;
  const saved = { a: env.LLM_API_KEY, b: env.OPENAI_API_KEY, c: env.ANTHROPIC_API_KEY, d: env.LLM_MODEL, e: env.LLM_MODEL_COPY };
  delete env.LLM_API_KEY; delete env.OPENAI_API_KEY; delete env.ANTHROPIC_API_KEY;
  delete env.LLM_MODEL; delete env.LLM_MODEL_COPY;
  await expectThrow("live rewrite without keys fails closed", () =>
    Promise.resolve(resolveRewriteProvider({ fake: false })), /not configured/i);
  Object.assign(env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined)));
  // Live WITH keys → still fails closed in v1 (unwired adapter).
  env.LLM_API_KEY = "sk_test_battery";
  const live = resolveRewriteProvider({ fake: false });
  await expectThrow("live rewrite with keys still fails closed in v1", () =>
    proposeVariantRewrite({
      variantChannel: "email",
      sourceCopy: { headline: "h", cta: "c" },
      ruleNotes: [],
      provider: live,
      briefApproved: true,
    }), /not wired|not configured/i);
  delete env.LLM_API_KEY;
  if (saved.a !== undefined) env.LLM_API_KEY = saved.a;
  if (saved.d !== undefined) env.LLM_MODEL = saved.d;
  if (saved.e !== undefined) env.LLM_MODEL_COPY = saved.e;

  // --- 6. Isolation + audit chain ----------------------------------------------
  console.log("\n[isolation + audit]");
  const foreign = await store.get(made[0], WS2);
  if (foreign === null) ok("brief invisible from other workspace");
  else bad("cross-workspace brief", "visible in WS2");
  const chain = await audit.verifyChain(made[0], WS);
  if (chain.ok) ok("audit chain verifies");
  else bad("audit chain", "broken on honest log");
  const events = await audit.list(made[0], WS, 50);
  const actions = events.map((e) => e.action);
  const needed: RecyclingAuditAction[] = ["brief_created", "brief_approved", "variant_routed", "asset_regenerated"];
  for (const need of needed) {
    if (actions.includes(need)) ok(`audit logged ${need}`);
    else bad("audit coverage", `missing ${need}`);
  }
  const foreignEvents = await audit.list(made[0], WS2, 50);
  if (foreignEvents.length === 0) ok("audit events invisible from other workspace");
  else bad("cross-workspace audit", "visible in WS2");

  // --- 7. Signal collection ------------------------------------------------------
  console.log("\n[signals] collection");
  const sigs = await collectSignals(WS, { fake: true });
  if (sigs.length === 4 && new Set(sigs.map((s) => s.kind)).size === 4) {
    ok("fixture reader yields one signal per kind");
  } else bad("fixture signals", `got ${sigs.length}`);
  if (sigs.every((s) => s.source === "fake" && s.workspaceId === WS)) ok("fixture signals labeled fake, workspace-scoped");
  else bad("fixture labeling", "wrong");
  const kinds = DEFAULT_READERS.map((r) => r.kind).sort();
  if (JSON.stringify(kinds) === JSON.stringify(["aeo_lift", "attribution_revenue", "mail_response", "qr_scan_rate"])) {
    ok("default readers cover all four Phase 2–6 sources");
  } else bad("default readers", kinds.join(","));
  if (DEFAULT_READERS.every((r) => r.source === "real")) ok("default readers are real-table readers");
  else bad("reader source", "a default reader is not marked real");
  if (fixtureSignalReader.describe().length > 0) ok("readers self-describe");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log("FAILURES:", failures); process.exit(1); }
  console.log("RECYCLING BATTERY GREEN");
}

main().catch((err) => {
  console.error("battery crashed:", err);
  process.exit(2);
});
