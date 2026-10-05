// ShapesOS — Phase 3: DEPLOYMENT_MODE + hosted trial rules (pure).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TRIAL_DAYS,
  deploymentMode,
  initialPlanFor,
  isTrialExpired,
  lapsedPlanFor,
  trialDaysLeft,
  trialEndsAtFrom,
  trialExpiredMessage,
} from "../trial";
import { includedCreditsForPlan } from "@/lib/metering/credits";

const env = (v?: string) => ({ ...(v === undefined ? {} : { DEPLOYMENT_MODE: v }) }) as NodeJS.ProcessEnv;
const NOW = new Date("2026-10-04T12:00:00Z");

describe("deploymentMode", () => {
  it("defaults to self_hosted; only 'hosted' switches", () => {
    assert.equal(deploymentMode(env()), "self_hosted");
    assert.equal(deploymentMode(env("self_hosted")), "self_hosted");
    assert.equal(deploymentMode(env(" Hosted ")), "hosted");
    assert.equal(deploymentMode(env("cloud")), "self_hosted");
  });
});

describe("plan assignment by DEPLOYMENT_MODE", () => {
  it("self-hosted signups keep self_hosted with no trial", () => {
    assert.deepEqual(initialPlanFor({ mode: "self_hosted", hadTrial: false, now: NOW }), { plan: "self_hosted", trialEndsAt: null });
    assert.deepEqual(initialPlanFor({ mode: "self_hosted", hadTrial: true, now: NOW }), { plan: "self_hosted", trialEndsAt: null });
  });
  it("a hosted signup starts a 14-day trial", () => {
    const r = initialPlanFor({ mode: "hosted", hadTrial: false, now: NOW });
    assert.equal(r.plan, "trial");
    assert.equal(TRIAL_DAYS, 14);
    assert.equal(r.trialEndsAt?.toISOString(), "2026-10-18T12:00:00.000Z");
    assert.equal(isTrialExpired(r, NOW), false);
  });
  it("a second hosted workspace for the same person starts already ended", () => {
    const r = initialPlanFor({ mode: "hosted", hadTrial: true, now: NOW });
    assert.equal(r.plan, "trial");
    assert.equal(isTrialExpired(r, NOW), true);
  });
  it("a lapsed subscription returns to self_hosted only on self-hosted deployments", () => {
    assert.equal(lapsedPlanFor("self_hosted"), "self_hosted");
    assert.equal(lapsedPlanFor("hosted"), "trial");
  });
  it("the trial includes a small pool", () => {
    assert.equal(includedCreditsForPlan("trial"), 500);
    assert.equal(includedCreditsForPlan("self_hosted"), 0);
  });
});

describe("trial expiry", () => {
  const ends = trialEndsAtFrom(NOW);
  it("is never expired off the trial plan", () => {
    assert.equal(isTrialExpired({ plan: "starter", trialEndsAt: new Date(0) }, NOW), false);
    assert.equal(isTrialExpired({ plan: "self_hosted", trialEndsAt: null }, NOW), false);
    assert.equal(trialDaysLeft({ plan: "pro", trialEndsAt: null }, NOW), null);
  });
  it("expires exactly at trialEndsAt", () => {
    assert.equal(isTrialExpired({ plan: "trial", trialEndsAt: ends }, new Date(ends.getTime() - 1)), false);
    assert.equal(isTrialExpired({ plan: "trial", trialEndsAt: ends }, ends), true);
  });
  it("a trial without an end date fails closed", () => {
    assert.equal(isTrialExpired({ plan: "trial", trialEndsAt: null }, NOW), true);
  });
  it("counts whole days left, rounded up", () => {
    assert.equal(trialDaysLeft({ plan: "trial", trialEndsAt: ends }, NOW), 14);
    assert.equal(trialDaysLeft({ plan: "trial", trialEndsAt: ends }, new Date(ends.getTime() - 3_600_000)), 1);
    assert.equal(trialDaysLeft({ plan: "trial", trialEndsAt: ends }, ends), 0);
  });
  it("the refusal points at billing", () => {
    const msg = trialExpiredMessage(ends);
    assert.match(msg, /trial ended on 2026-10-18/);
    assert.match(msg, /\/dashboard\/billing/);
  });
});
