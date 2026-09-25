// Marketr — /api/authority shared zod schemas (not a route: no HTTP exports).

import { z } from "zod";

export const workspacePagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const approvalTypeSchema = z.enum([
  "outreach_send",
  "depth3_activation",
  "pr_send",
  "listing_edit",
  "review_reply_post",
  "aeo_content_fix",
]);

export const createApprovalSchema = z.object({
  type: approvalTypeSchema,
  bindingJson: z.record(z.string(), z.unknown()),
  expiresAt: z.string().datetime().optional(),
});

export const depthSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const outreachCampaignSchema = z.object({
  name: z.string().min(1).max(120),
  depth: depthSchema.default(1),
  sendingDomainId: z.string().optional(),
  dailyCap: z.number().int().min(1).max(50).default(30),
});

export const prospectSchema = z.object({
  domain: z.string().min(1),
  url: z.string().url().or(z.string().min(1)),
  contactName: z.string().optional(),
  email: z.string().email().optional(),
  qualityScore: z.number().int().min(0).max(100).default(0),
  relevanceScore: z.number().int().min(0).max(100).default(0),
});

export const prOpportunitySchema = z.object({
  source: z.enum(["haro", "connectively", "qwoted", "sos", "hab2bw", "journo_request"]),
  journalist: z.string().min(1),
  outlet: z.string().min(1),
  queryText: z.string().min(1),
  deadline: z.string().datetime().optional(),
  expertiseTags: z.array(z.string()).default([]),
});

export const prDraftSchema = z.object({
  researchBrief: z.record(z.string(), z.unknown()).default({}),
  quoteSkeleton: z.string().default(""),
  checklist: z.record(z.string(), z.unknown()).default({}),
});

export const listingChannelSchema = z.object({
  channel: z.string().min(1),
  tier: z.enum(["api_synced", "aggregator", "manual", "guided_claim"]),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const listingProfileSchema = z.object({
  channel: z.string().min(1),
  locationRef: z.string().min(1),
  nap: z.record(z.string(), z.unknown()).default({}),
  hours: z.record(z.string(), z.unknown()).default({}),
  attributes: z.record(z.string(), z.unknown()).default({}),
  photos: z.array(z.string()).default([]),
});

export const reviewReplySchema = z.object({
  draftReply: z.string().min(1).max(4000),
});

export const aeoPromptSetSchema = z.object({
  prompts: z.array(z.string().min(1)).min(1).max(50),
});

// --- O1 outreach route schemas ---

export const sendingDomainSchema = z.object({
  domain: z.string().min(3).max(253),
  isPrimary: z.boolean().default(false),
  spfOk: z.boolean().default(false),
  dkimOk: z.boolean().default(false),
  dmarcPolicy: z.string().nullable().optional(),
  trackingCnameOk: z.boolean().default(false),
  warmupStartedAt: z.string().datetime().nullable().optional(),
});

export const updateDomainSchema = z.object({
  spfOk: z.boolean().optional(),
  dkimOk: z.boolean().optional(),
  dmarcPolicy: z.string().nullable().optional(),
  trackingCnameOk: z.boolean().optional(),
  warmupStartedAt: z.string().datetime().nullable().optional(),
  status: z.enum(["pending", "warming", "ready", "blocked"]).optional(),
});

export const discoverProspectsSchema = z.object({
  query: z.string().min(1).max(200),
  niche: z.string().min(1).max(120),
});

export const qualifyProspectSchema = z.object({
  threshold: z.number().int().min(0).max(100).default(60),
});

export const draftSequenceSchema = z.object({
  campaignId: z.string().min(1),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(20000),
  unsubscribeUrl: z.string().url(),
  physicalAddress: z.string().min(1).max(500),
  followups: z.array(z.object({
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(20000),
  })).max(2).optional(),
});

export const activateCampaignSchema = z.object({
  dryRun: z.boolean().default(false),
  sendingDomainId: z.string().optional(),
  approvalId: z.string().optional(),
});

export const approvalActionSchema = z.object({
  approver: z.string().min(1).max(200),
});

export const aeoEngineSchema = z.enum(["openai", "anthropic", "gemini", "perplexity"]);

export const aeoRunSchema = z.object({
  promptSetId: z.string().optional(),
  engines: z.array(aeoEngineSchema).min(1).max(4).optional(),
  reps: z.number().int().min(1).max(3).default(3),
  brand: z.string().min(1).max(120),
  ownedDomain: z.string().optional(),
});

export const aeoActionKindSchema = z.enum(["owned_fix", "third_party_plan"]);

export const aeoGenerateActionsSchema = z.object({
  generate: z.literal(true),
  ownedDomains: z.array(z.string().min(1)).default([]),
  pageUrls: z.array(z.string().url()).default([]),
  brand: z.string().min(1).max(120),
  minLift: z.number().min(0).max(1).default(0),
});

export const aeoCreateActionSchema = z.object({
  kind: aeoActionKindSchema,
  sourceRef: z.string().min(1).max(255),
  geo16Pillars: z.array(z.string()).default([]),
  fixProposal: z.record(z.string(), z.unknown()).optional(),
  actionPlan: z.record(z.string(), z.unknown()).optional(),
  expectedLift: z.number().optional(),
});

export const aeoActionStatusSchema = z.enum(["applied", "done", "dismissed"]);
