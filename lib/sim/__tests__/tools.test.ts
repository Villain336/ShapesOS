// Phase 19B (WS=engine) — the town's agent tools and "do this for real",
// on deliberate tiers (lib/orchestrator/authority.ts evaluateTier reads the
// action kind AND "<tool>: <description>" for Tier-3 words):
//   list_town_runs           Tier 0 (a read)
//   start_town_rehearsal     Tier 2 (uses credits: asks; auto-able by rule)
//   apply_launch_change      Tier 2 ("do this for real" without money)
//   fund_launch_ad_campaign  Tier 3 ("do this for real" for an ad campaign: spend — never auto)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateTier } from "@/lib/orchestrator/authority";
import { getTool, TOOL_GROUP, toolAction } from "@/lib/chat/tools";
import { realActionFor, SIM_TOOLS } from "../tools";

const settings = { smallActionThresholdCents: 5_000, automationAllows: true, defaultCurrency: "USD" } as const;
const tierOf = (name: string) => {
  const t = getTool(name)!;
  return evaluateTier({ kind: toolAction(name), description: `${t.name}: ${t.description}` }, settings as never);
};

describe("town agent tools", () => {
  it("are registered with a group and their intended tiers", () => {
    for (const t of SIM_TOOLS) {
      assert.ok(getTool(t.name), `${t.name} registered`);
      assert.ok(TOOL_GROUP[t.name], `${t.name} has a group`);
    }
    assert.equal(tierOf("list_town_runs"), 0);
    assert.equal(getTool("list_town_runs")!.kind, "safe");
    assert.equal(tierOf("start_town_rehearsal"), 2);
    assert.notEqual(getTool("start_town_rehearsal")!.kind, "safe", "it asks before using credits");
    assert.equal(tierOf("apply_launch_change"), 2);
    assert.equal(tierOf("fund_launch_ad_campaign"), 3);
    assert.equal(getTool("fund_launch_ad_campaign")!.kind, "spend");
  });
});

describe('"do this for real"', () => {
  it("an ad campaign becomes the Tier-3 spend proposal; everything else the Tier-2 launch change", () => {
    assert.equal(realActionFor({ kind: "ad_campaign", channel: "social", startDay: 0, endDay: 6, dailyBudgetCents: 2_000, creative: "Hi" }).tool, "fund_launch_ad_campaign");
    for (const iv of [
      { kind: "price_change", day: 1, priceCents: 900 },
      { kind: "product_drop", day: 0 },
      { kind: "opening_hours", day: 0, openHour: 8, closeHour: 21 },
      { kind: "promotion", day: 0, endDay: 2, discountPct: 10, label: "Launch", event: true },
      { kind: "new_location", day: 2, lotId: "shop-3" },
    ] as const) {
      assert.equal(realActionFor(iv).tool, "apply_launch_change", iv.kind);
    }
  });
});
