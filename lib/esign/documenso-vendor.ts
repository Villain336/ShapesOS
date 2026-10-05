// Marketr — E-sign module: Documenso rail (SPEC-GAP-ESIGN.md §5).
// Consumes Documenso's HOSTED service via API at arm's length. Nothing here
// embeds Documenso code (AGPL-3.0): all calls are plain HTTPS against
// DOCUMENSO_URL with DOCUMENSO_API_KEY, server-side only.
//
// Endpoint pinning (verified 2026-10-01 against Documenso's public docs):
//   POST   /api/v1/documents                  multipart file+title → { id }
//   POST   /api/v1/documents/{id}/recipients  { name, email, role }
//   POST   /api/v1/documents/{id}/fields      { type, pageNumber, pageX, ... }
//   POST   /api/v1/documents/{id}/send
//   DELETE /api/v1/documents/{id}             (void; completed docs cannot be deleted)
//   GET    /api/v1/documents/{id}             → { id, status, ... }
//   GET    /api/v1/documents/{id}/download    → sealed PDF bytes (post-completion)
//   GET    /api/v1/templates                  → template list
// The void / fields / download / templates calls are DOCUMENTED but have not
// been exercised against a live instance (no credentials); they fail closed
// with DocumensoApiError on any unexpected shape instead of misbehaving.
// Note: Documenso is migrating v1 → v2 (envelope-based). v1 is what Phase 12
// proved; v2 migration is a tracked follow-up, not v1 scope.

import { createHash, timingSafeEqual } from "node:crypto";
import {
  DocumensoApiError,
  addDocumensoSigners,
  createDocumensoDocument,
  getDocumensoDocument,
  sendDocumensoDocument,
  type DocumensoSigner,
} from "@/lib/integrations/documenso";
// Phase 15.1: the workspace's own Documenso (a shared one is refused on hosted).
import { sidecarEnv } from "@/lib/integrations/sidecar-tenancy";
import {
  mapDocumensoStatus,
  type EnvelopeStatus,
  type EsignVendor,
  type FieldType,
  type SignerRole,
  type VendorEnvelopeStatus,
  type VendorFieldInput,
  type VendorSignerInput,
  type VendorTemplateSummary,
} from "./vendor";

export const DOCUMENSO_WEBHOOK_SECRET_ENV = "DOCUMENSO_WEBHOOK_SECRET";

type FetchImpl = typeof fetch;

function base(env: Record<string, string | undefined>): string {
  const url = env.DOCUMENSO_URL;
  if (!url) throw new DocumensoApiError(0, "Documenso is not configured (DOCUMENSO_URL).");
  return url.replace(/\/+$/, "");
}

function key(env: Record<string, string | undefined>): string {
  const k = env.DOCUMENSO_API_KEY;
  if (!k) throw new DocumensoApiError(0, "Documenso is not configured (DOCUMENSO_API_KEY).");
  return k;
}

async function apiFetch(
  path: string,
  init: RequestInit,
  fetchImpl: FetchImpl,
  env: Record<string, string | undefined>,
): Promise<{ res: Response; json: unknown }> {
  let res: Response;
  try {
    res = await fetchImpl(`${base(env)}/api/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key(env)}`,
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new DocumensoApiError(0, "Could not reach the Documenso instance.");
  }
  const contentType = res.headers.get("content-type") ?? "";
  const json = contentType.includes("json")
    ? await res.json().catch(() => null)
    : null;
  if (!res.ok) {
    const msg =
      (json as { message?: string; error?: string } | null)?.message ??
      (json as { message?: string; error?: string } | null)?.error ??
      `Documenso request failed with HTTP ${res.status}.`;
    throw new DocumensoApiError(res.status, msg);
  }
  return { res, json };
}

function roleToDocumenso(role: SignerRole): DocumensoSigner["role"] {
  switch (role) {
    case "approver":
      return "APPROVER";
    case "cc":
      return "VIEWER";
    default:
      return "SIGNER";
  }
}

function fieldTypeToDocumenso(t: FieldType): string {
  switch (t) {
    case "signature":
      return "SIGNATURE";
    case "initials":
      return "INITIALS";
    case "date":
      return "DATE";
    case "text":
      return "TEXT";
    case "checkbox":
      return "CHECKBOX";
  }
}

export interface DocumensoFieldPayload {
  type: string;
  pageNumber: number;
  pageX: number;
  pageY: number;
  pageWidth: number;
  pageHeight: number;
  recipientEmail?: string;
}

/** Build the v1 field payload. Extracted for tests. */
export function buildDocumensoFieldPayload(f: VendorFieldInput): DocumensoFieldPayload {
  return {
    type: fieldTypeToDocumenso(f.fieldType),
    pageNumber: f.page,
    pageX: f.x,
    pageY: f.y,
    pageWidth: f.width,
    pageHeight: f.height,
    ...(f.signerEmail ? { recipientEmail: f.signerEmail } : {}),
  };
}

/** Add signature fields to a document (one call per field — Documenso v1 API). */
export async function addDocumensoFields(
  documentId: string,
  fields: VendorFieldInput[],
  fetchImpl: FetchImpl = fetch,
  env: Record<string, string | undefined> = sidecarEnv("documenso"),
): Promise<void> {
  for (const field of fields) {
    await apiFetch(
      `/documents/${encodeURIComponent(documentId)}/fields`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildDocumensoFieldPayload(field)),
      },
      fetchImpl,
      env,
    );
  }
}

/**
 * Void (delete) a document. Documenso refuses completed documents — that
 * refusal surfaces as a DocumensoApiError, never a silent no-op.
 */
export async function voidDocumensoDocument(
  documentId: string,
  fetchImpl: FetchImpl = fetch,
  env: Record<string, string | undefined> = sidecarEnv("documenso"),
): Promise<void> {
  await apiFetch(
    `/documents/${encodeURIComponent(documentId)}`,
    { method: "DELETE" },
    fetchImpl,
    env,
  );
}

/** Download the sealed PDF (only meaningful after COMPLETED). */
export async function downloadDocumensoDocument(
  documentId: string,
  fetchImpl: FetchImpl = fetch,
  env: Record<string, string | undefined> = sidecarEnv("documenso"),
): Promise<Uint8Array> {
  const { res } = await apiFetch(
    `/documents/${encodeURIComponent(documentId)}/download`,
    { method: "GET" },
    fetchImpl,
    env,
  );
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) {
    throw new DocumensoApiError(502, "Documenso returned an empty document download.");
  }
  return new Uint8Array(buf);
}

/** List templates. Defensive parse — the list shape varies across versions. */
export async function listDocumensoTemplates(
  fetchImpl: FetchImpl = fetch,
  env: Record<string, string | undefined> = sidecarEnv("documenso"),
): Promise<VendorTemplateSummary[]> {
  const { json } = await apiFetch("/templates", { method: "GET" }, fetchImpl, env);
  const raw = Array.isArray(json)
    ? json
    : Array.isArray((json as { templates?: unknown } | null)?.templates)
      ? (json as { templates: unknown[] }).templates
      : Array.isArray((json as { data?: unknown } | null)?.data)
        ? (json as { data: unknown[] }).data
        : null;
  if (!raw) {
    throw new DocumensoApiError(502, "Documenso returned an unrecognized template list shape.");
  }
  const out: VendorTemplateSummary[] = [];
  for (const t of raw) {
    const rec = t as { id?: unknown; title?: unknown; name?: unknown };
    if (typeof rec.id === "string" || typeof rec.id === "number") {
      out.push({
        id: String(rec.id),
        name:
          typeof rec.title === "string"
            ? rec.title
            : typeof rec.name === "string"
              ? rec.name
              : String(rec.id),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Webhooks. Documenso signs deliveries with the shared secret in the
// X-Documenso-Secret header (verified 2026-10-01 via Documenso webhook docs:
// "verify the X-Documenso-Secret header"). Timing-safe compare; fail closed
// when the header or the configured secret is missing.
// ---------------------------------------------------------------------------

export function verifyDocumensoWebhookSignature(
  headerValue: string | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const secret = env[DOCUMENSO_WEBHOOK_SECRET_ENV];
  if (!secret || !headerValue) return false;
  const a = Buffer.from(headerValue);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface DocumensoWebhookPayload {
  event: string;
  documentId: string;
  title?: string;
  raw: unknown;
}

/**
 * Parse a Documenso webhook body: { event, payload: { id, title, ... }, createdAt }.
 * Throws DocumensoApiError(400) on any unrecognized shape — never partial-parse.
 */
export function parseDocumensoWebhook(rawBody: string): DocumensoWebhookPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new DocumensoApiError(400, "Documenso webhook body is not valid JSON.");
  }
  const rec = parsed as { event?: unknown; payload?: unknown; createdAt?: unknown } | null;
  if (!rec || typeof rec.event !== "string" || !rec.event) {
    throw new DocumensoApiError(400, "Documenso webhook is missing the event field.");
  }
  const payload = rec.payload as { id?: unknown; title?: unknown } | null;
  if (!payload || (typeof payload.id !== "string" && typeof payload.id !== "number")) {
    throw new DocumensoApiError(400, "Documenso webhook payload is missing the document id.");
  }
  return {
    event: rec.event,
    documentId: String(payload.id),
    title: typeof payload.title === "string" ? payload.title : undefined,
    raw: parsed,
  };
}

// ---------------------------------------------------------------------------
// The EsignVendor implementation.
// ---------------------------------------------------------------------------

export function createDocumensoVendor(
  fetchImpl: FetchImpl = fetch,
  env: Record<string, string | undefined> = sidecarEnv("documenso"),
): EsignVendor {
  return {
    name: "documenso",

    async createEnvelope({ title, pdfBytes, filename }) {
      const doc = await createDocumensoDocument(pdfBytes, filename, title, fetchImpl, env);
      return { vendorRef: doc.id, vendorStatus: doc.status };
    },

    async addSigners(vendorRef, signers: VendorSignerInput[]) {
      // Sequential order is tracked on the envelope (signing_order) and
      // surfaced in the OS UI; the v1 recipients endpoint carries name/email/role.
      await addDocumensoSigners(
        vendorRef,
        signers.map((s) => ({ name: s.name, email: s.email, role: roleToDocumenso(s.role) })),
        fetchImpl,
        env,
      );
    },

    async addFields(vendorRef, fields) {
      await addDocumensoFields(vendorRef, fields, fetchImpl, env);
    },

    async sendEnvelope(vendorRef) {
      await sendDocumensoDocument(vendorRef, fetchImpl, env);
    },

    async voidEnvelope(vendorRef) {
      await voidDocumensoDocument(vendorRef, fetchImpl, env);
    },

    async getStatus(vendorRef): Promise<VendorEnvelopeStatus> {
      const doc = await getDocumensoDocument(vendorRef, fetchImpl, env);
      // Signer-level progress needs the full document payload; the v1 GET
      // returns recipients in richer deployments. Without them we report the
      // envelope-level state only — never invent a partial count.
      return { vendorStatus: doc.status, envelopeStatus: mapDocumensoStatus(doc.status, 0, 0) };
    },

    async getSealedPdf(vendorRef) {
      const bytes = await downloadDocumensoDocument(vendorRef, fetchImpl, env);
      const hash = createHash("sha256").update(bytes).digest("hex");
      return { bytes, hash };
    },

    async listTemplates() {
      return listDocumensoTemplates(fetchImpl, env);
    },
  };
}

/** Map our envelope status back to a human label for the UI. */
export function envelopeStatusLabel(s: EnvelopeStatus): string {
  switch (s) {
    case "draft":
      return "Draft";
    case "sent":
      return "Sent";
    case "partially-signed":
      return "Partially signed";
    case "completed":
      return "Completed";
    case "declined":
      return "Declined";
    case "expired":
      return "Expired";
    case "voided":
      return "Voided";
    case "error":
      return "Error";
  }
}
