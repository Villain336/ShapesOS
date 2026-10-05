// ShapesOS — Phase 11 (bizsync): Xero Accounting API calls.
//
//   GET  https://api.xero.com/connections                       (tenants the grant covers)
//   GET  https://api.xero.com/api.xro/2.0/{Accounts|Contacts}   header xero-tenant-id
//   PUT  https://api.xero.com/api.xro/2.0/{Contacts|Invoices|CreditNotes|Payments|ManualJournals}
//        header Idempotency-Key: <key>  (a repeated key returns the original
//        response — so creates may be retried safely)
// Docs: developer.xero.com/documentation/api/accounting/{accounts,contacts,
// invoices,creditnotes,payments,manualjournals}, …/guides/oauth2/tenants,
// …/api/accounting/requests-and-responses#idempotency. Bearer token from the
// vault (refresh-on-401 via liveRequest; access tokens live 30 minutes).
// Validation errors: HTTP 400 { Type: "ValidationException", Message,
// Elements: [{ ValidationErrors: [{ Message }] }] }. 429 carries Retry-After
// (60 calls/minute/tenant), honoured by liveRequest.
//
// Everything here is UNVERIFIED-LIVE: tested against a labelled fake Xero.

import { liveRequest, providerMessage, type Classification, type LiveDeps, type TokenSource } from "@/lib/connectors/m21/live/http";

const PROVIDER = "Xero";
export const XERO_API = "https://api.xero.com/api.xro/2.0";
export const XERO_CONNECTIONS = "https://api.xero.com/connections";

export interface XeroAuth {
  tenantId: string;
  token: TokenSource;
}

export function xeroClassify(status: number, body: unknown): Classification {
  const b = (body ?? {}) as { Type?: string; Message?: string; Detail?: string; Title?: string; Elements?: Array<{ ValidationErrors?: Array<{ Message?: string }> }> };
  const validation = (b.Elements ?? []).flatMap((e) => e.ValidationErrors ?? []).map((v) => v.Message).filter(Boolean);
  const message = validation.length ? validation.slice(0, 3).join("; ") : b.Message ?? b.Detail ?? b.Title ?? providerMessage(body);
  if (status === 401) return { code: "auth_rejected", retryable: false, authExpired: true, message };
  if (status === 429) return { code: "rate_limited", retryable: true, message };
  if (status === 403) return { code: "forbidden", retryable: false, message };
  if (status === 404) return { code: "not_found", retryable: false, message };
  if (status === 400) return { code: "bad_request", retryable: false, message };
  if (status >= 500) return { code: "provider_error", retryable: true, message };
  return { code: "provider_error", retryable: false, message };
}

const TENANT_RE = /^[0-9a-f-]{36}$/i;

export async function xeroGet<T>(auth: XeroAuth, path: string, query: Record<string, string | number | undefined> = {}, deps: LiveDeps = {}): Promise<T> {
  if (!TENANT_RE.test(auth.tenantId)) throw new Error("No Xero organisation is selected — pick one in Settings → Connectors → Business sync.");
  return liveRequest<T>({ provider: PROVIDER, url: `${XERO_API}/${path}`, query, headers: { "xero-tenant-id": auth.tenantId }, auth: auth.token, classify: xeroClassify }, deps);
}

/** Create (PUT) with an Idempotency-Key — retries return the original response. */
export async function xeroPut<T>(auth: XeroAuth, path: string, body: unknown, idempotencyKey: string, deps: LiveDeps = {}): Promise<T> {
  if (!TENANT_RE.test(auth.tenantId)) throw new Error("No Xero organisation is selected — pick one in Settings → Connectors → Business sync.");
  return liveRequest<T>(
    {
      provider: PROVIDER,
      url: `${XERO_API}/${path}`,
      method: "PUT",
      query: { summarizeErrors: "false" },
      headers: { "xero-tenant-id": auth.tenantId, "Idempotency-Key": idempotencyKey },
      json: body,
      auth: auth.token,
      classify: xeroClassify,
    },
    deps,
  );
}

export interface XeroTenant {
  tenantId: string;
  tenantName: string;
  tenantType: string;
}

/** The organisations this grant can reach (only ORGANISATION tenants are accounting files). */
export async function xeroTenants(token: TokenSource, deps: LiveDeps = {}): Promise<XeroTenant[]> {
  const rows = await liveRequest<Array<{ tenantId?: string; tenantName?: string; tenantType?: string }>>(
    { provider: PROVIDER, url: XERO_CONNECTIONS, auth: token, classify: xeroClassify },
    deps,
  );
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r.tenantId && TENANT_RE.test(r.tenantId) && (r.tenantType ?? "ORGANISATION") === "ORGANISATION")
    .map((r) => ({ tenantId: r.tenantId!, tenantName: String(r.tenantName ?? "Xero organisation").slice(0, 200), tenantType: r.tenantType ?? "ORGANISATION" }));
}
