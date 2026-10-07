// ShapesOS — Phase 19B (WS=engine): a rehearsal scenario and its
// interventions — SIMULATED OBJECTS ONLY.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// An intervention changes the simulated town and nothing else: no price, ad,
// event or store record anywhere in ShapesOS is read or written by the
// engine (proved by lib/sim/__tests__/run-db.test.ts, which diffs the real
// tables around a run). "Do this for real" is a separate, explicit step that
// becomes a normal proposal through executeTool (lib/sim/real.server.ts);
// anything that spends is Tier 3 and always asks a person.
//
//   product_drop   your product goes on sale on `day` (before it, nothing to buy)
//   price_change   a new price from `day`
//   ad_campaign    billboard / social / search, a daily budget and a creative, days [startDay, endDay]
//   opening_hours  your store's hours from `day`
//   promotion      a discount over [day, endDay]; `event` also draws a crowd that day
//   new_location   another lot becomes a store of yours from `day`
// Days count from 0 (the run's first day, a Monday).

import { z } from "zod";

export const MAX_RUN_DAYS = 30;
const day = z.number().int().min(0).max(MAX_RUN_DAYS - 1);
const cents = z.number().int().min(0).max(100_000_000);

export const ProductSchema = z.object({
  name: z.string().trim().min(1).max(80),
  category: z.string().trim().min(1).max(60),
  priceCents: z.number().int().min(1).max(10_000_000),
  description: z.string().trim().max(500).default(""),
});
export type Product = z.infer<typeof ProductSchema>;

export const AD_CHANNELS = ["billboard", "social", "search"] as const;
export type AdChannel = (typeof AD_CHANNELS)[number];

export const InterventionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("product_drop"), day }),
  z.object({ kind: z.literal("price_change"), day, priceCents: z.number().int().min(1).max(10_000_000) }),
  z.object({
    kind: z.literal("ad_campaign"),
    channel: z.enum(AD_CHANNELS),
    startDay: day,
    endDay: day,
    dailyBudgetCents: cents,
    creative: z.string().trim().min(1).max(280),
  }),
  z.object({ kind: z.literal("opening_hours"), day, openHour: z.number().int().min(0).max(23), closeHour: z.number().int().min(1).max(24) }),
  z.object({ kind: z.literal("promotion"), day, endDay: day, discountPct: z.number().int().min(0).max(90), label: z.string().trim().min(1).max(80), event: z.boolean().default(false) }),
  z.object({ kind: z.literal("new_location"), day, lotId: z.string().trim().min(1).max(80) }),
]);
export type Intervention = z.infer<typeof InterventionSchema>;
export type InterventionKind = Intervention["kind"];

export const ScenarioSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    product: ProductSchema,
    storeHours: z.object({ openHour: z.number().int().min(0).max(23), closeHour: z.number().int().min(1).max(24) }).default({ openHour: 9, closeHour: 20 }),
    interventions: z.array(InterventionSchema).max(20).default([]),
  })
  .superRefine((s, ctx) => {
    if (s.storeHours.closeHour <= s.storeHours.openHour) ctx.addIssue({ code: "custom", path: ["storeHours"], message: "the store must close after it opens" });
    s.interventions.forEach((iv, i) => {
      if ((iv.kind === "ad_campaign" && iv.endDay < iv.startDay) || (iv.kind === "promotion" && iv.endDay < iv.day)) {
        ctx.addIssue({ code: "custom", path: ["interventions", i], message: "ends before it starts" });
      }
      if (iv.kind === "opening_hours" && iv.closeHour <= iv.openHour) ctx.addIssue({ code: "custom", path: ["interventions", i], message: "the store must close after it opens" });
    });
  });
export type Scenario = z.infer<typeof ScenarioSchema>;

/** One sentence per intervention, for logs, reports and proposals. */
export function describeIntervention(iv: Intervention, money: (c: number) => string = (c) => `$${(c / 100).toFixed(2)}`): string {
  switch (iv.kind) {
    case "product_drop":
      return `Product goes on sale on day ${iv.day + 1}`;
    case "price_change":
      return `Price changes to ${money(iv.priceCents)} on day ${iv.day + 1}`;
    case "ad_campaign":
      return `${iv.channel[0]!.toUpperCase()}${iv.channel.slice(1)} ads, ${money(iv.dailyBudgetCents)} a day, days ${iv.startDay + 1}–${iv.endDay + 1}: "${iv.creative}"`;
    case "opening_hours":
      return `Store hours ${iv.openHour}:00–${iv.closeHour}:00 from day ${iv.day + 1}`;
    case "promotion":
      return `${iv.event ? "Event" : "Promotion"} "${iv.label}": ${iv.discountPct}% off, days ${iv.day + 1}–${iv.endDay + 1}`;
    case "new_location":
      return `A new store opens at lot ${iv.lotId} on day ${iv.day + 1}`;
  }
}
