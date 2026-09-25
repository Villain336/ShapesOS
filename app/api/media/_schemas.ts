// Marketr — /api/media zod schemas for the Phase 5 SAFETY track.
// (Not a route: no HTTP exports.)

import { z } from "zod";

export const LineItemSchema = z.object({
  inventory: z.string().trim().min(1).max(200),
  pricingModel: z.string().trim().min(1).max(80),
  maxAllowedCents: z.number().int().positive(),
  flightStart: z.string().datetime({ offset: true }),
  flightEnd: z.string().datetime({ offset: true }),
  targetingSnapshot: z.record(z.string(), z.unknown()),
  creativeIds: z.array(z.string().trim().min(1)).min(1),
  creativeHashes: z.array(z.string().trim().length(64)),
});

export const BindingSchema = z.object({
  platform: z.string().trim().min(1).max(60),
  clientAdAccountId: z.string().trim().min(1).max(120),
  dealType: z.enum(["auction", "pd", "pg", "pa"]),
  lineItems: z.array(LineItemSchema).min(1),
  maxTotalSpendCents: z.number().int().positive(),
  currency: z.string().trim().length(3).default("USD"),
  quoteId: z.string().trim().min(1).max(120).optional(),
  quoteExpiresAt: z.string().datetime({ offset: true }).optional(),
  driftTolerance: z
    .object({ pricePct: z.number().min(0).max(100), spendPct: z.number().min(0).max(100) })
    .default({ pricePct: 10, spendPct: 5 }),
  creativeIds: z.array(z.string().trim().min(1)).min(1),
  creativeHashes: z.array(z.string().trim().length(64)),
  flightStart: z.string().datetime({ offset: true }),
  flightEnd: z.string().datetime({ offset: true }),
  targetingSnapshot: z.record(z.string(), z.unknown()),
  cancelTerms: z.string().trim().min(1).max(2000),
  operatorTermsVersion: z.string().trim().min(1).max(60),
});

export const CreateApprovalSchema = z.object({
  clientId: z.string().trim().min(1).max(64).optional(),
  type: z.enum(["buy", "io_brief", "pool_draw"]).default("buy"),
  binding: BindingSchema,
  poolId: z.string().trim().min(1).max(64).optional(),
});

export const ApproveSchema = z.object({
  method: z.enum(["sso", "otp", "signed_link"]).default("sso"),
  otpChallengeId: z.string().trim().min(1).optional(),
  otpCode: z.string().trim().min(4).max(12).optional(),
});

export const RevokeSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export const CreatePoolSchema = z.object({
  clientId: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(160),
  period: z.enum(["monthly", "campaign", "one_time"]),
  capCents: z.number().int().positive(),
  currency: z.string().trim().length(3).default("USD"),
  platformAllowlist: z.array(z.string().trim().min(1).max(60)).min(1).max(20),
  autoApproveThresholdCents: z.number().int().min(0).default(0),
});

export const VirtualCardSchema = z.object({
  provider: z.enum(["fake", "brex", "ramp"]).default("fake"),
  providerAccountRef: z.string().trim().min(1).max(200),
});

export const EmergencyStopSchema = z.object({
  clientId: z.string().trim().min(1).max(64),
  reason: z.string().trim().min(8).max(1000),
});

export const KillRuleSchema = z.object({
  clientId: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(120),
  scope: z
    .object({
      poolId: z.string().trim().min(1).optional(),
      platform: z.string().trim().min(1).optional(),
      buyId: z.string().trim().min(1).optional(),
      approvalId: z.string().trim().min(1).optional(),
    })
    .default({}),
  condition: z.object({
    metric: z.enum(["cpa", "spend", "daily_spend_pct", "conversions", "ctr", "ctr_decay", "failures"]),
    op: z.enum([">", "<", ">=", "<=", "=="]),
    value: z.number(),
    and: z
      .object({
        metric: z.enum(["cpa", "spend", "daily_spend_pct", "conversions", "ctr", "ctr_decay", "failures"]),
        op: z.enum([">", "<", ">=", "<=", "=="]),
        value: z.number(),
      })
      .optional(),
  }),
  window: z.string().trim().min(1).max(20).default("1h"),
  action: z.enum(["pause", "reduce_budget", "alert"]),
  cooldownMinutes: z.number().int().min(5).max(1440).default(60),
});
