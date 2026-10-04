// ShapesOS — Phase 11 (bizsync): QuickBooks Online Accounting API calls.
//
//   GET  {base}/v3/company/{realmId}/query?query=<QBO SQL>&minorversion=75
//   POST {base}/v3/company/{realmId}/{entity}?minorversion=75&requestid=<key>
// base: https://quickbooks.api.intuit.com, or the sandbox host when
// QUICKBOOKS_ENVIRONMENT=sandbox. Bearer token from the vault (refresh-on-401
// through liveRequest). Docs: developer.intuit.com/app/developer/qbo/docs/api/accounting
// (Account, Customer, Vendor, Item, Invoice, CreditMemo, Bill, Payment,
// BillPayment, JournalEntry) and …/learn/rest-api-features#idempotency
// ("requestid": a repeated request with the same id returns the original
// response instead of creating again) — so creates MAY be retried safely.
// Errors come back as { Fault: { Error: [{ Message, Detail, code }], type } }.
//
// Everything here is UNVERIFIED-LIVE: tested against a labelled fake QBO.

import { liveRequest, providerMessage, type Classification, type LiveDeps, type TokenSource } from "@/lib/connectors/m21/live/http";

const PROVIDER = "QuickBooks";
export const QBO_MINOR_VERSION = "75";
export const QBO_PROD = "https://quickbooks.api.intuit.com";
export const QBO_SANDBOX = "https://sandbox-quickbooks.api.intuit.com";

export function qboBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.QUICKBOOKS_ENVIRONMENT ?? "").trim().toLowerCase() === "sandbox" ? QBO_SANDBOX : QBO_PROD;
}

export interface QboAuth {
  realmId: string;
  token: TokenSource;
}

/** QBO fault envelope → closed error code. */
export function qboClassify(status: number, body: unknown): Classification {
  const fault = (body as { Fault?: { Error?: Array<{ Message?: string; Detail?: string; code?: string }>; type?: string } } | null)?.Fault;
  const e = fault?.Error?.[0];
  const message = e ? [e.Message, e.Detail].filter(Boolean).join(" — ") : providerMessage(body);
  if (status === 401 || fault?.type === "AuthenticationFault") return { code: "auth_rejected", retryable: false, authExpired: true, message };
  if (status === 429) return { code: "rate_limited", retryable: true, message };
  if (status === 403 || fault?.type === "AuthorizationFault") return { code: "forbidden", retryable: false, message };
  if (status === 404) return { code: "not_found", retryable: false, message };
  if (status === 400 || fault?.type === "ValidationFault") return { code: "bad_request", retryable: false, message };
  if (status >= 500) return { code: "provider_error", retryable: true, message };
  return { code: "provider_error", retryable: false, message };
}

function companyUrl(auth: QboAuth, path: string): string {
  if (!/^\d{1,32}$/.test(auth.realmId)) throw new Error("The QuickBooks company id (realmId) is missing — reconnect QuickBooks.");
  return `${qboBaseUrl()}/v3/company/${auth.realmId}/${path}`;
}

/** Escape a value for a QBO query string literal. PURE. */
export function qboQuote(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export async function qboQuery<T = Record<string, unknown>>(auth: QboAuth, query: string, deps: LiveDeps = {}): Promise<T> {
  const res = await liveRequest<{ QueryResponse?: T }>(
    { provider: PROVIDER, url: companyUrl(auth, "query"), query: { query, minorversion: QBO_MINOR_VERSION }, auth: auth.token, classify: qboClassify },
    deps,
  );
  return (res?.QueryResponse ?? {}) as T;
}

/** Create one entity. `requestId` makes the call idempotent at Intuit, so retries are safe. */
export async function qboCreate<T = Record<string, unknown>>(auth: QboAuth, entity: string, body: unknown, requestId: string, deps: LiveDeps = {}): Promise<T> {
  if (!/^[a-z]+$/.test(entity)) throw new Error("bad QuickBooks entity");
  const res = await liveRequest<Record<string, unknown>>(
    {
      provider: PROVIDER,
      url: companyUrl(auth, entity),
      method: "POST",
      query: { minorversion: QBO_MINOR_VERSION, requestid: requestId },
      json: body,
      auth: auth.token,
      classify: qboClassify,
    },
    deps,
  );
  // The response wraps the entity under its PascalCase name (Invoice, Bill…).
  const value = Object.entries(res ?? {}).find(([k]) => k.toLowerCase() === entity)?.[1];
  return (value ?? {}) as T;
}
