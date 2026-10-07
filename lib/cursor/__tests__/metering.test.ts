// Phase 19A (WS=server): cursor metering amounts — talk minutes past the
// plan's included ones, spoken characters per provider, the table entries.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CREDIT_COSTS, CREDIT_CATEGORIES, categoryOf } from "@/lib/metering/credits";
import { CURSOR_AGENT_MAX_USD_CEILING, CURSOR_TALK_MINUTES_INCLUDED, cursorAgentMaxUsdCeiling, cursorTalkMinutesIncluded } from "@/lib/billing/entitlements";
import { CURSOR_TALK_MINUTE_CREDITS, startedMinutes, talkMinuteCharges, ttsCredits, ttsCreditsPer1k } from "../metering";

describe("credit table", () => {
  it("has both cursor actions in the Cursor category, cost-plus", () => {
    assert.ok(CREDIT_CATEGORIES.includes("cursor"));
    assert.equal(categoryOf("cursor_talk_minute"), "cursor");
    assert.equal(categoryOf("cursor_tts_1k_chars"), "cursor");
    assert.equal(CREDIT_COSTS.cursor_talk_minute.basis, "cost-plus");
    // Table prices = the dearer provider at ~4× cost: Deepgram $0.0077/min → 4; ElevenLabs Flash $0.04/1k → 16.
    assert.equal(CREDIT_COSTS.cursor_talk_minute.credits, 4);
    assert.equal(CREDIT_COSTS.cursor_tts_1k_chars.credits, 16);
  });
  it("per-provider prices are ~4× vendor cost, rounded up", () => {
    assert.equal(CURSOR_TALK_MINUTE_CREDITS.assemblyai, Math.ceil(0.0025 * 4 * 100));
    assert.equal(CURSOR_TALK_MINUTE_CREDITS.deepgram, Math.ceil(0.0077 * 4 * 100));
    assert.equal(CURSOR_TALK_MINUTE_CREDITS.mock, 0);
    assert.equal(ttsCreditsPer1k("elevenlabs", "eleven_flash_v2_5"), Math.ceil(0.04 * 4 * 100));
    assert.equal(ttsCreditsPer1k("elevenlabs", "eleven_multilingual_v2"), Math.ceil(0.08 * 4 * 100));
    assert.equal(ttsCreditsPer1k("openai", "tts-1"), Math.ceil(0.015 * 4 * 100));
    assert.equal(ttsCreditsPer1k("voicestudio", null), 0);
  });
});

describe("plan inclusion", () => {
  it("Starter 60, Pro 300, Business 1000, Agency 300 (pooled), self-hosted unlimited", () => {
    assert.deepEqual(
      { starter: CURSOR_TALK_MINUTES_INCLUDED.starter, pro: CURSOR_TALK_MINUTES_INCLUDED.pro, business: CURSOR_TALK_MINUTES_INCLUDED.business, agency: CURSOR_TALK_MINUTES_INCLUDED.agency },
      { starter: 60, pro: 300, business: 1000, agency: 300 },
    );
    assert.equal(cursorTalkMinutesIncluded("self_hosted"), null);
    assert.equal(cursorTalkMinutesIncluded("nonsense"), 0);
  });
  it("agent-mode spend ceilings per plan", () => {
    assert.equal(cursorAgentMaxUsdCeiling("starter"), CURSOR_AGENT_MAX_USD_CEILING.starter);
    assert.equal(cursorAgentMaxUsdCeiling("unknown"), CURSOR_AGENT_MAX_USD_CEILING.trial);
  });
});

describe("talk minutes", () => {
  it("started minutes", () => {
    assert.equal(startedMinutes(0), 1);
    assert.equal(startedMinutes(1), 1);
    assert.equal(startedMinutes(60), 1);
    assert.equal(startedMinutes(61), 2);
    assert.equal(startedMinutes(185), 4);
  });
  it("free within the included minutes, charged after", () => {
    assert.deepEqual(talkMinuteCharges({ usedBefore: 58, minutes: 4, included: 60, perMinute: 4 }), [0, 0, 4, 4]);
    assert.deepEqual(talkMinuteCharges({ usedBefore: 0, minutes: 2, included: 0, perMinute: 1 }), [1, 1]);
    assert.deepEqual(talkMinuteCharges({ usedBefore: 10_000, minutes: 2, included: null, perMinute: 4 }), [0, 0]);
  });
});

describe("spoken answers", () => {
  it("every started 1,000 characters", () => {
    assert.equal(ttsCredits("elevenlabs", "eleven_flash_v2_5", 1), 16);
    assert.equal(ttsCredits("elevenlabs", "eleven_flash_v2_5", 1000), 16);
    assert.equal(ttsCredits("elevenlabs", "eleven_flash_v2_5", 1001), 32);
    assert.equal(ttsCredits("openai", "tts-1", 2000), 12);
    assert.equal(ttsCredits("voicestudio", null, 2000), 0);
    assert.equal(ttsCredits("mock", null, 500), 0);
    assert.equal(ttsCredits("openai", null, 0), 0);
  });
});
