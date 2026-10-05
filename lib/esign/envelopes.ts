// Marketr — E-sign module: governed envelope actions (SPEC-GAP-ESIGN.md §4.3).
//
// The gates, in one place:
// - create_envelope: workspace member+; validates everything up front.
// - send_envelope: HEAVY gate. Requires a fresh confirmation token computed
//   over the exact draft bytes the human reviewed. A changed draft invalidates
//   the token, so no agent path can send a stale or altered document.
// - void_envelope: requires a reason; sealed artifacts are never deleted.
// - complete_envelope: vendor-driven ONLY (DOCUMENT_COMPLETED, or a refresh
//   that reads the vendor's COMPLETED). Both go through completeEnvelope's
//   guarded flip, so pipeline links fire exactly once.
//
// State-machine integrity (Phase 2 F):
// - Status is monotonic: draft/error < sending < sent < partially-signed <
//   terminal. Every status write is a guarded updateMany that only moves
//   forward, so out-of-order webhooks or a stale refresh never regress it.
// - voided / declined / expired are terminal: later events are ignored.
// - send claims the draft (-> "sending") before any vendor call, so a double
//   confirm creates one vendor envelope; a failed send lands in "error",
//   which can be re-sent or voided.

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
      | "unknown_signer"
      | "already_signed"
      | "duplicate_nudge"
      | "unknown_nudge"
      | "nudge_already_released"
      | "not_reopenable"
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
// Status order — envelopes only ever move forward.
// ---------------------------------------------------------------------------

/** Transient claim status while a send is talking to the vendor. */
export const SENDING_STATUS = "sending";
/** A "sending" claim older than this is presumed abandoned (worker died). */
export const SEND_CLAIM_STALE_MS = 10 * 60 * 1000;

/** Final states. voided/declined/expired ignore every later vendor event. */
export const TERMINAL_ENVELOPE_STATUSES = ["completed", "declined", "voided", "expired"] as const;

const STATUS_RANK: Record<string, number> = {
  draft: 0,
  error: 0,
  [SENDING_STATUS]: 1,
  sent: 2,
  "partially-signed": 3,
  completed: 4,
  declined: 4,
  voided: 4,
  expired: 4,
};

export function isTerminalEnvelopeStatus(status: string): boolean {
  return (TERMINAL_ENVELOPE_STATUSES as readonly string[]).includes(status);
}

/** Statuses an envelope may move FROM to reach `next` (strictly lower rank). */
export function statusesBelow(next: string): string[] {
  const rank = STATUS_RANK[next];
  if (rank === undefined) return [];
  return Object.keys(STATUS_RANK).filter((s) => STATUS_RANK[s]! < rank);
}

/** Guarded forward move. True only for the caller whose write flipped it. */
async function advanceStatus(db: EsignDb, id: string, next: EnvelopeStatus): Promise<boolean> {
  const from = statusesBelow(next);
  if (from.length === 0) return false;
  const res = await db.esignEnvelope.updateMany({
    where: { id, status: { in: from } },
    data: { status: next },
  });
  return res.count === 1;
}

/**
 * The one completion path (webhook DOCUMENT_COMPLETED and refresh). The
 * flip to "completed" is a guarded updateMany; pipeline links fire only for
 * the caller whose write flipped it, so duplicate / concurrent deliveries
 * fire them once, and a voided/declined/expired envelope never completes.
 */
async function completeEnvelope(
  db: EsignDb,
  vendor: EsignVendor,
  envelope: {
    id: string;
    workspaceId: string;
    vendorRef: string | null;
    sealedPdf?: Uint8Array | null;
    contractType: string | null;
    contractRef: string | null;
    pipelineRef: unknown;
  },
): Promise<{ completed: boolean; sealedPdfFetched: boolean }> {
  let sealed: { bytes: Uint8Array; hash: string } | null = null;
  if (!envelope.sealedPdf && envelope.vendorRef) {
    try {
      sealed = await vendor.getSealedPdf(envelope.vendorRef);
    } catch {
      sealed = null; // Recovery retried on the next refresh; never blocks the status.
    }
  }
  const sealedData = sealed
    ? {
        sealedPdf: Buffer.from(sealed.bytes),
        sealedPdfHash: sealed.hash,
        sealedPdfFetchedAt: new Date(),
      }
    : {};
  const res = await db.esignEnvelope.updateMany({
    where: { id: envelope.id, status: { in: statusesBelow("completed") } },
    data: { status: "completed", vendorStatus: "COMPLETED", ...sealedData },
  });
  if (res.count === 1) {
    // Pipeline links fire ONLY on the completion transition: the vendor
    // sealed the document, so downstream objects (proposal->contract, SOW->
    // invoice-draft, contract->executed) may react. Announced as subscribable
    // internal events with a durable audit row the future legal/pipeline
    // modules can replay — nothing here invents downstream records.
    await firePipelineLinks(db, {
      id: envelope.id,
      workspaceId: envelope.workspaceId,
      contractType: envelope.contractType,
      contractRef: envelope.contractRef,
      pipelineRef: envelope.pipelineRef,
    });
    return { completed: true, sealedPdfFetched: !!sealed };
  }
  // Already completed (duplicate delivery, or refresh got there first):
  // only backfill a sealed PDF the first completion could not fetch.
  if (sealed) {
    await db.esignEnvelope.updateMany({
      where: { id: envelope.id, status: "completed", sealedPdfHash: null },
      data: sealedData,
    });
  }
  return { completed: false, sealedPdfFetched: !!sealed };
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
  // Sendable: a draft, an envelope whose earlier send failed ("error"), or a
  // send claim abandoned long enough ago that its worker is gone.
  const staleClaim =
    envelope.status === SENDING_STATUS &&
    envelope.updatedAt.getTime() < Date.now() - SEND_CLAIM_STALE_MS;
  if (envelope.status !== "draft" && envelope.status !== "error" && !staleClaim) {
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

  // Claim the exact row version the token was checked against (status +
  // updatedAt): of two concurrent confirms only one creates a vendor envelope.
  const claim = await db.esignEnvelope.updateMany({
    where: { id: envelope.id, status: envelope.status, updatedAt: envelope.updatedAt },
    data: { status: SENDING_STATUS },
  });
  if (claim.count !== 1) {
    throw new EsignGateError("not_draft", "This envelope is already being sent (or changed since review).");
  }

  let created: { vendorRef: string; vendorStatus: string } | null = null;
  let lostClaim = false;
  try {
    created = await vendor.createEnvelope({
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
    const vendorRef = created.vendorRef;
    await vendor.addSigners(vendorRef, vendorSigners);
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
      await vendor.addFields(vendorRef, vendorFields);
    }
    await vendor.sendEnvelope(vendorRef);

    // Only our own claim moves to "sent". Losing it means a stale-claim
    // re-send took over — handled as a failure below (our vendor copy is voided).
    const done = await db.esignEnvelope.updateMany({
      where: { id: envelope.id, status: SENDING_STATUS },
      data: { vendorRef, vendorStatus: created.vendorStatus, status: "sent" },
    });
    if (done.count !== 1) {
      lostClaim = true;
      throw new EsignGateError("not_draft", "Another send took over this envelope.");
    }
    const updated = (await db.esignEnvelope.findFirst({ where: { id: envelope.id } }))!;
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
    // A vendor envelope created before the failure would be orphaned (and
    // could still be signed): void it, best-effort, and say so in the audit.
    let orphanVoided: boolean | null = null;
    if (created) {
      try {
        await vendor.voidEnvelope(created.vendorRef, "Send failed before completion; superseded.");
        orphanVoided = true;
      } catch {
        orphanVoided = false;
      }
    }
    await appendAuditEvent(db, {
      envelopeId: envelope.id,
      event: "send_failed",
      actor: input.actor,
      payload: { error: message, orphanVendorRef: created?.vendorRef ?? null, orphanVoided },
      bodyHash: auditBodyHash(["send_failed", envelope.id, String(Date.now())]),
    });
    // "error" is recoverable: it can be re-sent (same token) or voided.
    // (A lost claim belongs to the other sender now — leave it alone.)
    if (!lostClaim) {
      await db.esignEnvelope.updateMany({
        where: { id: envelope.id, status: SENDING_STATUS },
        data: { status: "error" },
      });
    }
    if (e instanceof DocumensoApiError && e.status === 0) {
      throw new EsignGateError("vendor_not_configured", message);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// void_envelope — voids with reason; the sealed artifact is never deleted.
// ---------------------------------------------------------------------------

/** "error" is voidable so a failed send is never a dead end. "sending" is
 *  not: it is a seconds-long claim (a stale one can be re-sent). */
const VOIDABLE_STATUSES = ["draft", "error", "sent", "partially-signed", "expired"];

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
  if (!VOIDABLE_STATUSES.includes(envelope.status)) {
    throw new EsignGateError(
      "not_voidable",
      `Envelope in status ${envelope.status} cannot be voided.`,
    );
  }
  if (envelope.vendorRef) {
    await vendor.voidEnvelope(envelope.vendorRef, input.reason.trim());
  }
  // Guarded: a completion that landed meanwhile is never overwritten.
  const res = await db.esignEnvelope.updateMany({
    where: { id: envelope.id, status: { in: VOIDABLE_STATUSES } },
    data: { status: "voided", voidReason: input.reason.trim() },
  });
  if (res.count !== 1) {
    throw new EsignGateError("not_voidable", "The envelope changed state while voiding; reload it.");
  }
  const updated = (await db.esignEnvelope.findFirst({ where: { id: envelope.id } }))!;
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

  // Monotonic: a refresh only ever moves the status forward (a locally
  // voided envelope the vendor still reports as sent stays voided; an
  // unknown vendor state never overwrites a live one).
  let moved = false;
  let sealedPdfFetched = false;
  if (next === "completed") {
    const r = await completeEnvelope(db, vendor, envelope);
    moved = r.completed;
    sealedPdfFetched = r.sealedPdfFetched;
  } else {
    moved = await advanceStatus(db, envelope.id, next);
  }
  const updated = await db.esignEnvelope.update({
    where: { id: envelope.id },
    data: { vendorStatus },
  });
  if (moved) {
    await appendAuditEvent(db, {
      envelopeId: envelope.id,
      event: `status:${next}`,
      actor: "system",
      payload: { vendorStatus, sealedPdfFetched },
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

  // voided / declined / expired are final: a late (or replayed) vendor event
  // is recorded for evidence and otherwise ignored — no signer writes, no
  // completion, no pipeline links.
  if (envelope.status !== "completed" && isTerminalEnvelopeStatus(envelope.status)) {
    await appendAuditEvent(db, {
      envelopeId: envelope.id,
      event: `webhook:${parsed.event}`,
      actor: "webhook:documenso",
      payload: { documentId: parsed.documentId, ignored: "terminal_state", status: envelope.status },
      bodyHash,
    });
    return { ok: true, ignored: "terminal_state" };
  }

  // Signer-level updates from the payload's Recipient array (defensive).
  const raw = parsed.raw as { payload?: { Recipient?: unknown } };
  const recipients = Array.isArray(raw.payload?.Recipient) ? raw.payload!.Recipient as Array<{
    email?: unknown;
    signingStatus?: unknown;
    signedAt?: unknown;
  }> : [];
  // Validate every signer date BEFORE any write: an unparseable signedAt is
  // a malformed payload (400, not retried) — never a half-applied delivery.
  const signedAtByEmail = new Map<string, Date>();
  for (const r of recipients) {
    if (typeof r.email !== "string" || r.signingStatus !== "SIGNED") continue;
    if (r.signedAt === undefined || r.signedAt === null) continue;
    const d = typeof r.signedAt === "string" ? new Date(r.signedAt) : null;
    if (!d || Number.isNaN(d.getTime())) return { ok: false, reason: "bad_payload" };
    signedAtByEmail.set(r.email.toLowerCase(), d);
  }
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
          signedAt: signedAtByEmail.get(signer.email.toLowerCase()) ?? new Date(),
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
  // the evidence that makes "completed" mean something. Every other status
  // only moves forward (a late DOCUMENT_SENT never undoes partially-signed).
  let sealedPdfFetched = false;
  if (transition.envelopeStatus === "completed") {
    sealedPdfFetched = (await completeEnvelope(db, vendor, envelope)).sealedPdfFetched;
  } else if (transition.envelopeStatus) {
    await advanceStatus(db, envelope.id, transition.envelopeStatus);
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
