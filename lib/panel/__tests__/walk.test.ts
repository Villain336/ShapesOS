// Phase 19B (WS=panel) — structured intents, the PageMaster, the tracker
// rules, walk targets and the walk loop.
// Ported from the prototype's test/pagemaster.test.ts (9), test/tracker.test.ts
// (8), test/browser.test.ts (6) and test/walkthrough.test.ts (3). The browser
// is a system boundary: here it is FakeWalkPage (fixtures.ts, the TaskTide
// fixture page as data); a real-Chromium walk of the same page is in
// run-db.test.ts. The model is a scripted MockLlmProvider.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockLlmProvider, type MockChatStep } from "@/lib/llm/mock";
import { PanelLedger } from "../budget";
import { describeIntent, validateIntent, type Intent } from "../intents";
import { InMemoryMemoryStore } from "../memory";
import { RouterPanelModel } from "../model";
import { landingObservation, resolveIntent } from "../pagemaster";
import { landingPageSite, makePanelRequestGuard, servedResponse, LANDING_PAGE_ORIGIN, siteFilesSite } from "../targets";
import { detectRageClicks, humanDwellMs, isAnalyticsHost, type TrackerClick } from "../tracker";
import { runWalkthrough, type StepFlag } from "../walk";
import { FakeWalkPage, SKEPTIC } from "./fixtures";

const I = (action: Intent["action"], target: string | null = null, value: string | null = null, finish: Intent["finish"] = null): Intent => ({ action, target, value, finish });

describe("structured intents (replace the regex parser)", () => {
  it("describes every supported action", () => {
    assert.deepEqual(
      [I("scroll", "Pricing"), I("read", "FAQ"), I("click", "Start free trial"), I("fill", "Work email", "dana@example.com"), I("back"), I("finish", null, null, "bounced")].map(describeIntent),
      ['scroll to "Pricing"', 'read "FAQ"', 'click "Start free trial"', 'fill "Work email" with "dana@example.com"', "go back", "finish: bounced"],
    );
  });

  it("refuses intents missing what their action needs", () => {
    assert.equal(validateIntent(I("read", "  ")), "read needs a target");
    assert.equal(validateIntent(I("fill", "Work email")), "fill needs a value");
    assert.match(validateIntent(I("finish")) ?? "", /finish needs a signal/);
    assert.equal(validateIntent(I("back")), null);
  });
});

describe("resolveIntent against the fixture page", () => {
  const shots: string[] = [];
  const saveShot = async (i: number, verb: string) => {
    shots.push(`step-${i}-${verb}`);
    return `blob:rehearsal/ws/run/p/step-${i}-${verb}.png`;
  };

  it("lands with the page's real outline", async () => {
    const o = await landingObservation(new FakeWalkPage());
    assert.equal(o.type, "landed");
    assert.match(o.textExcerpt, /"Pricing"/);
    assert.match(o.textExcerpt, /"Choose Pro"/);
    assert.doesNotMatch(o.textExcerpt, /Secret admin/, "hidden buttons are not offered");
  });

  it("scrolls to a section by heading text", async () => {
    const o = await resolveIntent({ page: new FakeWalkPage(), intent: I("scroll", "Pricing"), stepIndex: 0 });
    assert.equal(o.type, "scrolled");
    assert.equal(o.sectionMeta?.heading, "Pricing");
    assert.match(o.textExcerpt, /\$49/);
  });

  it("reads a section: real text plus a stored screenshot ref", async () => {
    const o = await resolveIntent({ page: new FakeWalkPage(), intent: I("read", "Pricing"), stepIndex: 2, saveShot });
    assert.equal(o.type, "read");
    assert.match(o.textExcerpt, /Billed annually/);
    assert.equal(o.screenshotRef, "blob:rehearsal/ws/run/p/step-2-read.png");
  });

  it("clicks a real CTA and lands on the anchor", async () => {
    const o = await resolveIntent({ page: new FakeWalkPage(), intent: I("click", "Choose Pro"), stepIndex: 0, saveShot });
    assert.equal(o.type, "clicked");
    assert.match(o.url, /#checkout$/);
    assert.equal(o.screenshotRef, "blob:rehearsal/ws/run/p/step-0-click.png");
  });

  it("fills a form field by label (the value itself stays out of the record)", async () => {
    const page = new FakeWalkPage();
    const o = await resolveIntent({ page, intent: I("fill", "Work email", "dana@example.com"), stepIndex: 1 });
    assert.equal(o.type, "filled");
    assert.equal(page.filled.get("Work email"), "dana@example.com");
    assert.equal(o.textExcerpt, 'Filled "Work email" (16 characters).');
  });

  it("fail-closes on missing targets instead of inventing content", async () => {
    const page = new FakeWalkPage();
    const a = await resolveIntent({ page, intent: I("scroll", "Enterprise Slurm Ward"), stepIndex: 0 });
    const b = await resolveIntent({ page, intent: I("click", "Teleport Me"), stepIndex: 1 });
    const c = await resolveIntent({ page, intent: I("fill", "Social Security Number", "000"), stepIndex: 2 });
    const d = await resolveIntent({ page, intent: I("read", "Testimonials"), stepIndex: 3 });
    const e = await resolveIntent({ page, intent: I("click", "Secret admin"), stepIndex: 4 });
    assert.deepEqual([a, b, c, d, e].map((o) => o.type), ["not-found", "not-found", "not-found", "not-found", "not-found"]);
    assert.match(a.textExcerpt, /Enterprise Slurm Ward/);
    assert.match(e.textExcerpt, /not visible/);
  });

  it("returns unparsed for an intent it cannot act on, or no intent at all", async () => {
    const a = await resolveIntent({ page: new FakeWalkPage(), intent: I("click"), stepIndex: 0 });
    const b = await resolveIntent({ page: new FakeWalkPage(), intent: null, stepIndex: 0, unparsedReason: "verdict: bad" });
    assert.equal(a.type, "unparsed");
    assert.match(a.textExcerpt, /could not map/);
    assert.match(b.detail ?? "", /verdict: bad/);
  });

  it("goes back and finishes with a signal", async () => {
    const page = new FakeWalkPage();
    await resolveIntent({ page, intent: I("click", "Choose Pro"), stepIndex: 0 });
    const back = await resolveIntent({ page, intent: I("back"), stepIndex: 1 });
    assert.equal(back.type, "went-back");
    assert.match(back.textExcerpt, /Went back from .*#checkout to /);
    const done = await resolveIntent({ page, intent: I("finish", null, null, "bounced"), stepIndex: 2 });
    assert.equal(done.finishSignal, "bounced");
  });
});

describe("tracker rules", () => {
  const click = (t: number, target = 'button#cta"Buy"'): TrackerClick => ({ t, target, x: 10, y: 20 });

  it("flags 3+ clicks within 800ms on the same target", () => {
    assert.deepEqual(detectRageClicks([click(0), click(150), click(300)]), [{ target: 'button#cta"Buy"', count: 3, firstT: 0, lastT: 300 }]);
  });
  it("ignores clicks spread beyond the window", () => {
    assert.equal(detectRageClicks([click(0), click(900), click(1800)]).length, 0);
  });
  it("ignores rapid clicks on different targets", () => {
    assert.equal(detectRageClicks([click(0, "a"), click(100, "b"), click(200, "c")]).length, 0);
  });
  it("counts the window inclusively and consumes a burst once", () => {
    const b = detectRageClicks([click(0), click(400), click(800), click(5000)]);
    assert.deepEqual(b.map((x) => x.count), [3]);
  });
  it("finds two separate bursts on the same target", () => {
    assert.equal(detectRageClicks([click(0), click(100), click(200), click(5000), click(5100), click(5200)]).length, 2);
  });

  const eleven = "one two three four five six seven eight nine ten eleven";
  it("reading time scales with text length at 220 wpm", () => {
    assert.equal(humanDwellMs(eleven, { jitter: 0 }), 3000);
    assert.equal(humanDwellMs(`${eleven} ${eleven}`, { jitter: 0 }), 6000);
  });
  it("clamps to min/max", () => {
    assert.equal(humanDwellMs("", { jitter: 0 }), 600);
    assert.equal(humanDwellMs("word ".repeat(10000), { jitter: 0 }), 12000);
  });
  it("jitters within the configured band (±25%)", () => {
    assert.equal(humanDwellMs(eleven, { jitter: 0.25, random: () => 0 }), 2250);
    assert.equal(humanDwellMs(eleven, { jitter: 0.25, random: () => 1 }), 3750);
  });
});

describe("walk targets and the request guard", () => {
  const checkUrl = async (u: string) => {
    if (/127\.0\.0\.1|localhost|169\.254/.test(u)) throw new Error("URL host is not allowed.");
    return u;
  };

  it("serves a landing page from storage at the reserved origin; other paths are an honest 404", () => {
    const site = landingPageSite({ html: "<h1>Hi</h1>", css: "h1{color:red}", name: "Launch" });
    const r = servedResponse(site, `${LANDING_PAGE_ORIGIN}/`);
    assert.equal(r?.status, 200);
    assert.match(r!.body, /<style>h1\{color:red\}<\/style>/);
    assert.equal(servedResponse(site, `${LANDING_PAGE_ORIGIN}/missing.html`)?.status, 404);
    assert.equal(servedResponse(site, "https://evil.example/"), null);
  });

  it("a SiteBuilder site opens on the requested page, else its index.html", () => {
    const site = siteFilesSite([{ path: "/index.html", content: "<h1>Home</h1>" }, { path: "/pricing.html", content: "<h1>Pricing</h1>" }], "pricing.html");
    assert.equal(site.entryPath, "/pricing.html");
    assert.equal(siteFilesSite([{ path: "/index.html", content: "x" }], "/nope.html").entryPath, "/index.html");
  });

  it("allows the served origin, refuses private hosts and analytics", async () => {
    const guard = makePanelRequestGuard({ checkUrl, servedOrigin: LANDING_PAGE_ORIGIN });
    assert.equal(await guard(`${LANDING_PAGE_ORIGIN}/index.html`), true);
    assert.equal(await guard("https://example.com/"), true);
    assert.equal(await guard("http://127.0.0.1:3000/api/secret"), false);
    assert.equal(await guard("https://www.google-analytics.com/g/collect"), false);
    assert.equal(await guard("file:///etc/passwd"), false);
  });

  it("analytics matching covers subdomains, not lookalikes", () => {
    assert.equal(isAnalyticsHost("x.fullstory.com"), true);
    assert.equal(isAnalyticsHost("notfullstory.com"), false);
  });
});

// ---------------------------------------------------------------------------
// The walk loop
// ---------------------------------------------------------------------------

const stepAnswer = (intent: Intent, thinkAloud: string): MockChatStep => ({
  content: [{ type: "tool_use", id: "s", name: "submit_step", input: { thinkAloud, intent } }],
  model: "claude-haiku-4-5",
  usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

async function walk(script: MockChatStep[], opts: { cap?: number; stepCap?: number; hooks?: Parameters<typeof runWalkthrough>[0]["onStepHooks"]; seed?: (s: InMemoryMemoryStore) => Promise<void> } = {}) {
  const store = new InMemoryMemoryStore();
  await store.addTranscript({ id: "t1", text: "I care about pricing transparency. The last tool hid annual billing in the fine print and I felt tricked.", createdAt: Date.now() });
  await opts.seed?.(store);
  const nodesBefore = store.nodeCount;
  const ledger = new PanelLedger();
  ledger.beginRun("run", opts.cap ?? 100);
  const provider = new MockLlmProvider({ chatScript: script });
  const model = new RouterPanelModel(provider, "claude-haiku-4-5", ledger);
  const page = new FakeWalkPage();
  const result = await runWalkthrough({ model, store, personaSpec: SKEPTIC, personaKey: "p1", page, runId: "run", stepCap: opts.stepCap ?? 10, humanTiming: false, onStepHooks: opts.hooks ?? [] });
  return { result, store, nodesBefore, ledger, provider };
}

describe("runWalkthrough", () => {
  it("walks to a checkout attempt, writing what it saw and thought to its memory", async () => {
    const hookSeen: number[] = [];
    const { result, store, nodesBefore, ledger } = await walk(
      [
        stepAnswer(I("scroll", "Pricing"), "Hero was vague. I want to see the price."),
        stepAnswer(I("read", "Pricing"), "$49/mo... but billed annually? $588 upfront. Hmm."),
        stepAnswer(I("click", "Choose Pro"), "Still within budget. Let me try the signup."),
        stepAnswer(I("fill", "Work email", "dana@example.com"), "Entering my work email."),
        stepAnswer(I("finish", null, null, "checkout-attempted"), "I'm ready to check out."),
      ],
      { hooks: [(s): StepFlag[] => (hookSeen.push(s.stepIndex), [])] },
    );
    assert.equal(result.outcome, "checkout-attempted");
    assert.deepEqual(result.steps.map((s) => s.observation.type), ["scrolled", "read", "clicked", "filled", "finished"]);
    assert.match(result.steps[1]!.observation.textExcerpt, /Billed annually/);
    assert.equal(store.nodeCount, nodesBefore + 10, "an observation and a thought per step");
    const mine = await store.retrieve("pricing annual billing", { k: 20, transcriptIds: ["t1"], runId: "run", personaKey: "p1" });
    assert.deepEqual([...new Set(mine.map((s) => s.node.kind))].sort(), ["interview", "observation", "thought"]);
    assert.deepEqual(hookSeen, [0, 1, 2, 3, 4]);
    assert.equal(result.signals.llmCalls, 5);
    assert.equal(result.signals.totalClicks, 1);
    assert.match(result.signals.dropOff.url, /#checkout$/);
    assert.equal(ledger.spend("run").callCount, 5);
  });

  it("a persona remembers only its own interviews and walk, never another persona's", async () => {
    const { provider } = await walk([stepAnswer(I("read", "Pricing"), "Pricing please."), stepAnswer(I("finish", null, null, "bounced"), "Bye.")], {
      seed: async (s) => {
        await s.addTranscript({ id: "t-other", text: "ZEBRA-INTERVIEW pricing transparency annual billing matters to me.", createdAt: Date.now() });
        await s.addNode({ id: "x", kind: "thought", runId: "run", personaKey: "p2", content: "ZEBRA-THOUGHT pricing annual billing", importance: 1, chunkIndex: 0 });
      },
    });
    const prompts = provider.chatCalls.map((c) => String(c.messages[0]!.content)).join("\n");
    assert.match(prompts, /pricing transparency/);
    assert.doesNotMatch(prompts, /ZEBRA/);
  });

  it("ends bounced when the persona gives up", async () => {
    const { result } = await walk([stepAnswer(I("read", "Pricing"), "Annual-only? Nope."), stepAnswer(I("finish", null, null, "bounced"), "The annual surprise lost me.")]);
    assert.equal(result.outcome, "bounced");
    assert.equal(result.steps.length, 2);
  });

  it("goal-complete is its own outcome (the prototype counted it as a checkout)", async () => {
    const { result } = await walk([stepAnswer(I("finish", null, null, "goal-complete"), "I found the FAQ answer I needed.")]);
    assert.equal(result.outcome, "goal-complete");
  });

  it("step-caps when the persona never finishes", async () => {
    const { result } = await walk([stepAnswer(I("scroll", "Features"), "Still looking.")], { stepCap: 3 });
    assert.equal(result.outcome, "step-capped");
    assert.equal(result.steps.length, 3);
  });

  it("stops cleanly at the credit cap with the steps it has (honest partial result)", async () => {
    // Each step reserves its worst case (≈ 2 credits on haiku for a ~6k-char prompt + 500 out) and settles 1.
    const { result, ledger } = await walk([stepAnswer(I("scroll", "Features"), "Still looking.")], { cap: 4 });
    assert.equal(result.outcome, "cap-stopped");
    assert.ok(result.steps.length >= 1 && result.steps.length < 10);
    assert.match(result.stopReason ?? "", /credit cap/);
    assert.ok(ledger.spend("run").spentCredits <= 4, "spent never passes the cap");
  });

  it("a cap stop inside a monitor ends the walk; other monitor errors are recorded, not flagged", async () => {
    const { PanelCapReachedError } = await import("../budget");
    const capHook = async () => {
      throw new PanelCapReachedError("run", 1, 1, 1);
    };
    const { result } = await walk([stepAnswer(I("scroll", "Features"), "Looking.")], { hooks: [capHook] });
    assert.equal(result.outcome, "cap-stopped");
    assert.equal(result.steps.length, 1);
    const flaky = async () => {
      throw new Error("judge timed out");
    };
    const r2 = await walk([stepAnswer(I("finish", null, null, "bounced"), "Bye.")], { hooks: [flaky] });
    assert.deepEqual(r2.result.steps[0]!.flags, []);
    assert.deepEqual(r2.result.steps[0]!.monitorErrors, ["judge timed out"]);
  });

  it("an answer that fails its schema twice becomes an unparsed step (friction), not a guess", async () => {
    const bad: MockChatStep = { content: [{ type: "text", text: 'click "Choose Pro"' }], model: "claude-haiku-4-5" };
    const { result } = await walk([bad], { stepCap: 1 });
    assert.equal(result.steps[0]!.observation.type, "unparsed");
    assert.equal(result.steps[0]!.intent, null);
  });
});
