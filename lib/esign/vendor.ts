// Marketr — E-sign module: vendor-agnostic envelope domain (SPEC-GAP-ESIGN.md §4–5).
// Pure domain logic: status vocabularies, Documenso → envelope status/event
// mapping, and the EsignVendor interface. The DocuSign reserve rail (not v1)
// plugs into this same interface later.

export type EnvelopeStatus =
  | "draft"
  | "sent"
  | "partially-signed"
  | "completed"
  | "declined"
  | "expired"
  | "voided"
  | "error";

export type SignerStatus = "pending" | "viewed" | "signed" | "declined";
export type SignerRole = "signer" | "approver" | "cc";
export type FieldType = "signature" | "initials" | "date" | "text" | "checkbox";
export type SigningOrder = "sequential" | "parallel";

export interface VendorSignerInput {
  name: string;
  email: string;
  role: SignerRole;
  orderIndex: number;
}

export interface VendorFieldInput {
  /** Matches the signer by email; undefined = unassigned. */
  signerEmail?: string;
  fieldType: FieldType;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
}

export interface VendorEnvelopeStatus {
  vendorStatus: string;
  envelopeStatus: EnvelopeStatus;
}

export interface VendorTemplateSummary {
  id: string;
  name: string;
}

/**
 * The vendor adapter every rail implements. E-sign is an evidence domain:
 * the vendor seals the PDF and owns the audit trail; we mirror both and
 * never invent signatures. Completion is vendor-event-driven only.
 */
export interface EsignVendor {
  readonly name: "documenso";
  createEnvelope(input: {
    title: string;
    pdfBytes: Uint8Array;
    filename: string;
  }): Promise<{ vendorRef: string; vendorStatus: string }>;
  addSigners(vendorRef: string, signers: VendorSignerInput[]): Promise<void>;
  addFields(vendorRef: string, fields: VendorFieldInput[]): Promise<void>;
  sendEnvelope(vendorRef: string): Promise<void>;
  voidEnvelope(vendorRef: string, reason: string): Promise<void>;
  getStatus(vendorRef: string): Promise<VendorEnvelopeStatus>;
  getSealedPdf(vendorRef: string): Promise<{ bytes: Uint8Array; hash: string }>;
  listTemplates(): Promise<VendorTemplateSummary[]>;
}

// ---------------------------------------------------------------------------
// Documenso v1 status → envelope status.
// Documenso lifecycle (verified 2026-10-01 via Documenso docs):
//   DRAFT → PENDING → COMPLETED, with REJECTED / CANCELLED terminal states.
// We never claim "completed" on anything but the vendor's COMPLETED.
// ---------------------------------------------------------------------------

export const DOCUMENSO_STATUSES = ["DRAFT", "PENDING", "COMPLETED", "REJECTED", "CANCELLED"] as const;

export function mapDocumensoStatus(
  vendorStatus: string,
  signedCount: number,
  signerCount: number,
): EnvelopeStatus {
  switch (vendorStatus.toUpperCase()) {
    case "DRAFT":
      return "draft";
    case "COMPLETED":
      return "completed";
    case "REJECTED":
      return "declined";
    case "CANCELLED":
      return "voided";
    case "PENDING":
      return signedCount > 0 && signedCount < signerCount ? "partially-signed" : "sent";
    default:
      // Unknown vendor state: never guess. The refresh caller surfaces this
      // as an explicit "error" rather than a fabricated status.
      return "error";
  }
}

// ---------------------------------------------------------------------------
// Documenso webhook events → envelope/signer transitions.
// Verified 2026-10-01 via Documenso webhook docs (setup.mdx). Payload shape:
//   { event, payload: { id, title, Recipient: [...], completedAt, ... }, createdAt }
// ---------------------------------------------------------------------------

export const DOCUMENSO_WEBHOOK_EVENTS = [
  "DOCUMENT_CREATED",
  "DOCUMENT_SENT",
  "DOCUMENT_OPENED",
  "DOCUMENT_SIGNED",
  "DOCUMENT_RECIPIENT_COMPLETED",
  "DOCUMENT_CANCELLED",
  "DOCUMENT_COMPLETED",
  "DOCUMENT_REJECTED",
  "RECIPIENT_EXPIRED",
  "DOCUMENT_REMINDER_SENT",
] as const;

export interface WebhookTransition {
  envelopeStatus?: EnvelopeStatus;
  /** "signed" | "declined" | "viewed" applied to the matching signer row. */
  signerStatus?: SignerStatus;
  terminal: boolean;
}

/**
 * Map a Documenso webhook event to the envelope transition it drives.
 * Returns null for events we intentionally ignore (created, reminder).
 * Only DOCUMENT_COMPLETED drives "completed" — evidence rule §4.4.2.
 */
export function mapDocumensoWebhookEvent(event: string): WebhookTransition | null {
  switch (event) {
    case "DOCUMENT_SENT":
      return { envelopeStatus: "sent", terminal: false };
    case "DOCUMENT_OPENED":
      return { signerStatus: "viewed", terminal: false };
    case "DOCUMENT_SIGNED":
    case "DOCUMENT_RECIPIENT_COMPLETED":
      return { envelopeStatus: "partially-signed", signerStatus: "signed", terminal: false };
    case "DOCUMENT_COMPLETED":
      return { envelopeStatus: "completed", terminal: true };
    case "DOCUMENT_REJECTED":
      return { envelopeStatus: "declined", signerStatus: "declined", terminal: true };
    case "DOCUMENT_CANCELLED":
      return { envelopeStatus: "voided", terminal: true };
    case "RECIPIENT_EXPIRED":
      return { envelopeStatus: "expired", terminal: true };
    case "DOCUMENT_CREATED":
    case "DOCUMENT_REMINDER_SENT":
      return null;
    default:
      return null;
  }
}
