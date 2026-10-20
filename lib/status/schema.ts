// ShapesOS — status page write bodies (zod), validated with lib/api/validate.

import { z } from "@/lib/api/validate";
import { COMPONENT_STATES, DEFAULT_COMPONENTS } from "./derive";

export const COMPONENT_KEYS = DEFAULT_COMPONENTS.map((c) => c.key) as ["web", "database", "worker", "queue"];
export const INCIDENT_STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const;
export const INCIDENT_IMPACTS = ["none", "minor", "major", "critical"] as const;
/** Manual states an operator may set (unknown is derived-only). */
export const MANUAL_STATES = COMPONENT_STATES.filter((s) => s !== "unknown") as ["operational", "degraded", "partial_outage", "major_outage", "maintenance"];

export const componentOverrideBody = z.object({
  /** null clears the override (back to the derived state). */
  state: z.enum(MANUAL_STATES).nullable(),
  note: z.string().trim().max(300).optional().nullable(),
});

export const incidentCreateBody = z.object({
  title: z.string().trim().min(3).max(140),
  status: z.enum(INCIDENT_STATUSES),
  impact: z.enum(INCIDENT_IMPACTS),
  componentKeys: z.array(z.enum(COMPONENT_KEYS)).max(COMPONENT_KEYS.length).default([]),
  message: z.string().trim().min(1).max(2000),
});

export const incidentUpdateBody = z.object({
  status: z.enum(INCIDENT_STATUSES),
  impact: z.enum(INCIDENT_IMPACTS).optional(),
  message: z.string().trim().min(1).max(2000),
});

export type ComponentOverrideBody = z.infer<typeof componentOverrideBody>;
export type IncidentCreateBody = z.infer<typeof incidentCreateBody>;
export type IncidentUpdateBody = z.infer<typeof incidentUpdateBody>;
