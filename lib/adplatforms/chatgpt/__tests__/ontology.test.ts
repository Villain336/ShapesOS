// Marketr — Wave 2 ChatGPT Ads slice 1 tests: ontology rules.
// Run: npx tsx --test lib/adplatforms/chatgpt/__tests__/ontology.test.ts
//
// Pure: no database, no network. Covers the status machine, draft
// validation (fail closed without a budget cap), creative-variant
// provenance rules, and variant lineage.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  adsManagerDeepLink,
  assertStatusTransition,
  ChatGPTAdsError,
  deriveChildVariant,
  isValidStatusTransition,
  validateCampaignDraft,
  validateCreativeVariant,
  type ChatGPTCampaignDraftInput,
  type CreativeVariantInput,
} from "../types";

function draft(overrides: Partial<ChatGPTCampaignDraftInput> = {}): ChatGPTCampaignDraftInput {
  return {
    name: "Fall launch",
    accountId: "acct_1",
    targetTiers: ["free", "go"],
    topicIntentTags: ["crm software"],
    budgetDailyCents: 5000,
    ...overrides,
  };
}

function variant(overrides: Partial<CreativeVariantInput> = {}): CreativeVariantInput {
  return {
    headline: "Close more deals",
    body: "The CRM your team will actually use.",
    source: "human",
    ...overrides,
  };
}

describe("status machine", () => {
  it("allows the happy path draft → proposed → approved → live → paused → live → ended", () => {
    const path = [
      ["draft", "proposed"],
      ["proposed", "approved"],
      ["approved", "live"],
      ["live", "paused"],
      ["paused", "live"],
      ["live", "ended"],
    ] as const;
    for (const [from, to] of path) {
      assert.equal(isValidStatusTransition(from, to), true, `${from} → ${to}`);
    }
  });

  it("rejects skipping approval: draft → live is impossible", () => {
    assert.equal(isValidStatusTransition("draft", "live"), false);
    assert.equal(isValidStatusTransition("proposed", "live"), false);
  });

  it("rejects resurrection from ended", () => {
    for (const to of ["draft", "proposed", "approved", "live", "paused"] as const) {
      assert.equal(isValidStatusTransition("ended", to), false);
    }
  });

  it("assertStatusTransition throws ChatGPTAdsError with a code", () => {
    assert.throws(() => assertStatusTransition("live", "draft"), (e: unknown) => {
      assert.ok(e instanceof ChatGPTAdsError);
      assert.equal(e.code, "INVALID_STATUS_TRANSITION");
      return true;
    });
  });
});

describe("campaign draft validation", () => {
  it("accepts a fully-specified draft", () => {
    validateCampaignDraft(draft());
  });

  it("fails closed without any budget cap", () => {
    assert.throws(
      () => validateCampaignDraft(draft({ budgetDailyCents: null, budgetTotalCents: null })),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "BUDGET_CAP_REQUIRED",
    );
  });

  it("accepts a total-only budget", () => {
    validateCampaignDraft(draft({ budgetDailyCents: null, budgetTotalCents: 100000 }));
  });

  it("rejects non-positive budgets", () => {
    assert.throws(
      () => validateCampaignDraft(draft({ budgetDailyCents: 0 })),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "INVALID_BUDGET",
    );
    assert.throws(
      () => validateCampaignDraft(draft({ budgetTotalCents: -5 })),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "INVALID_BUDGET",
    );
  });

  it("rejects unknown tiers and bid strategies", () => {
    assert.throws(
      () => validateCampaignDraft(draft({ targetTiers: ["plus"] as never })),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "INVALID_TIER",
    );
    assert.throws(
      () => validateCampaignDraft(draft({ targetTiers: [] })),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "TIERS_REQUIRED",
    );
    assert.throws(
      () => validateCampaignDraft(draft({ bidStrategy: "cpa" as never })),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "INVALID_BID_STRATEGY",
    );
  });

  it("requires a name and a linked ad account", () => {
    assert.throws(
      () => validateCampaignDraft(draft({ name: "  " })),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "NAME_REQUIRED",
    );
    assert.throws(
      () => validateCampaignDraft(draft({ accountId: "" })),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "ACCOUNT_REQUIRED",
    );
  });
});

describe("creative variant validation", () => {
  it("accepts a human variant", () => {
    validateCreativeVariant(variant());
  });

  it("requires AI provenance for ai_generated variants", () => {
    assert.throws(
      () => validateCreativeVariant(variant({ source: "ai_generated" })),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "AI_PROVENANCE_REQUIRED",
    );
    validateCreativeVariant(
      variant({ source: "ai_generated", aiProviderUsed: "openai", aiModelUsed: "gpt-5" }),
    );
  });

  it("rejects empty copy and malformed locales", () => {
    assert.throws(
      () => validateCreativeVariant(variant({ headline: "" })),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "HEADLINE_REQUIRED",
    );
    assert.throws(
      () => validateCreativeVariant(variant({ locale: "english" })),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "INVALID_LOCALE",
    );
    validateCreativeVariant(variant({ locale: "es-MX" }));
  });
});

describe("variant lineage", () => {
  it("derives a child that keeps the parent link and inherits provenance", () => {
    const child = deriveChildVariant(
      { id: "v_parent", source: "ai_generated", aiProviderUsed: "openai", aiModelUsed: "gpt-5" },
      { headline: "Cierra más ventas", body: "El CRM que tu equipo sí usará.", source: "ai_generated", locale: "es-MX" },
    );
    assert.equal(child.parentVariantId, "v_parent");
    assert.equal(child.aiProviderUsed, "openai");
    assert.equal(child.aiModelUsed, "gpt-5");
  });

  it("child-declared provenance wins over inherited", () => {
    const child = deriveChildVariant(
      { id: "v_parent", source: "human" },
      { ...variant(), aiProviderUsed: "anthropic", aiModelUsed: "opus" },
    );
    assert.equal(child.aiProviderUsed, "anthropic");
  });
});

describe("ads manager deep link", () => {
  it("builds an ads.openai.com link carrying the campaign name", () => {
    const link = adsManagerDeepLink({ campaignName: "Fall launch" });
    assert.ok(link.startsWith("https://ads.openai.com/"));
    assert.ok(link.includes("Fall%20launch"));
  });
});
