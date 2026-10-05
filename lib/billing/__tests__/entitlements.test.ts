// ShapesOS — plan entitlements (Phase 4a). Pure: no database.
// Run: npx tsx --test lib/billing/__tests__/entitlements.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EntitlementError,
  FEATURES,
  LIMITS,
  PLAN_ENTITLEMENTS,
  cheapestPlanWith,
  effectiveWhiteLabel,
  entitlementDenied,
  entitlementSummary,
  entitlementsFor,
  featureUpgradeMessage,
  limitReached,
  limitUpgradeMessage,
  planHasFeature,
  planLimit,
  type Feature,
} from "../entitlements";
import {
  hasEntitlement,
  requireEntitlement,
  requireWithinLimit,
  workspaceCreationDenialFor,
} from "../entitlements-server";
import { classifyError } from "@/lib/api/errors";
import { PLANS, planOffer } from "../plans";

const lookup = (plan: string | null) => async () => plan;

// The product decision, per feature: which plans include it.
// Phase 15.3: Business (SSO/SCIM, Pro features); digital_twin/payroll/pos
// on Pro and up — and on trial and self_hosted, which keep everything they had.
const EXPECTED: Record<Feature, string[]> = {
  white_label: ["self_hosted", "agency"],
  custom_branding: ["self_hosted", "trial", "pro", "business", "agency"],
  custom_domain: ["self_hosted", "agency"],
  api_access: ["self_hosted", "trial", "pro", "business", "agency"],
  webhooks: ["self_hosted", "trial", "pro", "business", "agency"],
  sso: ["self_hosted", "business", "agency"],
  scim: ["self_hosted", "business", "agency"],
  digital_twin: ["self_hosted", "trial", "pro", "business", "agency"],
  payroll: ["self_hosted", "trial", "pro", "business", "agency"],
  pos: ["self_hosted", "trial", "pro", "business", "agency"],
};

describe("entitlement table", () => {
  for (const feature of FEATURES) {
    it(`${feature}: included exactly on ${EXPECTED[feature].join(", ")}`, () => {
      for (const plan of Object.keys(PLAN_ENTITLEMENTS)) {
        assert.equal(planHasFeature(plan, feature), EXPECTED[feature].includes(plan), `${plan} × ${feature}`);
      }
    });
  }

  it("self_hosted gets every feature and no limits", () => {
    for (const f of FEATURES) assert.equal(planHasFeature("self_hosted", f), true);
    for (const l of LIMITS) assert.equal(planLimit("self_hosted", l), null);
  });

  it("unknown or missing plans fail closed", () => {
    for (const plan of ["enterprise", "", null, undefined]) {
      for (const f of FEATURES) assert.equal(planHasFeature(plan, f), false);
      for (const l of LIMITS) assert.equal(planLimit(plan, l), 0);
    }
  });

  it("limits follow the Phase 15.3 plan table", () => {
    assert.deepEqual(entitlementsFor("starter").limits, { seats: 3, workspaces: 1, projects: 1, twin_sites: 0 });
    assert.deepEqual(entitlementsFor("pro").limits, { seats: 10, workspaces: 3, projects: 5, twin_sites: 3 });
    assert.deepEqual(entitlementsFor("business").limits, { seats: 25, workspaces: 10, projects: null, twin_sites: null });
    assert.deepEqual(entitlementsFor("agency").limits, { seats: 5, workspaces: 25, projects: null, twin_sites: null });
    assert.deepEqual(entitlementsFor("trial").limits, { seats: 3, workspaces: 1, projects: 1, twin_sites: null });
  });

  it("limitReached counts the next one", () => {
    assert.equal(limitReached("starter", "seats", 2), false);
    assert.equal(limitReached("starter", "seats", 3), true);
    assert.equal(limitReached("pro", "twin_sites", 2), false);
    assert.equal(limitReached("pro", "twin_sites", 3), true);
    assert.equal(limitReached("business", "twin_sites", 10_000), false);
    assert.equal(limitReached("agency", "projects", 10_000), false);
    assert.equal(limitReached("self_hosted", "seats", 10_000), false);
    assert.equal(limitReached("self_hosted", "twin_sites", 10_000), false);
  });

  it("plan cards advertise the enforced seat/project/twin numbers (derived, not typed twice)", () => {
    const card = (id: string) => planOffer(id as never).lines.join(" · ");
    assert.match(card("starter"), /3 seats included/);
    assert.match(card("starter"), /1 SEO project/);
    assert.doesNotMatch(card("starter"), /Digital twin/);
    assert.match(card("pro"), /10 seats included/);
    assert.match(card("pro"), /5 SEO projects/);
    assert.match(card("pro"), /Digital twin, 3 sites/);
    assert.match(card("business"), /25 seats included/);
    assert.match(card("business"), /Digital twin, unlimited sites/);
    assert.match(card("agency"), /5 seats included/);
    assert.match(card("agency"), /White-label/);
    assert.doesNotMatch(card("pro"), /White-label/);
    for (const p of PLANS) {
      for (const f of p.features) assert.doesNotMatch(f, /\d/, `${p.id}: "${f}" must not hard-code a number`);
    }
  });

  it("summary is client-safe and complete", () => {
    const s = entitlementSummary("pro");
    assert.equal(s.plan, "pro");
    assert.deepEqual(Object.keys(s.features).sort(), [...FEATURES].sort());
    assert.equal(s.features.webhooks, true);
    assert.equal(s.features.white_label, false);
    assert.equal(s.limits.seats, 10);
    assert.equal(s.limits.twin_sites, 3);
  });
});

describe("upgrade messages and errors", () => {
  it("names the cheapest plan with the feature", () => {
    assert.equal(cheapestPlanWith("api_access"), "pro");
    assert.equal(cheapestPlanWith("white_label"), "agency");
    assert.equal(cheapestPlanWith("sso"), "business", "a business needing SSO is pointed at Business, not Agency");
    assert.equal(cheapestPlanWith("digital_twin"), "pro");
    assert.equal(cheapestPlanWith("payroll"), "pro");
    assert.equal(cheapestPlanWith("pos"), "pro");
    assert.match(featureUpgradeMessage("webhooks"), /Outbound webhooks isn't included in your plan\. Upgrade to Pro/);
    assert.match(featureUpgradeMessage("scim"), /Upgrade to Business/);
    assert.match(featureUpgradeMessage("payroll"), /Payroll isn't included in your plan\. Upgrade to Pro/);
    assert.match(limitUpgradeMessage("twin_sites", 3), /Your plan includes 3 twin sites\. Upgrade to Business/);
  });

  it("EntitlementError maps to a 403 with an upgrade code", async () => {
    const err = new EntitlementError(featureUpgradeMessage("sso"), "sso");
    const mapped = classifyError(err);
    assert.equal(mapped.status, 403);
    assert.equal(mapped.body.code, "upgrade_required");
    const res = entitlementDenied(err);
    assert.equal(res.status, 403);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.entitlement, "sso");
    assert.equal(body.upgradePath, "/dashboard/billing");
  });
});

describe("server checks (injected plan lookup)", () => {
  it("hasEntitlement reads the workspace plan — e.g. the SCIM seam", async () => {
    assert.equal(await hasEntitlement("ws", "scim", lookup("agency")), true);
    assert.equal(await hasEntitlement("ws", "scim", lookup("business")), true);
    assert.equal(await hasEntitlement("ws", "scim", lookup("pro")), false);
    assert.equal(await hasEntitlement("ws", "scim", lookup(null)), false);
  });

  for (const feature of FEATURES) {
    it(`requireEntitlement(${feature}) throws 403 on starter, passes on self_hosted`, async () => {
      await assert.rejects(requireEntitlement("ws", feature, lookup("starter")), (e: unknown) => {
        assert.ok(e instanceof EntitlementError);
        assert.equal(e.status, 403);
        assert.equal(e.entitlement, feature);
        return true;
      });
      await requireEntitlement("ws", feature, lookup("self_hosted"));
    });
  }

  for (const limit of LIMITS) {
    it(`requireWithinLimit(${limit}) blocks at the pro cap`, async () => {
      const max = planLimit("pro", limit)!;
      if (max > 0) await requireWithinLimit("ws", limit, max - 1, lookup("pro"));
      await assert.rejects(requireWithinLimit("ws", limit, max, lookup("pro")), EntitlementError);
      await requireWithinLimit("ws", limit, 1_000_000, lookup("self_hosted"));
    });
  }

  it("workspace allowance follows the most generous owned plan", () => {
    assert.equal(workspaceCreationDenialFor([]), null, "first workspace is always allowed");
    assert.ok(workspaceCreationDenialFor(["starter"]) instanceof EntitlementError);
    assert.equal(workspaceCreationDenialFor(["pro"]), null);
    assert.ok(workspaceCreationDenialFor(["pro", "trial", "starter"]) instanceof EntitlementError);
    assert.equal(workspaceCreationDenialFor(["agency", "trial", "trial"]), null);
    assert.equal(workspaceCreationDenialFor(Array(50).fill("self_hosted")), null);
    assert.ok(workspaceCreationDenialFor(Array(25).fill("agency")) instanceof EntitlementError);
    assert.equal(workspaceCreationDenialFor(Array(9).fill("business")), null);
    assert.ok(workspaceCreationDenialFor(Array(10).fill("business")) instanceof EntitlementError);
  });
});

describe("white-label stops working without the entitlement", () => {
  const stored = {
    whiteLabelLogoUrl: "logos/wl-x.png",
    whiteLabelCustomDomain: "reviews.acme.test",
    whiteLabelBrandColor: "#123456",
  };

  it("agency and self_hosted render every field", () => {
    for (const plan of ["agency", "self_hosted"]) {
      assert.deepEqual(effectiveWhiteLabel({ plan, ...stored }), {
        logoUrl: "logos/wl-x.png",
        customDomain: "reviews.acme.test",
        brandColor: "#123456",
      });
    }
  });

  it("starter, pro, business and trial render ShapesOS defaults even with stored values", () => {
    for (const plan of ["starter", "pro", "business", "trial", "nonsense"]) {
      assert.deepEqual(effectiveWhiteLabel({ plan, ...stored }), {
        logoUrl: null,
        customDomain: null,
        brandColor: null,
      });
    }
  });
});
