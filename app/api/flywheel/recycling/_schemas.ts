// Marketr — /api/flywheel/recycling request schemas.

import { z } from "zod";
import { CHANNELS } from "@/lib/flywheel/recycling/types";

const ChannelSchema = z.string().refine(
  (v): v is (typeof CHANNELS)[number] => (CHANNELS as string[]).includes(v),
  { message: "unknown channel" },
);

export const SignalSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  kind: z.enum(["attribution_revenue", "qr_scan_rate", "aeo_lift", "mail_response"]),
  sourceAssetId: z.string().min(1),
  sourceChannel: ChannelSchema,
  metricValue: z.number(),
  metricUnit: z.string(),
  observedAt: z.string(),
  source: z.enum(["real", "fake"]),
  detail: z.record(z.string(), z.unknown()),
});

export const CreateBriefSchema = z.object({
  /** A signal object as returned by GET /signals (validated, workspace-scoped). */
  signal: SignalSchema,
  targetChannels: z.array(ChannelSchema).min(1).max(8),
});

export const ApproveBriefSchema = z.object({
  note: z.string().max(2000).optional(),
});

export const SignalsQuerySchema = z.object({
  fake: z.coerce.boolean().optional(),
  since: z.string().datetime({ offset: true }).optional(),
});
