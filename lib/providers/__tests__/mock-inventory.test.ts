// ShapesOS — Phase 6: "What's running on mock data" inventory (pure).
// Run: npx tsx --test lib/providers/__tests__/mock-inventory.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mockInventory, notLive, type InventoryFacts, type FeatureStatus } from "../mock-inventory";

const allMockLlm: InventoryFacts["llm"] = {
  copy: { isLive: false, model: "claude-haiku-4-5", fallback: "ANTHROPIC_API_KEY is not set", singleKey: null, failover: null },
  bulk: { isLive: false, model: "gpt-5-nano", fallback: "LLM_API_KEY/OPENAI_API_KEY is not set", singleKey: null, failover: null },
  background: { isLive: false, model: "gpt-5-nano:flex", fallback: "LLM_API_KEY/OPENAI_API_KEY is not set", singleKey: null, failover: null },
};
const allLiveLlm: InventoryFacts["llm"] = {
  copy: { isLive: true, model: "claude-haiku-4-5", fallback: null, singleKey: null, failover: "gpt-5.4-nano" },
  bulk: { isLive: true, model: "gpt-5-nano", fallback: null, singleKey: null, failover: "claude-haiku-4-5" },
  background: { isLive: true, model: "gpt-5-nano:flex", fallback: null, singleKey: null, failover: "claude-haiku-4-5" },
};

const by = (entries: FeatureStatus[], key: string) => {
  const e = entries.find((x) => x.key === key);
  assert.ok(e, `missing entry ${key}`);
  return e;
};

const REQUIRED = [
  "llm-copy",
  "llm-bulk",
  "llm-background",
  "images",
  "seo-data",
  "contextdev",
  "email-messaging",
  "email-system",
  "sms",
  "calls",
  "stripe",
  "composio",
  "activepieces",
];

describe("mockInventory", () => {
  it("empty environment (dev): covers every feature and nothing is live", () => {
    const inv = mockInventory({ NODE_ENV: "development" }, { llm: allMockLlm, contextDevConnected: false });
    assert.deepEqual(inv.map((e) => e.key).sort(), [...REQUIRED].sort());
    assert.equal(inv.filter((e) => e.mode === "live").length, 0);
    // Things that run on sample data are "mock"; things that refuse are "off".
    for (const k of ["llm-copy", "llm-bulk", "llm-background", "seo-data", "email-messaging", "sms", "calls", "composio"]) {
      assert.equal(by(inv, k).mode, "mock", k);
    }
    for (const k of ["images", "contextdev", "email-system", "stripe", "activepieces"]) {
      assert.equal(by(inv, k).mode, "off", k);
    }
    assert.match(by(inv, "images").detail, /needs an OpenAI key/);
    assert.match(by(inv, "llm-copy").detail, /ANTHROPIC_API_KEY is not set/);
  });

  it("fully configured environment: everything is live", () => {
    const env = {
      NODE_ENV: "production",
      OPENAI_API_KEY: "x",
      DATAFORSEO_LOGIN: "l",
      DATAFORSEO_PASSWORD: "p",
      MESSAGING_EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "r",
      SMTP_HOST: "smtp.example.test",
      SMTP_FROM: "a@example.test",
      MESSAGING_SMS_PROVIDER: "twilio",
      CALLS_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: "s",
      TWILIO_AUTH_TOKEN: "t",
      STRIPE_SECRET_KEY: "k",
      STRIPE_WEBHOOK_SECRET: "w",
      COMPOSIO_API_KEY: "c",
      ACTIVEPIECES_URL: "https://ap.example.test/",
      ACTIVEPIECES_API_KEY: "a",
    };
    const inv = mockInventory(env, { llm: allLiveLlm, contextDevConnected: true });
    assert.deepEqual(notLive(inv), []);
    assert.match(by(inv, "llm-bulk").detail, /Fails over to claude-haiku-4-5/);
  });

  it("an empty LLM_API_KEY does not mask OPENAI_API_KEY for images (matches the route)", () => {
    const inv = mockInventory({ LLM_API_KEY: "", OPENAI_API_KEY: "x" }, { llm: allMockLlm, contextDevConnected: false });
    assert.equal(by(inv, "images").mode, "live");
    const blank = mockInventory({ LLM_API_KEY: "  ", OPENAI_API_KEY: "" }, { llm: allMockLlm, contextDevConnected: false });
    assert.equal(by(blank, "images").mode, "off");
  });

  it("images report the image model, and an off-list LLM_IMAGE_MODEL is off (the service refuses it)", () => {
    const live = mockInventory({ OPENAI_API_KEY: "x" }, { llm: allMockLlm, contextDevConnected: false });
    assert.equal(by(live, "images").mode, "live");
    assert.match(by(live, "images").detail, /gpt-image-2/);
    const offList = mockInventory({ OPENAI_API_KEY: "x", LLM_IMAGE_MODEL: "dall-e-3" }, { llm: allMockLlm, contextDevConnected: false });
    assert.equal(by(offList, "images").mode, "off");
    assert.match(by(offList, "images").detail, /not on the OpenAI image allow-list/);
  });

  it("DataForSEO needs both login and password", () => {
    const inv = mockInventory({ DATAFORSEO_LOGIN: "l" }, { llm: allMockLlm, contextDevConnected: false });
    assert.equal(by(inv, "seo-data").mode, "mock");
  });

  it("a selected real provider without credentials is off, not mock", () => {
    const inv = mockInventory(
      { MESSAGING_EMAIL_PROVIDER: "resend", MESSAGING_SMS_PROVIDER: "twilio", CALLS_PROVIDER: "Twilio", TWILIO_ACCOUNT_SID: "s" },
      { llm: allMockLlm, contextDevConnected: false },
    );
    assert.equal(by(inv, "email-messaging").mode, "off");
    assert.equal(by(inv, "sms").mode, "off");
    assert.equal(by(inv, "calls").mode, "off");
    assert.match(by(inv, "sms").detail, /TWILIO_AUTH_TOKEN/);
  });

  it("fake providers are refused in production unless ALLOW_FAKE_PROVIDERS=1", () => {
    const prod = mockInventory({ NODE_ENV: "production" }, { llm: allMockLlm, contextDevConnected: false });
    assert.equal(by(prod, "email-messaging").mode, "off");
    assert.equal(by(prod, "sms").mode, "off");
    const demo = mockInventory({ NODE_ENV: "production", ALLOW_FAKE_PROVIDERS: "1" }, { llm: allMockLlm, contextDevConnected: false });
    assert.equal(by(demo, "sms").mode, "mock");
  });

  it("invites via Resend while alerts stay off without SMTP", () => {
    const inv = mockInventory({ RESEND_API_KEY: "r", INVITE_MAIL_FROM: "x@example.test" }, { llm: allMockLlm, contextDevConnected: false });
    assert.equal(by(inv, "email-system").mode, "off");
    assert.match(by(inv, "email-system").detail, /Invites go out through Resend/);
  });

  it("Stripe needs both secrets; Activepieces needs a usable URL and a key", () => {
    const inv = mockInventory(
      { STRIPE_SECRET_KEY: "k", ACTIVEPIECES_URL: "   ", ACTIVEPIECES_API_KEY: "a" },
      { llm: allMockLlm, contextDevConnected: false },
    );
    assert.equal(by(inv, "stripe").mode, "off");
    assert.equal(by(inv, "activepieces").mode, "off");
  });

  it("Context.dev unknown is reported honestly", () => {
    const inv = mockInventory({}, { llm: allMockLlm, contextDevConnected: null });
    assert.equal(by(inv, "contextdev").mode, "off");
    assert.match(by(inv, "contextdev").detail, /Could not check/);
  });

  it("single-key explanation reaches the LLM entry", () => {
    const llm = {
      ...allLiveLlm,
      copy: { isLive: true, model: "gpt-5.4-nano", fallback: null, singleKey: 'Default "claude-haiku-4-5" swapped: ANTHROPIC_API_KEY is not set.', failover: null },
    };
    const inv = mockInventory({}, { llm, contextDevConnected: false });
    assert.match(by(inv, "llm-copy").detail, /Live on gpt-5.4-nano\. Default "claude-haiku-4-5" swapped/);
    assert.match(by(inv, "llm-copy").detail, /No failover model configured/);
  });

  it("notLive lists mock before off and drops live entries", () => {
    const inv = mockInventory({ OPENAI_API_KEY: "x" }, { llm: allMockLlm, contextDevConnected: false });
    const nl = notLive(inv);
    assert.ok(!nl.some((e) => e.mode === "live"));
    const firstOff = nl.findIndex((e) => e.mode === "off");
    assert.ok(nl.slice(firstOff).every((e) => e.mode === "off"));
  });

  it("never returns key material — env var names only", () => {
    const secret = "test-secret-value-ZZZ999";
    const env = { OPENAI_API_KEY: secret, STRIPE_SECRET_KEY: secret, STRIPE_WEBHOOK_SECRET: secret, COMPOSIO_API_KEY: secret, RESEND_API_KEY: secret };
    const blob = JSON.stringify(mockInventory(env, { llm: allLiveLlm, contextDevConnected: true }));
    assert.ok(!blob.includes(secret));
  });
});
