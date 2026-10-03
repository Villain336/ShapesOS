// ShapesOS — outbound webhook event catalog (Phase 4a).
//
// The zod schemas here are the single source for (a) what producers may put
// in an event (emitWebhookEvent is typed from them) and (b) the OpenAPI 3.1
// `webhooks` section (lib/api/openapi.ts converts them with z.toJSONSchema).
// Client-safe: no database or Node imports.

import { z } from "zod";

/** Bumped only on a breaking payload change; sent as `apiVersion`. */
export const WEBHOOK_API_VERSION = "2026-10-05";

const isoDate = z.string().describe("ISO 8601 timestamp");

export const LeadEventData = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  company: z.string().nullable(),
  title: z.string().nullable(),
  stage: z.string(),
  score: z.number().int(),
  valueCents: z.number().int().nullable(),
  source: z.string(),
  pipelineId: z.string(),
  projectId: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
  /** lead.updated only: the fields the change touched. */
  changed: z.array(z.string()).optional(),
});

export const InvoicePaidData = z.object({
  id: z.string(),
  customerId: z.string().nullable(),
  totalCents: z.number().int(),
  taxCents: z.number().int(),
  status: z.literal("paid"),
  sentAt: isoDate.nullable(),
  dueAt: isoDate.nullable(),
  paidAt: isoDate,
});

export const ApprovalNeededData = z.object({
  source: z.string().describe("Approval queue, e.g. mission, outreach, spend"),
  sourceId: z.string(),
  title: z.string(),
  href: z.string().nullable().describe("Dashboard path to review it"),
  requestedBy: z.string().nullable(),
});

export const ApprovalDecidedData = z.object({
  source: z.string(),
  sourceId: z.string(),
  title: z.string(),
  decision: z.enum(["approved", "denied"]),
  decidedBy: z.string().nullable(),
});

export const AgentRunData = z.object({
  id: z.string(),
  kind: z.string().nullable(),
  status: z.string(),
  startedBy: z.string().nullable(),
  endedAt: isoDate.nullable(),
});

export const NotificationCreatedData = z.object({
  kind: z.string(),
  userId: z.string().describe("Recipient (Auth.js user id)"),
  title: z.string(),
  body: z.string().nullable(),
  href: z.string().nullable(),
  sourceType: z.string().nullable(),
  sourceId: z.string().nullable(),
});

export const PingData = z.object({
  message: z.string(),
});

// ── Phase 4b: CAD derived BOM + Dataset Builder ──────────────────────────
export const CadBomDerivedData = z.object({
  bomId: z.string(),
  bomNumber: z.number().int(),
  modelId: z.string(),
  modelVersionId: z.string(),
  versionNumber: z.number().int(),
  lineCount: z.number().int(),
  bodyCount: z.number().int(),
  material: z.string().nullable(),
  totalMassG: z.number().nullable().describe("Known masses only (mesh units assumed mm)"),
  totalUsd: z.number().describe("Known line costs only; a lower bound when linesMissingCost > 0"),
  linesMissingCost: z.number().int(),
});

export const DatasetCompiledData = z.object({
  datasetId: z.string(),
  type: z.string(),
  version: z.number().int(),
  chunkCount: z.number().int(),
  compiledAt: isoDate,
});

export const DatasetPublishedData = z.object({
  datasetId: z.string(),
  type: z.string(),
  target: z.string().describe("briefnow | rag"),
  version: z.number().int(),
  latestVersion: z.number().int(),
  rollback: z.boolean().describe("True when an older compiled version was made live"),
  chunkCount: z.number().int(),
  artifactRef: z.string(),
  publishedAt: isoDate,
});

export const DatasetStaleData = z.object({
  datasetId: z.string(),
  type: z.string(),
  version: z.number().int(),
  ageDays: z.number().int(),
  thresholdDays: z.number().int(),
  message: z.string(),
});

export const WEBHOOK_EVENT_SCHEMAS = {
  "lead.created": LeadEventData,
  "lead.updated": LeadEventData,
  "invoice.paid": InvoicePaidData,
  "approval.needed": ApprovalNeededData,
  "approval.decided": ApprovalDecidedData,
  "agent_run.finished": AgentRunData,
  "agent_run.failed": AgentRunData,
  "notification.created": NotificationCreatedData,
  "webhook.ping": PingData,
  // Phase 4b
  "cad.bom_derived": CadBomDerivedData,
  "dataset.compiled": DatasetCompiledData,
  "dataset.published": DatasetPublishedData,
  "dataset.stale": DatasetStaleData,
} as const;

export type WebhookEventType = keyof typeof WEBHOOK_EVENT_SCHEMAS;
export type WebhookEventData<T extends WebhookEventType> = z.input<(typeof WEBHOOK_EVENT_SCHEMAS)[T]>;

export const WEBHOOK_EVENT_TYPES = Object.keys(WEBHOOK_EVENT_SCHEMAS) as WebhookEventType[];

/** Types an endpoint can subscribe to (the ping is always sent on request). */
export const SUBSCRIBABLE_EVENT_TYPES = WEBHOOK_EVENT_TYPES.filter((t) => t !== "webhook.ping");

export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  "lead.created": "A lead is created",
  "lead.updated": "A lead is updated",
  "invoice.paid": "An invoice is marked paid",
  "approval.needed": "Something needs approval",
  "approval.decided": "An approval is decided",
  "agent_run.finished": "An agent run finishes",
  "agent_run.failed": "An agent run fails",
  "notification.created": "A notification is created",
  "webhook.ping": "Test event",
  // Phase 4b
  "cad.bom_derived": "A CAD BOM is derived from geometry",
  "dataset.compiled": "A dataset version is compiled",
  "dataset.published": "A dataset version goes live",
  "dataset.stale": "A dataset goes stale",
};

export function isWebhookEventType(v: unknown): v is WebhookEventType {
  return typeof v === "string" && (WEBHOOK_EVENT_TYPES as string[]).includes(v);
}

/** The JSON body POSTed to an endpoint (and signed). */
export const WebhookEnvelope = z.object({
  id: z.string().describe("Event id (evt_…); the same across endpoints, use it to dedupe"),
  type: z.string(),
  apiVersion: z.string(),
  createdAt: isoDate,
  workspaceId: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type WebhookEnvelope = z.infer<typeof WebhookEnvelope>;

/** Does an endpoint's filter (empty = all) include this event type? */
export function endpointWants(events: readonly string[] | null | undefined, type: string): boolean {
  if (type === "webhook.ping") return true;
  return !events || events.length === 0 || events.includes(type);
}
