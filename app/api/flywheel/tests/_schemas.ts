// Marketr — F3 test-lab route schemas.

import { z } from "zod";

export const variantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  weight: z.number().min(0).max(1),
  description: z.string().optional(),
});

export const guardrailMetricSchema = z.object({
  name: z.string().min(1),
  tolerance: z.number().min(0).max(1),
});

export const createExperimentSchema = z.object({
  name: z.string().min(3).max(120),
  hypothesis: z.string().min(10),
  pieIceScore: z.number().min(0).max(10),
  channel: z.enum(["web", "email", "ads", "mail"]),
  variants: z.array(variantSchema).min(2),
  audience: z.string().min(1),
  primaryMetric: z.string().min(1),
  metricType: z.enum(["binomial", "gaussian"]).default("binomial"),
  guardrailMetrics: z.array(guardrailMetricSchema).default([]),
  profitGuardrail: z.object({
    marginPerConversion: z.number().min(0),
    discountCostPerConversion: z.number().min(0),
  }).optional(),
  minRuntimeDays: z.number().int().min(7).default(7),
  statedMde: z.number().min(0.001).max(1),
  baselineRate: z.number().min(0).max(1),
  monthlyTraffic: z.number().min(0),
});

export const createIdeaSchema = z.object({
  title: z.string().min(3).max(160),
  sourceSignal: z.string().optional(),
  pieIceScore: z.number().min(0).max(10),
  status: z.string().default("queued"),
});

export const binomialArmSchema = z.object({
  successes: z.number().int().min(0),
  trials: z.number().int().min(0),
});

export const gaussianArmSchema = z.object({
  mean: z.number(),
  variance: z.number().min(0),
  n: z.number().int().min(0),
});

/** Arm data + integrity inputs supplied to the results read (fake mode / fixtures). */
export const resultsReadSchema = z.object({
  armA: z.union([binomialArmSchema, gaussianArmSchema]),
  armB: z.union([binomialArmSchema, gaussianArmSchema]),
  armCounts: z.array(z.number().int().min(0)),
  armWeights: z.array(z.number().min(0)),
  coverage: z.object({
    randomizedUnits: z.number().int().min(0),
    unitsInAnalysis: z.number().int().min(0),
  }).default({ randomizedUnits: 0, unitsInAnalysis: 0 }),
  prePeriodMeans: z.array(z.number()).default([]),
  prePeriodNs: z.array(z.number().int().min(0)).default([]),
  exposureLeakageRate: z.number().min(0).max(1).default(0),
  concurrentTests: z.array(z.object({
    testId: z.string(),
    overlap: z.number().min(0).max(1),
    directionRisk: z.enum(["low", "high"]),
  })).default([]),
  volatility: z.object({
    observedDailySd: z.number().min(0),
    historicalDailySd: z.number().min(0),
  }).default({ observedDailySd: 0, historicalDailySd: 0 }),
  guardrailReads: z.array(z.object({
    name: z.string(),
    relativeChange: z.number(),
  })).default([]),
  daysRunning: z.number().int().min(0).default(0),
  fullCycleCovered: z.boolean().default(false),
  expectedLossThreshold: z.number().min(0).max(0.5).default(0.01),
  minUnits: z.number().int().min(0).default(500),
  profitCheck: z.object({
    profitUplift: z.number(),
    profitLoss: z.number().min(0),
  }).optional(),
});
