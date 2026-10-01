// Marketr — Wave 2 ChatGPT Ads slice 4 tests: reporting + conversions.
// Run: npx tsx --test lib/adplatforms/chatgpt/__tests__/reporting.test.ts
//
// Pure aggregation math, the 20% CPA-drift variance rule, and the
// Conversions API builders + terms gate. The alert raise is injected — no
// database, no network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkCpaVariance,
  summarizeAdRows,
  type AdReportRowLike,
} from "../reporting";
import {
  buildConversionEvent,
  sendConversionEvent,
} from "../conversions";
import { ChatGPTAdsError } from "../types";

function row(date: string, spendCents: number, conversions: number, extra: Partial<AdReportRowLike> = {}): AdReportRowLike {
  return {
    date: new Date(`${date}T00:00:00Z`),
    spendCents,
    impressions: 1000,
    clicks: 20,
    conversions,
    revenueCents: 0,
    ...extra,
  };
}

describe("summarizeAdRows", () => {
  it("aggregates daily rows into totals with CTR and CPA", () => {
    const summary = summarizeAdRows([
      row("2026-09-20", 5000, 5),
      row("2026-09-21", 3000, 3),
    ]);
    assert.equal(summary.days.length, 2);
    assert.equal(summary.totals.spendCents, 8000);
    assert.equal(summary.totals.impressions, 2000);
    assert.equal(summary.totals.clicks, 40);
    assert.equal(summary.totals.ctr, 0.02);
    assert.equal(summary.totals.conversions, 8);
    assert.equal(summary.totals.cpaCents, 1000);
    assert.equal(summary.days[0].date, "2026-09-20");
    assert.equal(summary.days[0].cpaCents, 1000);
  });

  it("returns null CTR/CPA when there is no denominator", () => {
    const summary = summarizeAdRows([
      row("2026-09-20", 5000, 0, { impressions: 0, clicks: 0 }),
    ]);
    assert.equal(summary.totals.ctr, null);
    assert.equal(summary.totals.cpaCents, null);
  });
});

const CTX = { workspaceId: "ws_rep", actor: "user_rep" };
const NOW = new Date("2026-10-01T12:00:00Z");

function windowRows(recentCpaDollars: number, priorCpaDollars: number): AdReportRowLike[] {
  // 7 recent days (2026-09-24..30) and 7 prior days (2026-09-17..23),
  // each day $100 spend with conversions set to hit the target CPA.
  const rows: AdReportRowLike[] = [];
  for (let d = 17; d <= 23; d++) {
    rows.push(row(`2026-09-${d}`, 10000, 10000 / (priorCpaDollars * 100)));
  }
  for (let d = 24; d <= 30; d++) {
    rows.push(row(`2026-09-${d}`, 10000, 10000 / (recentCpaDollars * 100)));
  }
  return rows;
}

describe("checkCpaVariance", () => {
  it("flags a CPA rise past 20% and raises one alert", async () => {
    const raised: Array<{ dedupKey: string }> = [];
    const result = await checkCpaVariance(CTX, {
      chatGPTCampaignId: "cgpt_1",
      campaignName: "Fall launch",
      paidCampaignId: "paid_1",
      rows: windowRows(25, 20), // $25 vs $20 → +25%
      now: NOW,
      raiseAlert: async (a) => {
        raised.push({ dedupKey: a.dedupKey });
        return ["evt_1"];
      },
    });
    assert.equal(result.flagged, true);
    assert.ok(Math.abs((result.driftRatio ?? 0) - 0.25) < 0.001);
    assert.deepEqual(result.alertEventIds, ["evt_1"]);
    assert.equal(raised.length, 1);
    assert.equal(raised[0].dedupKey, "chatgpt_cpa_drift:cgpt_1:2026-10-01");
  });

  it("flags a CPA fall past 20%", async () => {
    const result = await checkCpaVariance(CTX, {
      chatGPTCampaignId: "cgpt_1",
      campaignName: "Fall launch",
      paidCampaignId: "paid_1",
      rows: windowRows(14, 20), // $14 vs $20 → -30%
      now: NOW,
      raiseAlert: async () => ["evt_1"],
    });
    assert.equal(result.flagged, true);
    assert.ok((result.driftRatio ?? 0) < -0.2);
  });

  it("stays quiet inside the 20% band", async () => {
    let raised = 0;
    const result = await checkCpaVariance(CTX, {
      chatGPTCampaignId: "cgpt_1",
      campaignName: "Fall launch",
      paidCampaignId: "paid_1",
      rows: windowRows(22, 20), // +10% — under the line
      now: NOW,
      raiseAlert: async () => {
        raised++;
        return ["evt_1"];
      },
    });
    assert.equal(result.flagged, false);
    assert.equal(raised, 0);
  });

  it("cannot flag without conversion data", async () => {
    const result = await checkCpaVariance(CTX, {
      chatGPTCampaignId: "cgpt_1",
      campaignName: "Fall launch",
      paidCampaignId: "paid_1",
      rows: [row("2026-09-25", 5000, 0)],
      now: NOW,
      raiseAlert: async () => {
        throw new Error("must not raise");
      },
    });
    assert.equal(result.flagged, false);
    assert.ok(result.reason?.includes("insufficient"));
  });
});

describe("buildConversionEvent", () => {
  it("builds a well-formed event from OS inputs", () => {
    const event = buildConversionEvent({
      eventName: "purchase",
      eventId: "evt_123",
      eventTime: new Date("2026-10-01T12:00:00Z"),
      userData: { em: ["a".repeat(64)] },
      valueCents: 4999,
      currency: "USD",
      orderId: "ord_1",
    });
    assert.equal(event.event_name, "purchase");
    assert.equal(event.event_time, Math.floor(new Date("2026-10-01T12:00:00Z").getTime() / 1000));
    assert.equal(event.event_id, "evt_123");
    assert.deepEqual(event.custom_data.value, 49.99);
    assert.deepEqual(event.custom_data.order_id, "ord_1");
  });

  it("refuses raw PII — hashes only", () => {
    assert.throws(
      () =>
        buildConversionEvent({
          eventName: "signup",
          eventId: "evt_2",
          userData: { em: ["user@example.com"] },
        }),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "PII_MUST_BE_HASHED",
    );
  });
});

describe("sendConversionEvent", () => {
  const event = buildConversionEvent({ eventName: "signup", eventId: "evt_9" });

  it("refuses to send without tenant terms acceptance", async () => {
    await assert.rejects(
      () => sendConversionEvent({ event, termsAccepted: false }, { endpoint: "https://example.test/capi" }),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "TERMS_NOT_ACCEPTED",
    );
  });

  it("refuses to send without a configured endpoint", async () => {
    await assert.rejects(
      () => sendConversionEvent({ event, termsAccepted: true }, {}),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "CONVERSIONS_API_NOT_CONFIGURED",
    );
  });

  it("posts the event when accepted and configured", async () => {
    const seen: Array<{ url: unknown; body: unknown }> = [];
    const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const result = await sendConversionEvent(
      { event, termsAccepted: true },
      { endpoint: "https://example.test/capi", fetchImpl },
    );
    assert.equal(result.ok, true);
    assert.equal(result.eventId, "evt_9");
    assert.equal(seen.length, 1);
    assert.equal((seen[0].body as { data: unknown[] }).data.length, 1);
  });

  it("surfaces platform rejections instead of swallowing them", async () => {
    const fetchImpl = (async () => new Response("bad event", { status: 400 })) as typeof fetch;
    await assert.rejects(
      () =>
        sendConversionEvent(
          { event, termsAccepted: true },
          { endpoint: "https://example.test/capi", fetchImpl },
        ),
      (e: unknown) => e instanceof ChatGPTAdsError && e.code === "CONVERSIONS_API_REJECTED",
    );
  });
});
