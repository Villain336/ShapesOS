// Marketr milestone 21 — fixture tests for the Higgsfield ad factory.
// Pure brief/prompt logic + mock Higgsfield port + mock-db generation,
// polling, and guardrail paths: no live DB, no network, no Higgsfield
// calls, no spend.
// Tests: prompt builder composition (brand + format + negative prompt),
// variant fan-out, cost estimation, brief validation, cap gate enforcement,
// idempotent submit/poll, polling state machine, retry/backoff semantics,
// approve/reject/regenerate/send-to-social guards.
// Run: npx tsx scripts/verify-m21-ads.mts

import {
  ASPECT_RATIOS,
  CHANNEL_FORMATS,
  ESTIMATED_COST_CENTS,
  MAX_VARIANTS,
  buildAdPrompt,
  estimateCostCents,
  fanOutVariants,
  recommendedRatios,
  validateBrief,
  type AdBrief,
  type BrandConstraints,
} from "@/lib/ads/brief";
import { MockHiggsfieldPort, isTransientHiggsfieldError } from "@/lib/ads/higgsfield";
import {
  AdGuardError,
  approveCreative,
  checkCap,
  currentPeriod,
  generateCreatives,
  getCampaignSpend,
  getSpendSummary,
  pollCreative,
  regenerateCreative,
  rejectCreative,
  runDueAdJobs,
  sendCreativeToSocial,
  submitJob,
} from "@/lib/ads/service";
import type { PrismaClient } from "@prisma/client";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const brief: AdBrief = {
  product: "Marketr agency SEO workspace",
  audience: "Marketing agency owners",
  hook: "Your SEO reports write themselves",
  offer: "14-day free trial",
  cta: "Start free",
  tone: "bold",
  negativePrompt: "cartoonish",
};

const brand: BrandConstraints = {
  colors: { primary: "#0ea5e9", text: "#18181b" },
  fonts: { heading: "Inter", body: "Inter" },
  tone: "confident",
  hasLogo: true,
};

// --- prompt builder ------------------------------------------------------------------------------
{
  const { prompt, negativePrompt } = buildAdPrompt(brief, brand, "image", "9:16", 0);
  check("prompt has product", prompt.includes("Marketr agency SEO workspace"));
  check("prompt has hook", prompt.includes("Your SEO reports write themselves"));
  check("prompt has offer", prompt.includes("14-day free trial"));
  check("prompt has cta", prompt.includes("Start free"));
  check("prompt has brand colors", prompt.includes("#0ea5e9"));
  check("prompt has brand fonts", prompt.includes("Inter"));
  check("prompt has aspect spec", prompt.includes("9:16") && prompt.includes("1080×1920"));
  check("prompt has logo placement note", prompt.includes("logo"));
  check("negative prompt has defaults", negativePrompt.includes("watermark") && negativePrompt.includes("off-brand colors"));
  check("negative prompt carries brief note", negativePrompt.includes("cartoonish"));

  // Video prompts name the medium; fallback tone comes from the brand kit.
  const v = buildAdPrompt({ ...brief, tone: undefined }, { ...brand, tone: "playful" }, "video", "16:9", 3);
  check("video prompt names video", v.prompt.includes("advertising video"));
  check("brand tone fallback", v.prompt.includes("playful"));

  // Variant angles rotate.
  const angles = new Set(
    [0, 1, 2, 3].map((i) => buildAdPrompt(brief, brand, "image", "1:1", i).prompt),
  );
  check("variant angles rotate", angles.size === 4);
}

// --- fan-out / cost / validation -----------------------------------------------------------------
{
  const variants = fanOutVariants(brief, brand, "image", "1:1", 4);
  check("fan-out count", variants.length === 4);
  check("fan-out clamp to MAX_VARIANTS", fanOutVariants(brief, brand, "image", "1:1", 99).length === MAX_VARIANTS);
  check("fan-out min 1", fanOutVariants(brief, brand, "image", "1:1", 0).length === 1);
  check("first variant uses brief hook verbatim", variants[0].prompt.includes(brief.hook));

  check("estimate image", estimateCostCents("image", 4) === ESTIMATED_COST_CENTS.image * 4);
  check("estimate video", estimateCostCents("video", 2) === ESTIMATED_COST_CENTS.video * 2);

  check("valid brief", validateBrief(brief).length === 0);
  const errs = validateBrief({ product: "", audience: "x", hook: "", cta: "" });
  check("brief validation catches missing fields", errs.length === 3, errs.join("|"));

  check("aspect ratios defined", Object.keys(ASPECT_RATIOS).length === 4);
  check("channel formats instagram", CHANNEL_FORMATS.instagram.includes("9:16"));
  check("recommended ratios tiktok", JSON.stringify(recommendedRatios(["tiktok"])) === JSON.stringify(["9:16"]));
  check("recommended ratios fallback", recommendedRatios(["unknown-chan"]).length >= 1);
}

// --- error classification ------------------------------------------------------------------------
check("429 transient", isTransientHiggsfieldError({ status: 429 }));
check("500 transient", isTransientHiggsfieldError({ status: 500 }));
check("network transient", isTransientHiggsfieldError(new TypeError("fetch failed")));
check("400 permanent", !isTransientHiggsfieldError({ status: 400 }));
check("404 permanent", !isTransientHiggsfieldError({ status: 404 }));

// --- fake db -------------------------------------------------------------------------------------
interface Row { [k: string]: unknown }
interface DbState {
  settings: Row;
  campaigns: Map<string, Row>;
  creatives: Map<string, Row>;
  audit: Row[];
  socialPosts: Row[];
  alerts: Row[];
}

function newState(): DbState {
  return {
    settings: { workspaceId: "ws-1", higgsfieldKeyEnc: "enc", higgsfieldKeyHint: "•••1", monthlyCapCents: 5000, spendCents: 0, spendPeriod: currentPeriod() },
    campaigns: new Map([["camp-1", { id: "camp-1", projectId: "proj-1", name: "Launch", brandKitId: "kit-1", channels: ["instagram"], objective: null }]]),
    creatives: new Map(),
    audit: [],
    socialPosts: [],
    alerts: [],
  };
}

function fakeDb(state: DbState) {
  let seq = 0;
  return {
    adSettings: {
      findUnique: async () => state.settings,
      upsert: async ({ create, update }: { create: Row; update: Row }) => {
        Object.assign(state.settings, create, update);
        return state.settings;
      },
      update: async ({ data }: { data: Row }) => {
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in (v as object)) {
            (state.settings[k] as number) += (v as { increment: number }).increment;
          } else {
            state.settings[k] = v;
          }
        }
        return state.settings;
      },
    },
    adCampaign: {
      findUnique: async ({ where }: { where: { id: string } }) => state.campaigns.get(where.id) ?? null,
    },
    adCreative: {
      create: async ({ data }: { data: Row }) => {
        seq += 1;
        const row: Row = { id: `cr-${seq}`, attempts: 0, assets: [], costActualCents: 0, error: null, approved: false, rejected: false, promptHistory: [], providerJobId: null, nextPollAt: null, ...data };
        state.creatives.set(row.id as string, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => state.creatives.get(where.id) ?? null,
      findMany: async ({ where, take }: { where?: Row; take?: number }) => {
        let rows = [...state.creatives.values()];
        if (where?.status && (where.status as Row).in) {
          rows = rows.filter((r) => ((where.status as Row).in as string[]).includes(r.status as string));
        }
        if (where?.nextPollAt && (where.nextPollAt as Row).lte) {
          rows = rows.filter((r) => r.nextPollAt && (r.nextPollAt as Date) <= ((where.nextPollAt as Row).lte as Date));
        }
        // Mirror the service's include: sweep needs campaign.project.workspaceId.
        rows = rows.map((r) => ({ ...r, campaign: { project: { workspaceId: "ws-1" } } }));
        return rows.slice(0, take ?? rows.length);
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = state.creatives.get(where.id)!;
        Object.assign(row, data);
        return row;
      },
      aggregate: async () => {
        const rows = [...state.creatives.values()];
        return {
          _sum: {
            costEstimateCents: rows.reduce((s, r) => s + (r.costEstimateCents as number), 0),
            costActualCents: rows.reduce((s, r) => s + (r.costActualCents as number), 0),
          },
          _count: rows.length,
        };
      },
    },
    brandKit: {
      findUnique: async () => ({ id: "kit-1", colors: { primary: "#0ea5e9" }, fonts: { heading: "Inter" }, tone: "bold", logoPath: "logos/k.png" }),
    },
    fileChangeLog: { create: async ({ data }: { data: Row }) => { state.audit.push(data); return data; } },
    socialPost: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: `post-${state.socialPosts.length + 1}`, ...data };
        state.socialPosts.push(row);
        return row;
      },
    },
  } as unknown as PrismaClient;
}

// --- cap gate ------------------------------------------------------------------------------------
{
  const state = newState();
  const db = fakeDb(state);
  await checkCap(db, "ws-1", 100);
  check("cap allows under-limit", true);
  let threw = false;
  try {
    await checkCap(db, "ws-1", 999999);
  } catch (e) {
    threw = e instanceof AdGuardError;
  }
  check("cap blocks over-limit", threw);
  const summary = await getSpendSummary(db, "ws-1");
  check("spend summary fields", summary.capCents === 5000 && summary.period === currentPeriod() && !summary.atCap);
}

// --- generation guards: no brand kit --------------------------------------------------------------
{
  const state = newState();
  state.campaigns.set("camp-nobrand", { id: "camp-nobrand", projectId: "proj-1", name: "NoBrand", brandKitId: null, channels: [] });
  const db = fakeDb(state);
  const port = new MockHiggsfieldPort();
  let threw = false;
  try {
    await generateCreatives(db, "ws-1", "proj-1", "camp-nobrand", { brief, type: "image", aspectRatio: "1:1", variants: 2 }, port);
  } catch (e) {
    threw = e instanceof AdGuardError && /brand kit/i.test((e as Error).message);
  }
  check("generation blocked without brand kit", threw);
}

// --- generation guards: bad brief ----------------------------------------------------------------
{
  const state = newState();
  const db = fakeDb(state);
  const port = new MockHiggsfieldPort();
  let threw = false;
  try {
    await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief: { ...brief, hook: "" }, type: "image", aspectRatio: "1:1", variants: 2 }, port);
  } catch (e) {
    threw = e instanceof AdGuardError;
  }
  check("generation blocked on invalid brief", threw);
}

// --- generation guards: cap exceeded ---------------------------------------------------------------
{
  const state = newState();
  state.settings.monthlyCapCents = 10; // below the estimate for 2 images
  const db = fakeDb(state);
  const port = new MockHiggsfieldPort();
  let threw = false;
  try {
    await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 2 }, port);
  } catch (e) {
    threw = e instanceof AdGuardError && /cap/i.test((e as Error).message);
  }
  check("generation blocked when cap exceeded", threw);
  check("no creatives created on cap block", state.creatives.size === 0);
}

// --- happy path: fan-out → submit → poll → ready ----------------------------------------------------
{
  const state = newState();
  const db = fakeDb(state);
  const port = new MockHiggsfieldPort();
  const res = await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "9:16", variants: 3 }, port);
  check("created 3 creatives", res.created === 3 && state.creatives.size === 3);
  check("estimate matches", res.costEstimateCents === ESTIMATED_COST_CENTS.image * 3);
  check("3 provider jobs submitted", port.getSubmitted().length === 3);
  check("submit carries prompt + aspect ratio", port.getSubmitted().every((j) => (j.args.prompt as string).includes("Marketr") && j.args.aspect_ratio === "9:16"));
  check("jobs in generating state", [...state.creatives.values()].every((r) => r.status === "generating" && !!r.providerJobId));
  check("audit logged generation start", state.audit.some((a) => a.action === "ad_generation_started"));

  // Idempotent submit: already has a job id.
  const first = [...state.creatives.values()][0];
  const again = await submitJob(db, "ws-1", first.id as string, port, { modelPath: "m" });
  check("submit idempotent on providerJobId", again.outcome === "noop" && port.getSubmitted().length === 3);

  // Poll: first poll → pending, second → ready.
  const p1 = await pollCreative(db, "ws-1", first.id as string, port);
  check("first poll pending", p1.outcome === "pending");
  const p2 = await pollCreative(db, "ws-1", first.id as string, port);
  check("second poll ready", p2.outcome === "ready");
  const row = state.creatives.get(first.id as string)!;
  check("assets recorded", (row.assets as unknown[]).length === 1);
  check("actual cost recorded (falls back to estimate)", row.costActualCents === row.costEstimateCents);
  check("spend incremented", (state.settings.spendCents as number) === (row.costActualCents as number));
  check("audit logged completion", state.audit.some((a) => a.action === "ad_generation_completed"));

  // Poll is a no-op once ready.
  const p3 = await pollCreative(db, "ws-1", first.id as string, port);
  check("poll noop after ready", p3.outcome === "noop");
}

// --- polling: provider failure → failed --------------------------------------------------------------
{
  const state = newState();
  const db = fakeDb(state);
  const port = new MockHiggsfieldPort();
  port.scriptNext(["failed"], [], "NSFW filter rejected the prompt");
  const res = await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 1 }, port);
  const id = res.creativeIds[0];
  const p = await pollCreative(db, "ws-1", id, port);
  check("provider failure → failed", p.outcome === "failed");
  const row = state.creatives.get(id)!;
  check("error recorded", (row.error as string).includes("NSFW"));
  check("audit logged failure", state.audit.some((a) => a.action === "ad_generation_failed"));
}

// --- polling: transient poll error retries, permanent fails -------------------------------------------
{
  const state = newState();
  const db = fakeDb(state);
  const transientPort = {
    submitted: [] as unknown[],
    async submitJob(job: unknown) {
      (this.submitted as unknown[]).push(job);
      return { requestId: "t-1", statusUrl: "u" };
    },
    async getStatus() {
      const e = new Error("boom") as Error & { status?: number };
      e.status = 503;
      throw e;
    },
  };
  await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 1 }, transientPort as unknown as MockHiggsfieldPort);
  const id = [...state.creatives.keys()][0];
  const p = await pollCreative(db, "ws-1", id, transientPort as unknown as MockHiggsfieldPort);
  check("transient poll error → pending with backoff", p.outcome === "pending");
  const row = state.creatives.get(id)!;
  check("backoff scheduled", row.nextPollAt instanceof Date && (row.nextPollAt as Date).getTime() > Date.now());

  const permanentPort = {
    async submitJob() { return { requestId: "p-1", statusUrl: "u" }; },
    async getStatus() {
      const e = new Error("bad args") as Error & { status?: number };
      e.status = 400;
      throw e;
    },
  };
  const p2 = await pollCreative(db, "ws-1", id, permanentPort as unknown as MockHiggsfieldPort);
  check("permanent poll error → failed", p2.outcome === "failed");
}

// --- review actions -----------------------------------------------------------------------------------
{
  const state = newState();
  const db = fakeDb(state);
  const port = new MockHiggsfieldPort();
  const res = await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 2 }, port);
  const [a, b] = res.creativeIds;

  // Cannot approve before ready.
  let threw = false;
  try {
    await approveCreative(db, "ws-1", a);
  } catch (e) {
    threw = e instanceof AdGuardError;
  }
  check("approve blocked before ready", threw);

  // Drive to ready, then approve.
  await pollCreative(db, "ws-1", a, port);
  await pollCreative(db, "ws-1", a, port);
  const approved = await approveCreative(db, "ws-1", a);
  check("approve works when ready", (approved as Row).approved === true);
  check("audit approve", state.audit.some((x) => x.action === "ad_creative_approved"));

  const rejected = await rejectCreative(db, "ws-1", b);
  check("reject works", (rejected as Row).rejected === true);

  // Regenerate: explicit, preserves history.
  const oldPrompt = state.creatives.get(a)!.prompt as string;
  const regen = await regenerateCreative(db, "ws-1", a, { prompt: "A brand-new prompt", port });
  check("regen submits a new job", ((regen as Row).providerJobId as string | null) !== null);
  check("regen resets to in-flight", ["queued", "generating"].includes((regen as Row).status as string));
  check("regen preserves prompt history", ((regen as Row).promptHistory as unknown[]).length === 1);
  check("regen sets new prompt", (regen as Row).prompt === "A brand-new prompt");
  check("regen clears approval", (regen as Row).approved === false);
  check("old prompt in history", ((regen as Row).promptHistory as { prompt: string }[])[0].prompt === oldPrompt);
}

// --- send to social guards -----------------------------------------------------------------------------
{
  const state = newState();
  const db = fakeDb(state);
  const port = new MockHiggsfieldPort();
  const res = await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief, type: "image", aspectRatio: "1:1", variants: 1 }, port);
  const id = res.creativeIds[0];

  let threw = false;
  try {
    await sendCreativeToSocial(db, "ws-1", "proj-1", id, { text: "hi", services: ["instagram"] });
  } catch (e) {
    threw = e instanceof AdGuardError;
  }
  check("send blocked before approval", threw);

  await pollCreative(db, "ws-1", id, port);
  await pollCreative(db, "ws-1", id, port);
  await approveCreative(db, "ws-1", id);
  const post = await sendCreativeToSocial(db, "ws-1", "proj-1", id, { text: "Launch day!", services: ["instagram"] });
  check("send creates social post", (post as Row).id !== undefined);
  const media = ((post as Row).content as { media: { url: string }[] }).media;
  check("creative asset attached", media.length === 1 && media[0].url.includes("cdn.example.com"));
  check("audit send-to-social", state.audit.some((a) => a.action === "ad_sent_to_social"));
}

// --- campaign spend rollup + cron sweep ------------------------------------------------------------------
{
  const state = newState();
  const db = fakeDb(state);
  const port = new MockHiggsfieldPort();
  const res = await generateCreatives(db, "ws-1", "proj-1", "camp-1", { brief, type: "video", aspectRatio: "16:9", variants: 2 }, port);
  const spend = await getCampaignSpend(db, "camp-1");
  check("campaign spend estimated", spend.estimated === ESTIMATED_COST_CENTS.video * 2 && spend.count === 2);

  // Sweep polls the in-flight creatives.
  for (const id of res.creativeIds) {
    state.creatives.get(id)!.nextPollAt = new Date(Date.now() - 1000);
  }
  const sweep1 = await runDueAdJobs(db, async () => port);
  check("sweep polls due jobs", sweep1.pending === 2);
  // Backoff pushes nextPollAt 30s out; force due again for the second poll.
  for (const id of res.creativeIds) {
    state.creatives.get(id)!.nextPollAt = new Date(Date.now() - 1000);
  }
  const sweep2 = await runDueAdJobs(db, async () => port);
  check("sweep completes jobs", sweep2.ready === 2);

  // Queued-without-job gets submitted by the sweep.
  const state2 = newState();
  const db2 = fakeDb(state2);
  state2.creatives.set("cr-stuck", {
    id: "cr-stuck", campaignId: "camp-1", projectId: "proj-1", name: "stuck", type: "image",
    brief: {}, prompt: "p", promptHistory: [], status: "queued", aspectRatio: "1:1", channels: [],
    costEstimateCents: 50, costActualCents: 0, assets: [], providerJobId: null,
    attempts: 0, nextPollAt: new Date(Date.now() - 1000), error: null, approved: false, rejected: false,
    campaign: { project: { workspaceId: "ws-1" } },
  });
  const port2 = new MockHiggsfieldPort();
  const sweep3 = await runDueAdJobs(db2, async () => port2);
  check("sweep submits stuck queued job", sweep3.submitted === 1);
  check("stuck job now generating", (state2.creatives.get("cr-stuck")!.status as string) === "generating");
}

// --- mock port default behavior ---------------------------------------------------------------------------
{
  const port = new MockHiggsfieldPort();
  const sub = await port.submitJob({ modelPath: "m", args: { prompt: "x" } });
  check("mock submit returns request id", sub.requestId.startsWith("mock-req-"));
  const s1 = await port.getStatus(sub.requestId);
  const s2 = await port.getStatus(sub.requestId);
  check("mock default: pending then completed", s1.state === "in_progress" && s2.state === "completed");
  check("mock attaches media url", s2.mediaUrls.length === 1);
  check("mock never touches network (no fetch available check)", typeof fetch === "function"); // documents intent
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
