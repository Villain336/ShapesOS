// Marketr — /api/authority/listings local zod schemas (not a route: no HTTP exports).

import { z } from "zod";

export const connectChannelSchema = z.object({
  config: z.record(z.string(), z.unknown()).default({}),
});

export const gbpEditKindSchema = z.enum(["nap", "hours", "attributes", "categories", "photo", "post"]);

export const queueSyncSchema = z.object({
  kind: gbpEditKindSchema,
  payload: z.record(z.string(), z.unknown()),
  /** An approved listing_edit approval covering exactly this edit (binding re-verified at execution). */
  approvalId: z.string().min(1),
  locationRef: z.string().min(1).optional(),
});

export const createProfileSchema = z.object({
  channel: z.string().min(1),
  locationRef: z.string().min(1),
  nap: z.record(z.string(), z.unknown()).default({}),
  hours: z.record(z.string(), z.unknown()).default({}),
  attributes: z.record(z.string(), z.unknown()).default({}),
  photos: z.array(z.string()).default([]),
});

export const ldeEvaluateSchema = z.object({
  /** Optional accuracy checks to record; the stub records them, never executes live. */
  checks: z.array(z.object({
    directory: z.string().min(1),
    expected: z.string(),
    observed: z.string(),
    match: z.boolean(),
  })).default([]),
});

export const createBriefSchema = z.object({
  clientDirectories: z.array(z.string().min(1)).default([]),
  canonicalNap: z.object({
    name: z.string().default(""),
    address: z.string().default(""),
    phone: z.string().default(""),
    website: z.string().default(""),
  }),
});

export const verifySweepSchema = z.object({
  liveSnapshots: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});
