// Marketr — CRM public capture-form submission core.
//
// The route (app/api/crm/public/forms/[token]/route.ts) is PUBLIC BY DESIGN:
// the unguessable token (mkfrm_<32 hex>, stored as sha256) IS the capability.
// This module holds everything the route needs so the adversarial battery
// (scripts/verify-crm.mts) can exercise token isolation, rate limiting,
// honeypot, validation, and dedup without an HTTP server.

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { InMemoryRateLimiter } from "@/lib/mcp/rateLimit";
import { dedupKeyFor, hashFormToken, recomputeScore, logActivity } from "@/lib/crm/dedup";
import { recordCaptureTouch } from "@/lib/attribution/touches";
import { applyPromoCodeToLead } from "@/lib/physical/bundles";
import { UtmSchema } from "@/lib/crm/leads";
import { parseStages } from "@/lib/crm/stages";
import { emitLeadCreated } from "@/lib/webhooks/emit";

export const PUBLIC_FORM_LIMIT = 10; // submissions per window
export const PUBLIC_FORM_WINDOW_MS = 60_000;
export const PUBLIC_BODY_LIMIT = 2048; // bytes
export const HONEYPOT_FIELD = "website";

const limiter = new InMemoryRateLimiter();

/** Test seam: reset the public-form rate limiter between battery runs. */
export function resetPublicFormLimiter(): void {
  limiter.reset();
}

export const PublicSubmitSchema = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().max(254).optional(),
  phone: z.string().trim().max(40).optional(),
  company: z.string().trim().max(160).optional(),
  title: z.string().trim().max(160).optional(),
  message: z.string().trim().max(2000).optional(),
  // Honeypot: legitimate embeds leave this empty.
  website: z.string().max(200).optional(),
  // C2: optional UTM capture + linked content page for attribution touches.
  utm: UtmSchema.optional(),
  contentId: z.string().trim().max(64).optional(),
  // P2: optional promo code (WAVE-XXXXXX) — logs a promo_code attribution
  // touch when the code belongs to an active bundle in this workspace.
  promoCode: z.string().trim().max(32).optional(),
});

export async function findFormByToken(token: string) {
  if (!token.startsWith("mkfrm_") || token.length > 80) return null;
  return prisma.leadCaptureForm.findUnique({
    where: { tokenHash: hashFormToken(token) },
    include: { pipeline: true },
  });
}

export interface PublicSubmitResult {
  status: number;
  json: Record<string, unknown>;
  headers?: Record<string, string>;
}

/**
 * Handle one public form submission. `rawBody` is the raw request text (the
 * route enforces the body cap on bytes before calling; the lib re-checks on
 * characters). Returns the status + JSON payload the route should send.
 */
export async function handlePublicSubmit(opts: {
  token: string;
  rawBody: string;
  ip: string;
}): Promise<PublicSubmitResult> {
  const { token, rawBody, ip } = opts;
  const form = await findFormByToken(token);
  if (!form || !form.enabled) {
    return { status: 404, json: { error: "Not found" } };
  }

  const rl = await limiter.check(`crmform:${form.id}:${ip}`, PUBLIC_FORM_LIMIT, PUBLIC_FORM_WINDOW_MS);
  if (!rl.allowed) {
    return {
      status: 429,
      json: { error: "Too many submissions, please try again shortly" },
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
    };
  }

  if (rawBody.length > PUBLIC_BODY_LIMIT) {
    return { status: 400, json: { error: "Body too large" } };
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, json: { error: "Invalid JSON" } };
  }
  const parsed = PublicSubmitSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, json: { error: "Invalid input", issues: parsed.error.issues } };
  }
  const d = parsed.data;

  // Honeypot: silently accept but drop (don't train the bot).
  if (d.website && d.website.trim() !== "") {
    return { status: 201, json: { ok: true } };
  }
  if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) {
    return { status: 400, json: { error: "Invalid email" } };
  }

  const stages = parseStages(form.pipeline.stages);
  const dedupKey = dedupKeyFor(d.email, d.phone);

  try {
    if (dedupKey) {
      const existing = await prisma.lead.findFirst({
        where: { workspaceId: form.workspaceId, dedupKey },
        select: { id: true },
      });
      // Public dedup: never reveal the existing lead — just acknowledge.
      if (existing) return { status: 201, json: { ok: true, duplicate: true } };
    }
    const lead = await prisma.lead.create({
      data: {
        workspaceId: form.workspaceId,
        pipelineId: form.pipelineId,
        name: d.name,
        email: d.email?.trim() || null,
        phone: d.phone?.trim() || null,
        company: d.company?.trim() || null,
        title: d.title?.trim() || null,
        source: "website_form",
        sourceDetail: `form:${form.name}`,
        stage: stages[0].id,
        customFields: d.message ? { message: d.message } : undefined,
        dedupKey,
      },
    });
    await logActivity({
      workspaceId: form.workspaceId,
      leadId: lead.id,
      type: "form_submit",
      body: d.message ? `Form submission: ${d.message.slice(0, 500)}` : "Form submission",
      actor: "Public form",
    });
    // C2: the creation touch (campaign falls back to the form name).
    await recordCaptureTouch({
      workspaceId: form.workspaceId,
      leadId: lead.id,
      leadSource: "website_form",
      utm: d.utm ?? null,
      contentId: d.contentId ?? null,
      campaignFallback: `form:${form.name}`,
    });
    // P2: promo code redemption — attaches the bundle's promo_code touch and
    // redemption row. A bad code never fails the submission.
    if (d.promoCode) {
      await applyPromoCodeToLead(form.workspaceId, lead.id, d.promoCode);
    }
    await recomputeScore(lead.id, form.workspaceId);
    // Phase 4a: lead.created webhook (best-effort, never throws).
    await emitLeadCreated(lead);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { status: 201, json: { ok: true, duplicate: true } };
    }
    throw e;
  }
  return { status: 201, json: { ok: true } };
}

export function getPublicFormConfig(form: {
  name: string;
  fields: unknown;
  pipeline: { name: string };
}) {
  return {
    name: form.name,
    pipelineName: form.pipeline.name,
    fields: form.fields ?? [
      { key: "name", label: "Name", required: true },
      { key: "email", label: "Email", required: true },
      { key: "phone", label: "Phone", required: false },
      { key: "company", label: "Company", required: false },
      { key: "message", label: "Message", required: false },
    ],
  };
}
