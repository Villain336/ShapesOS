// ShapesOS Phase 15.1 — Smartlead / Instantly are the workspace's own (BYOK).
// The workspace's vault account always wins; host env keys are the
// SELF-HOSTED fallback only and never used on hosted. (Pure, no DB.)
// Run: npx tsx --test lib/authority/outreach/__tests__/partner-config.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { outreachPartnerConfig } from "../partner-config";
import { NotConfiguredError, resolveSendingPartner } from "@/lib/authority/fake";

const ENV = {
  SMARTLEAD_API_KEY: "host-smartlead",
  SMARTLEAD_RELAY_CAMPAIGN_IDS: "1,2,3",
  INSTANTLY_API_KEY: "host-instantly",
  INSTANTLY_RELAY_CAMPAIGN_IDS: "a,b,c",
};

describe("outreachPartnerConfig", () => {
  it("uses the workspace's own account first", () => {
    const cfg = outreachPartnerConfig({
      workspace: { instantly: { apiKey: "ws-instantly", relayCampaignIds: "x,y" } },
      env: ENV,
      mode: "self_hosted",
    });
    assert.deepEqual(cfg, { provider: "instantly", apiKey: "ws-instantly", relayCampaignIds: "x,y", source: "workspace" });
  });

  it("OUTREACH_SENDING_PROVIDER breaks a tie when the workspace has both", () => {
    const both = { smartlead: { apiKey: "s", relayCampaignIds: "1" }, instantly: { apiKey: "i", relayCampaignIds: "2" } };
    assert.equal(outreachPartnerConfig({ workspace: both, env: {}, mode: "hosted" }).provider, "smartlead");
    assert.equal(outreachPartnerConfig({ workspace: both, env: { OUTREACH_SENDING_PROVIDER: "instantly" }, mode: "hosted" }).provider, "instantly");
  });

  it("self-hosted falls back to the host env keys", () => {
    const cfg = outreachPartnerConfig({ workspace: {}, env: ENV, mode: "self_hosted" });
    assert.deepEqual(cfg, { provider: "smartlead", apiKey: "host-smartlead", relayCampaignIds: "1,2,3", source: "env" });
  });

  it("hosted NEVER uses the host env keys — no account means not configured", () => {
    const cfg = outreachPartnerConfig({ workspace: {}, env: ENV, mode: "hosted" });
    assert.deepEqual(cfg, { provider: "smartlead", apiKey: null, relayCampaignIds: null, source: "none" });
    // In production (fakes refused) that is an honest NotConfiguredError
    // pointing at Settings → Providers.
    const prev = process.env.NODE_ENV;
    const prevAllow = process.env.ALLOW_FAKE_PROVIDERS;
    (process.env as Record<string, string>).NODE_ENV = "production";
    delete process.env.ALLOW_FAKE_PROVIDERS;
    try {
      assert.throws(() => resolveSendingPartner({ provider: cfg.provider, apiKey: cfg.apiKey }), (e: unknown) =>
        e instanceof NotConfiguredError && /Settings → Providers/.test(e.message),
      );
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = prev;
      if (prevAllow !== undefined) process.env.ALLOW_FAKE_PROVIDERS = prevAllow;
    }
  });
});
