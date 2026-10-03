// ShapesOS — Phase 3: onboarding wizard rules (pure) + emailed invites.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  connectionSuggestions,
  isOnboardingStep,
  needsOnboarding,
  normalizeWebsite,
  parseBusinessProfile,
} from "../onboarding";
import { appBaseUrl, inviteMailChannel, renderInviteEmail, sendInviteEmail } from "../invite-mail";
import { BadRequestError } from "@/lib/api/errors";

describe("onboarding: who sees the wizard", () => {
  it("only admins+ of a workspace that hasn't finished or skipped it", () => {
    const fresh = { onboardingCompletedAt: null };
    const done = { onboardingCompletedAt: new Date() };
    assert.equal(needsOnboarding(fresh, "owner"), true);
    assert.equal(needsOnboarding(fresh, "admin"), true);
    assert.equal(needsOnboarding(fresh, "editor"), false);
    assert.equal(needsOnboarding(fresh, null), false);
    assert.equal(needsOnboarding(done, "owner"), false);
  });
  it("knows its steps", () => {
    assert.equal(isOnboardingStep("business"), true);
    assert.equal(isOnboardingStep("billing"), false);
  });
});

describe("onboarding: business context", () => {
  it("reduces a website to its host", () => {
    assert.equal(normalizeWebsite("https://www.Acme.com/about?x=1"), "www.acme.com");
    assert.equal(normalizeWebsite("acme.co.uk"), "acme.co.uk");
    assert.equal(normalizeWebsite("  "), null);
    assert.equal(normalizeWebsite(undefined), null);
    assert.throws(() => normalizeWebsite("not a site"), BadRequestError);
    assert.throws(() => normalizeWebsite("javascript:alert(1)"), BadRequestError);
    assert.throws(() => normalizeWebsite("localhost"), BadRequestError);
  });
  it("validates the profile and de-duplicates goals", () => {
    assert.deepEqual(
      parseBusinessProfile({ businessType: "ecommerce", website: "shop.test", goals: ["leads", "leads", "ads"], notes: "  Sell bikes " }),
      { businessType: "ecommerce", website: "shop.test", goals: ["leads", "ads"], notes: "Sell bikes" },
    );
    assert.deepEqual(parseBusinessProfile({}), { businessType: null, website: null, goals: [], notes: null });
    assert.throws(() => parseBusinessProfile({ businessType: "rocketry" }), BadRequestError);
    assert.throws(() => parseBusinessProfile({ goals: ["world_domination"] }), BadRequestError);
    assert.throws(() => parseBusinessProfile({ goals: "leads" }), BadRequestError);
    assert.throws(() => parseBusinessProfile({ notes: "x".repeat(1001) }), BadRequestError);
  });
  it("suggests first connections by business type, boosted by goals", () => {
    const local = connectionSuggestions({ businessType: "local_service", goals: [] }).map((s) => s.key);
    assert.deepEqual(local, ["gbp", "ga4", "social", "crm"]);
    const shop = connectionSuggestions({ businessType: "ecommerce", goals: ["reviews"] }).map((s) => s.key);
    assert.equal(shop[0], "gbp");
    assert.equal(shop.length, 4);
    for (const s of connectionSuggestions({ businessType: null, goals: ["ads", "social"] })) {
      assert.match(s.href, /^\/dashboard\//);
    }
  });
});

describe("invite emails", () => {
  const e = (o: Record<string, string>) => o as NodeJS.ProcessEnv;
  it("prefers SMTP, then Resend, else not configured", () => {
    assert.equal(inviteMailChannel(e({ SMTP_HOST: "smtp.x", SMTP_FROM: "a@x.test", RESEND_API_KEY: "re_1", INVITE_MAIL_FROM: "b@x.test" })), "smtp");
    assert.equal(inviteMailChannel(e({ RESEND_API_KEY: "re_1", INVITE_MAIL_FROM: "b@x.test" })), "resend");
    assert.equal(inviteMailChannel(e({ RESEND_API_KEY: "re_1" })), null);
    assert.equal(inviteMailChannel(e({ SMTP_HOST: "smtp.x" })), null);
  });
  it("builds links from configured URLs before the request origin", () => {
    assert.equal(appBaseUrl(e({ APP_URL: "https://app.shapes.test/x" }), "http://evil.test"), "https://app.shapes.test");
    assert.equal(appBaseUrl(e({}), "http://localhost:3000"), "http://localhost:3000");
    assert.equal(appBaseUrl(e({ APP_URL: "ftp://x" }), null), null);
  });
  it("escapes names in the HTML body", () => {
    const m = renderInviteEmail({
      to: "new@x.test",
      workspaceName: "<b>Acme</b>",
      inviterName: "Ana",
      role: "editor",
      inviteUrl: "https://app.test/invite?token=abc",
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    });
    assert.doesNotMatch(m.html, /<b>Acme<\/b>/);
    assert.match(m.html, /&lt;b&gt;Acme&lt;\/b&gt;/);
    assert.match(m.text, /https:\/\/app\.test\/invite\?token=abc/);
    assert.match(m.subject, /ShapesOS/);
  });
  const base = {
    to: "new@x.test",
    workspaceName: "Acme",
    inviterName: "Ana",
    role: "viewer",
    inviteUrl: "/invite?token=tok123",
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
  };
  it("sends an absolute link through the configured channel", async () => {
    const sent: { channel: string; to: string; text: string; from: string }[] = [];
    const r = await sendInviteEmail(base, {
      env: e({ RESEND_API_KEY: "re_1", INVITE_MAIL_FROM: "team@x.test", APP_URL: "https://app.x.test" }),
      deliver: async (channel, msg) => {
        sent.push({ channel, to: msg.to, text: msg.text, from: msg.from });
      },
    });
    assert.deepEqual(r, { sent: true, channel: "resend" });
    assert.equal(sent[0]?.to, "new@x.test");
    assert.equal(sent[0]?.from, "team@x.test");
    assert.match(sent[0]!.text, /https:\/\/app\.x\.test\/invite\?token=tok123/);
  });
  it("falls back to copy-link when mail isn't set up, has no base URL, or fails", async () => {
    const none = await sendInviteEmail(base, { env: e({}) });
    assert.equal(none.sent, false);
    assert.equal(!none.sent && none.reason, "not_configured");
    const noBase = await sendInviteEmail(base, { env: e({ SMTP_HOST: "s", SMTP_FROM: "f@x.test" }), deliver: async () => {} });
    assert.equal(!noBase.sent && noBase.reason, "no_base_url");
    const failed = await sendInviteEmail(
      { ...base, requestOrigin: "http://localhost:3000" },
      { env: e({ SMTP_HOST: "s", SMTP_FROM: "f@x.test" }), deliver: async () => { throw new Error("535 auth tok123"); } },
    );
    assert.equal(!failed.sent && failed.reason, "send_failed");
    assert.doesNotMatch(JSON.stringify(failed), /tok123/);
  });
});
