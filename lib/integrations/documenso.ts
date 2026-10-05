// Marketr — Phase 12 "embeds": Documenso signing requests (AGPL CE,
// API-ONLY against an unmodified instance). BYO: DOCUMENSO_URL +
// DOCUMENSO_API_KEY on the host, server-side only, never exposed to the
// browser. NO embedded signing UI — that is the paid Enterprise feature
// (license bible §1: Documenso row); signers get Documenso's own emailed
// signing link. No key → honest disabled state.
//
// Documenso API v1 (verified pattern):
//   POST   {url}/api/v1/documents            multipart: file, title        → { id }
//   POST   {url}/api/v1/documents/{id}/recipients  { name, email, role }  → { id }
//   POST   {url}/api/v1/documents/{id}/send                                       → sends
//   GET    {url}/api/v1/documents/{id}                                        → { status, ... }
// Auth: `Authorization: Bearer <api-token>` on every call.

import { sidecarEnv } from "./sidecar-tenancy";
export const DOCUMENSO_URL_ENV = "DOCUMENSO_URL";
export const DOCUMENSO_API_KEY_ENV = "DOCUMENSO_API_KEY";

export interface DocumensoStatus {
  configured: boolean;
  name: string;
}

export function documensoStatus(env: Record<string, string | undefined> = sidecarEnv("documenso")): DocumensoStatus {
  const configured = !!(env[DOCUMENSO_URL_ENV] && env[DOCUMENSO_API_KEY_ENV]);
  return { configured, name: "documenso" };
}

export class DocumensoApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "DocumensoApiError";
  }
}

type FetchImpl = typeof fetch;

function dsBase(env: Record<string, string | undefined>): string {
  const url = env[DOCUMENSO_URL_ENV];
  if (!url) throw new DocumensoApiError(0, "Documenso is not configured (DOCUMENSO_URL).");
  return url.replace(/\/+$/, "");
}

function dsKey(env: Record<string, string | undefined>): string {
  const key = env[DOCUMENSO_API_KEY_ENV];
  if (!key) throw new DocumensoApiError(0, "Documenso is not configured (DOCUMENSO_API_KEY).");
  return key;
}

export interface DocumensoSigner {
  name: string;
  email: string;
  /** Documenso recipient role; SIGNER is the only one we use in v1. */
  role?: "SIGNER" | "VIEWER" | "APPROVER";
}

export interface DocumensoDocument {
  id: string;
  title: string;
  status: string;
}

async function dsFetch(
  path: string,
  init: RequestInit,
  fetchImpl: FetchImpl,
  env: Record<string, string | undefined>,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(`${dsBase(env)}/api/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${dsKey(env)}`,
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new DocumensoApiError(0, "Could not reach the Documenso instance.");
  }
  const json = (await res.json().catch(() => null)) as {
    message?: string;
    error?: string;
  } | null;
  if (!res.ok) {
    const msg =
      json?.message ?? json?.error ?? `Documenso request failed with HTTP ${res.status}.`;
    throw new DocumensoApiError(res.status, msg);
  }
  return json;
}

/** Build the multipart body for POST /documents. Extracted for tests. */
export function buildCreateDocumentForm(
  pdf: Blob,
  filename: string,
  title: string,
): FormData {
  const form = new FormData();
  form.append("file", pdf, filename);
  form.append("title", title);
  return form;
}

/**
 * Create a document from a template PDF. Returns the Documenso document id.
 * `pdfBytes` is the raw PDF; the template PDF lives wherever the caller
 * keeps it (uploaded file, stored asset).
 */
export async function createDocumensoDocument(
  pdfBytes: Uint8Array,
  filename: string,
  title: string,
  fetchImpl: FetchImpl = fetch,
  env: Record<string, string | undefined> = sidecarEnv("documenso"),
): Promise<DocumensoDocument> {
  const pdf = new Blob([pdfBytes.buffer as ArrayBuffer], { type: "application/pdf" });
  const json = (await dsFetch(
    "/documents",
    { method: "POST", body: buildCreateDocumentForm(pdf, filename, title) },
    fetchImpl,
    env,
  )) as { id?: unknown; title?: unknown; status?: unknown };
  if (typeof json.id !== "string") {
    throw new DocumensoApiError(502, "Documenso returned no document id.");
  }
  return {
    id: json.id,
    title: typeof json.title === "string" ? json.title : title,
    status: typeof json.status === "string" ? json.status : "DRAFT",
  };
}

/** Add signers to a document (one call per signer — Documenso v1 API). */
export async function addDocumensoSigners(
  documentId: string,
  signers: DocumensoSigner[],
  fetchImpl: FetchImpl = fetch,
  env: Record<string, string | undefined> = sidecarEnv("documenso"),
): Promise<void> {
  for (const signer of signers) {
    await dsFetch(
      `/documents/${encodeURIComponent(documentId)}/recipients`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: signer.name,
          email: signer.email,
          role: signer.role ?? "SIGNER",
        }),
      },
      fetchImpl,
      env,
    );
  }
}

/** Send the document to all recipients for signing. */
export async function sendDocumensoDocument(
  documentId: string,
  fetchImpl: FetchImpl = fetch,
  env: Record<string, string | undefined> = sidecarEnv("documenso"),
): Promise<void> {
  await dsFetch(
    `/documents/${encodeURIComponent(documentId)}/send`,
    { method: "POST" },
    fetchImpl,
    env,
  );
}

/** Read back the live document status (DRAFT / PENDING / COMPLETED / ...). */
export async function getDocumensoDocument(
  documentId: string,
  fetchImpl: FetchImpl = fetch,
  env: Record<string, string | undefined> = sidecarEnv("documenso"),
): Promise<DocumensoDocument> {
  const json = (await dsFetch(
    `/documents/${encodeURIComponent(documentId)}`,
    { method: "GET" },
    fetchImpl,
    env,
  )) as { id?: unknown; title?: unknown; status?: unknown };
  if (typeof json.id !== "string") {
    throw new DocumensoApiError(404, "Documenso document not found.");
  }
  return {
    id: json.id,
    title: typeof json.title === "string" ? json.title : "",
    status: typeof json.status === "string" ? json.status : "UNKNOWN",
  };
}
