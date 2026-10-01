// Marketr — E-sign module: governed envelope actions (SPEC-GAP-ESIGN.md §4.3).
//
// The gates, in one place:
// - create_envelope: workspace member+; validates everything up front.
// - send_envelope: HEAVY gate. Requires a fresh confirmation token computed
//   over the exact draft bytes the human reviewed. A changed draft invalidates
//   the token, so no agent path can send a stale or altered document.
// - void_envelope: requires a reason; sealed artifacts are never deleted.
// - complete_envelope: webhook-driven ONLY. Nothing here marks an envelope
//   complete on anything but the vendor's DOCUMENT_COMPLETED event.

import { timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { DocumensoApiError } from "@/lib/integrations/documenso";
import {
  mapDocumensoWebhookEvent,
  type EnvelopeStatus,
  type EsignVendor,
  type FieldType,
  type SignerRole,
  type SigningOrder,
  type VendorFieldInput,
  type VendorSignerInput,
} from "./vendor";
import {
  parseDocumensoWebhook,
  verifyDocumensoWebhookSignature,
} from "./documenso-vendor";
import { appendAuditEvent, sha256Hex, type AuditDb } from "./audit";
import { firePipelineLinks } from "./pipeline";

export type EsignDb = Pick<
  PrismaClient,
  "esignEnvelope" | "esignSigner" | "esignField" | "esignAuditEvent"
> & { esignAuditEvent: AuditDb["esignAuditEvent"] };

export class EsignGateError extends Error {
  constructor(
    public code:
      | "not_draft"
      | "stale_token"
      | "missing_token"
      | "no_signers"
      | "invalid_input"
      | "not_voidable"
      | "missing_reason"
      | "unknown_envelope"
      | "bad_signature"
      | "vendor_not_configured"
      | "bad_json"
      | "not_completed"
      | "no_sealed_pdf"
      | "broken_chain"
      | "unknown_vault_entry"
      | "no_contract_link"
      // Template codes (named mismatch reasons — never silent).
      | "unknown_template"
      | "missing_name"
      | "empty_document"
      | "no_roles"
      | "blank_role"
      | "duplicate_role"
      | "field_role_mismatch"
      | "bad_field_type"
      | "blank_merge_name"
      | "bad_merge_def"
      | "missing_merge_value"
      | "unmapped_merge_value"
      | "unknown_signer_role"
      | "unbound_signer_role",
    message: string,
  ) {
    super(message);
    this.name = "EsignGateError";
  }
}

export interface DraftSignerInput {
  name: string;
  email: string;
  role?: SignerRole;
  orderIndex?: number;
}

export interface DraftFieldInput {
  signerEmail?: string;
  fieldType: FieldType;
  page?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  required?: boolean;
}

export interface CreateDraftInput {
  workspaceId: string;
  title: string;
  signers: DraftSignerInput[];
  fields?: DraftFieldInput[];
  signingOrder?: SigningOrder;
  expiresAt?: Date | null;
  templateId?: string | null;
  documentName?: string;
  pdfBytes: Uint8Array;
  createdBy?: string;
  contractType?: string;
  contractRef?: string;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const VALID_ROLES: SignerRole[] = ["signer", "approver", "cc"];
const VALID_FIELD_TYPES: FieldType[] = ["signature", "initials", "date", "text", "checkbox"];

/** Pure validation for draft creation. Throws EsignGateError on any problem. */
export function validateDraftInput(input: CreateDraftInput): void {
  if (!input.title.trim()) {
    throw new EsignGateError("invalid_input", "Title is required.");
  }
  if (input.signers.length === 0) {
    throw new EsignGateError("no_signers", "At least one signer is required.");
  }
  if (input.signers.length > 20) {
    throw new EsignGateError("invalid_input", "At most 20 signers per envelope.");
  }
  const seen = new Set<string>();
  for (const s of input.signers) {
    if (!s.name.trim()) throw new EsignGateError("invalid_input", "Every signer needs a name.");
    if (!EMAIL_RE.test(s.email)) {
      throw new EsignGateError("invalid_input", `Invalid signer email: ${s.email}`);
    }
    const lower = s.email.toLowerCase();
    if (seen.has(lower)) throw new EsignGateError("invalid_input", `Duplicate signer: ${s.email}`);
    seen.add(lower);
    if (s.role && !VALID_ROLES.includes(s.role)) {
      throw new EsignGateError("invalid_input", `Invalid signer role: ${s.role}`);
    }
  }
  const emails = new Set(input.signers.map((s) => s.email.toLowerCase()));
  for (const f of input.fields ?? []) {
    if (!VALID_FIELD_TYPES.includes(f.fieldType)) {
      throw new EsignGateError("invalid_input", `Invalid field type: ${f.fieldType}`);
    }
    if ((f.page ?? 1) < 1) throw new EsignGateError("invalid_input", "Field page must be >= 1.");
    if (f.signerEmail && !emails.has(f.signerEmail.toLowerCase())) {
      throw new EsignGateError(
        "invalid_input",
        `Field assigned to unknown signer: ${f.signerEmail}`,
      );
    }
  }
  if (input.pdfBytes.byteLength === 0 || input.pdfBytes.byteLength > MAX_PDF_BYTES) {
    throw new EsignGateError("invalid_input", "PDF must be non-empty and under 10MB.");
  }
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw new EsignGateError("invalid_input", "Expiration must be in the future.");
  }
}

export interface SendTokenBasis {
  id: string;
  title: string;
  signerEmails: string[];
  signingOrder: string;
  expiresAt: Date | null;
  sourcePdfHash: string | null;
}

/**
 * The send confirmation token. Binds the human's approval to the exact draft
 * they reviewed: id, title, signer set, order, expiration, and the PDF hash.
 * Any change invalidates it.
 */
export function buildSendToken(b: SendTokenBasis): string {
  const emails = [...b.signerEmails].map((e) => e.toLowerCase()).sort().join(",");
  return sha256Hex(
    [b.id, b.title, emails, b.signingOrder, b.expiresAt?.toISOString() ?? "", b.sourcePdfHash ?? ""].join("|"),
  );
}

function tokenBasisOf(envelope: {
  id: string;
  title: string;
  signingOrder: string;
  expiresAt: Date | null;
  sourcePdfHash: string | null;
  signers: Array<{ email: string }>;
}): SendTokenBasis {
  return {
    id: envelope.id,
    title: envelope.title,
    signerEmails: envelope.signers.map((s) => s.email),
    signingOrder: envelope.signingOrder,
    expiresAt: envelope.expiresAt,
    sourcePdfHash: envelope.sourcePdfHash,
  };
}

function timingSafeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function auditBodyHash(parts: Array<string | null | undefined>): string {
  return sha256Hex(parts.map((p) => p ?? "").join("|"));
}

// ---------------------------------------------------------------------------
// create_envelope — light gate (workspace member+ enforced at the route).
// ---------------------------------------------------------------------------

export async function createEnvelopeDraft(db: EsignDb, input: CreateDraftInput) {
  validateDraftInput(input);
  const sourcePdfHash = sha256Hex(input.pdfBytes);
  const envelope = await db.esignEnvelope.create({
    data: {
      workspaceId: input.workspaceId,
      title: input.title.trim(),
      status: "draft",
      signingOrder: input.signingOrder ?? "sequential",
      documentName: input.documentName ?? null,
      documentSize: input.pdfBytes.byteLength,
      sourcePdf: Buffer.from(input.pdfBytes),
      sourcePdfHash,
      expiresAt: input.expiresAt ?? null,
      templateId: input.templateId ?? null,
      contractType: input.contractType ?? null,
      contractRef: input.contractRef ?? null,
      createdBy: input.createdBy ?? null,
      signers: {
        create: input.signers.map((s, i) => ({
          name: s.name.trim(),
          email: s.email.trim(),
          role: s.role ?? "signer",
          orderIndex: s.orderIndex ?? i,
          status: "pending",
        })),
      },
      fields: {
        create: (input.fields ?? []).map((f) => ({
          fieldType: f.fieldType,
          page: f.page ?? 1,
          x: f.x ?? 0,
          y: f.y ?? 0,
          width: f.width ?? 150,
          height: f.height ?? 40,
          required: f.required ?? true,
          signerId: undefined,
        })),
      },
    },
    include: { signers: true, fields: true },
  });

  // Bind fields to signer rows by email now that the rows exist.
  const byEmail = new Map(envelope.signers.map((s) => [s.email.toLowerCase(), s.id]));
  for (let i = 0; i < (input.fields ?? []).length; i++) {
    const email = input.fields![i]!.signerEmail?.toLowerCase();
    const signerId = email ? byEmail.get(email) : undefined;
    if (signerId) {
      await db.esignField.update({
        where: { id: envelope.fields[i]!.id },
        data: { signerId },
      });
    }
  }

  await appendAuditEvent(db, {
    envelopeId: envelope.id,
    event: "created",
    actor: input.createdBy ? `user:${input.createdBy}` : "system",
    payload: {
      title: envelope.title,
      signerCount: envelope.signers.length,
      fieldCount: envelope.fields.length,
      sourcePdfHash,
    },
    bodyHash: auditBodyHash(["created", envelope.id, sourcePdfHash]),
  });

  return envelope;
}

// ---------------------------------------------------------------------------
// send_envelope — HEAVY gate. Explicit per-send human approval only.
// ---------------------------------------------------------------------------

export async function sendEnvelope(
  db: EsignDb,
  vendor: EsignVendor,
  input: { envelopeId: string; token: string; actor: string; workspaceId?: string },
) {
  if (!input.token) {
    throw new EsignGateError("missing_token", "Send requires a fresh confirmation token.");
  }
  const envelope = await db.esignEnvelope.findFirst({
    where: { id: input.envelopeId, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) },
    include: { signers: { orderBy: { orderIndex: "asc" } }, fields: true },
  });
  if (!envelope) throw new EsignGateError("unknown_envelope", "Envelope not found.");
  if (envelope.status !== "draft") {
    throw new EsignGateError("not_draft", `Only drafts can be sent (status: ${envelope.status}).`);
  }
  const expected = buildSendToken(tokenBasisOf(envelope));
  if (!timingSafeCompare(input.token, expected)) {
    throw new EsignGateError(
      "stale_token",
      "The draft changed since it was reviewed. Re-open the send preview and confirm again.",
    );
  }
  if (!envelope.sourcePdf) {
    throw new EsignGateError("invalid_input", "The draft has no document bytes to send.");
  }

  try {
    const created = await vendor.createEnvelope({
      title: envelope.title,
      pdfBytes: new Uint8Array(envelope.sourcePdf),
      filename: envelope.documentName ?? "document.pdf",
    });
    const vendorSigners: VendorSignerInput[] = envelope.signers.map((s) => ({
      name: s.name,
      email: s.email,
      role: s.role as VendorSignerInput["role"],
      orderIndex: s.orderIndex,
    }));
    await vendor.addSigners(created.vendorRef, vendorSigners);
    if (envelope.fields.length > 0) {
      const signerById = new Map(envelope.signers.map((s) => [s.id, s.email]));
      const vendorFields: VendorFieldInput[] = envelope.fields.map((f) => ({
        signerEmail: f.signerId ? signerById.get(f.signerId) : undefined,
        fieldType: f.fieldType as VendorFieldInput["fieldType"],
        page: f.page,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        required: f.required,
      }));
      await vendor.addFields(created.vendorRef, vendorFields);
    }
    await vendor.sendEnvelope(created.vendorRef);

    const updated = await db.esignEnvelope.update({
      where: { id: envelope.id },
      data: {
        vendorRef: created.vendorRef,
        vendorStatus: created.vendorStatus,
        status: "sent",
      },
    });
    await appendAuditEvent(db, {
      envelopeId: envelope.id,
      event: "sent",
      actor: input.actor,
      payload: {
        vendorRef: created.vendorRef,
        signerCount: envelope.signers.length,
        token: expected.slice(0, 16),
      },
      bodyHash: auditBodyHash(["sent", envelope.id, created.vendorRef, expected]),
    });
    return updated;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Vendor send failed.";
    await appendAuditEvent(db, {
      envelopeId: envelope.id,
      event: "send_failed",
      actor: input.actor,
      payload: { error: message },
      bodyHash: auditBodyHash(["send_failed", envelope.id, String(Date.now())]),
    });
    await db.esignEnvelope.update({
      where: { id: envelope.id },
      data: { status: "error" },
    });
    if (e instanceof DocumensoApiError && e.status === 0) {
      throw new EsignGateError("vendor_not_configured", message);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// void_envelope — voids with reason; the sealed artifact is never deleted.
// ---------------------------------------------------------------------------

export async function voidEnvelope(
  db: EsignDb,
  vendor: EsignVendor,
  input: { envelopeId: string; reason: string; actor: string; workspaceId?: string },
) {
  if (!input.reason.trim()) {
    throw new EsignGateError("missing_reason", "A void reason is required.");
  }
  const envelope = await db.esignEnvelope.findFirst({
    where: { id: input.envelopeId, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}) },
  });
  if (!envelope) throw new EsignGateError("unknown_envelope", "Envelope not found.");
  if (!["draft", "sent", "partially-signed", "expired"].includes(envelope.status)) {
    throw new EsignGateError(
      "not_voidable",
      `Envelope in status ${envelope.status} cannot be voided.`,
    );
  }
  if (envelope.vendorRef) {
    await vendor.voidEnvelope(envelope.vendorRef, input.reason.trim());
  }
  const updated = await db.esignEnvelope.update({
    where: { id: envelope.id },
    data: { status: "voided", voidReason: input.reason.trim() },
  });
  await appendAuditEvent(db, {
    envelopeId: envelope.id,
    event: "voided",
    actor: input.actor,
    payload: { reason: input.reason.trim(), hadVendorRef: !!envelope.vendorRef },
    bodyHash: auditBodyHash(["voided", envelope.id, input.reason.trim()]),
  });
  return updated;
}

// ---------------------------------------------------------------------------
// refresh — re-read vendor status; recover a missing sealed PDF.
// ---------------------------------------------------------------------------

export async function refreshEnvelope(
  db: EsignDb,
  vendor: EsignVendor,
  envelopeId: string,
  workspaceId?: string,
) {
  const envelope = await db.esignEnvelope.findFirst({
    where: { id: envelopeId, ...(workspaceId ? { workspaceId } : {}) },
    include: { signers: true },
  });
  if (!envelope) throw new EsignGateError("unknown_envelope", "Envelope not found.");
  if (!envelope.vendorRef) return envelope;

  const { vendorStatus, envelopeStatus } = await vendor.getStatus(envelope.vendorRef);
  const signedCount = envelope.signers.filter((s) => s.status === "signed").length;
  const next: EnvelopeStatus =
    envelopeStatus === "sent" && signedCount > 0 && signedCount < envelope.signers.length
      ? "partially-signed"
      : envelopeStatus;

  let sealed: { bytes: Uint8Array; hash: string } | null = null;
  if (next === "completed" && !envelope.sealedPdf) {
    try {
      sealed = await vendor.getSealedPdf(envelope.vendorRef);
    } catch {
      sealed = null; // Recovery retried on the next refresh; never blocks the status.
    }
  }

  const updated = await db.esignEnvelope.update({
    where: { id: envelope.id },
    data: {
      vendorStatus,
      status: next,
      ...(sealed
        ? {
            sealedPdf: Buffer.from(sealed.bytes),
            sealedPdfHash: sealed.hash,
            sealedPdfFetchedAt: new Date(),
          }
        : {}),
    },
  });
  if (next !== envelope.status) {
    await appendAuditEvent(db, {
      envelopeId: envelope.id,
      event: `status:${next}`,
      actor: "system",
      payload: { vendorStatus, sealedPdfFetched: !!sealed },
      bodyHash: auditBodyHash(["status", envelope.id, next, vendorStatus]),
    });
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Webhook ingestion — the ONLY path that completes an envelope.
// ---------------------------------------------------------------------------

export type WebhookIngestResult =
  | { ok: true; applied: string }
  | { ok: true; deduped: true }
  | { ok: true; ignored: string }
  | { ok: false; reason: string };

export async function ingestDocumensoWebhook(
  db: EsignDb,
  vendor: EsignVendor,
  input: { rawBody: string; secretHeader: string | null; env?: Record<string, string | undefined> },
): Promise<WebhookIngestResult> {
  // Authorization IS the webhook signature: verified before any parsing.
  if (!verifyDocumensoWebhookSignature(input.secretHeader, input.env ?? process.env)) {
    return { ok: false, reason: "bad_signature" };
  }
  let parsed;
  try {
    parsed = parseDocumensoWebhook(input.rawBody);
  } catch {
    return { ok: false, reason: "bad_payload" };
  }

  const envelope = await db.esignEnvelope.findFirst({
    where: { vendorRef: parsed.documentId },
    include: { signers: true },
  });
  if (!envelope) return { ok: true, ignored: "unknown_envelope" };

  const transition = mapDocumensoWebhookEvent(parsed.event);
  if (!transition) return { ok: true, ignored: "event_ignored" };

  const bodyHash = sha256Hex(input.rawBody);

  // Signer-level updates from the payload's Recipient array (defensive).
  const raw = parsed.raw as { payload?: { Recipient?: unknown } };
  const recipients = Array.isArray(raw.payload?.Recipient) ? raw.payload!.Recipient as Array<{
    email?: unknown;
    signingStatus?: unknown;
    signedAt?: unknown;
  }> : [];
  for (const r of recipients) {
    if (typeof r.email !== "string") continue;
    const signer = envelope.signers.find(
      (s) => s.email.toLowerCase() === (r.email as string).toLowerCase(),
    );
    if (!signer) continue;
    if (r.signingStatus === "SIGNED" && signer.status !== "signed") {
      await db.esignSigner.update({
        where: { id: signer.id },
        data: {
          status: "signed",
          signedAt: typeof r.signedAt === "string" ? new Date(r.signedAt) : new Date(),
          identityEvidence: { signingStatus: r.signingStatus },
        },
      });
    } else if (r.signingStatus === "REJECTED" && signer.status !== "declined") {
      await db.esignSigner.update({ where: { id: signer.id }, data: { status: "declined" } });
    } else if (r.signingStatus === "NOT_SIGNED" && signer.status === "pending" && transition.signerStatus === "viewed") {
      await db.esignSigner.update({ where: { id: signer.id }, data: { status: "viewed" } });
    }
  }

  // Envelope-level transition. COMPLETED additionally pulls the sealed PDF —
  // the evidence that makes "completed" mean something.
  let sealedPdfFetched = false;
  const wasCompleted = envelope.status === "completed";
  if (transition.envelopeStatus === "completed") {
    try {
      const sealed = await vendor.getSealedPdf(envelope.vendorRef!);
      await db.esignEnvelope.update({
        where: { id: envelope.id },
        data: {
          status: "completed",
          vendorStatus: "COMPLETED",
          sealedPdf: Buffer.from(sealed.bytes),
          sealedPdfHash: sealed.hash,
          sealedPdfFetchedAt: new Date(),
        },
      });
      sealedPdfFetched = true;
    } catch {
      await db.esignEnvelope.update({
        where: { id: envelope.id },
        data: { status: "completed", vendorStatus: "COMPLETED" },
      });
    }
    // Pipeline links fire ONLY on the first completion transition: the vendor
    // sealed the document, so downstream objects (proposal→contract, SOW→
    // invoice-draft, contract→executed) may react. Announced as subscribable
    // internal events with a durable audit row the future legal/pipeline
    // modules can replay — nothing here invents downstream records.
    if (!wasCompleted) {
      await firePipelineLinks(db, {
        id: envelope.id,
        workspaceId: envelope.workspaceId,
        contractType: envelope.contractType,
        contractRef: envelope.contractRef,
        pipelineRef: envelope.pipelineRef,
      });
    }
  } else if (transition.envelopeStatus) {
    // Never regress a terminal state: completed/voided/declined are final.
    const terminal = ["completed", "voided", "declined"].includes(envelope.status);
    if (!terminal) {
      await db.esignEnvelope.update({
        where: { id: envelope.id },
        data: { status: transition.envelopeStatus },
      });
    }
  }

  const appended = await appendAuditEvent(db, {
    envelopeId: envelope.id,
    event: `webhook:${parsed.event}`,
    actor: "webhook:documenso",
    payload: {
      documentId: parsed.documentId,
      transition: transition.envelopeStatus ?? null,
      sealedPdfFetched,
    },
    bodyHash,
  });
  if (!appended.ok) return { ok: true, deduped: true };
  return { ok: true, applied: transition.envelopeStatus ?? "signer_update" };
}
