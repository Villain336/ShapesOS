// Marketr — /api/flywheel/launch local zod schemas (not a route: no HTTP exports).

import { z } from "zod";

export const completeItemSchema = z.object({
  evidence_url: z.string().trim().min(1, "evidence_url is required"),
  note: z.string().trim().max(2000).optional(),
});

export const reopenItemSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});
