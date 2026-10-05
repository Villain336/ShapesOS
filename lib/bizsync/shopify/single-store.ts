// ShapesOS — Phase 14 (connectors): Shopify as a single-store connector (no
// public app, no App Store listing).
//
// WHAT SHOPIFY SUPPORTS (verified 2026-10-05):
//   * shopify.dev/docs/apps/build/authentication-authorization — "Is a
//     server-side integration that acts on your own stores → Client
//     credentials grant". Apps created directly in the Shopify admin "can no
//     longer" be created; existing ones keep their pre-generated token.
//   * shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant
//       POST https://{shop}.myshopify.com/admin/oauth/access_token
//       Content-Type: application/x-www-form-urlencoded
//       grant_type=client_credentials&client_id=…&client_secret=…
//       → { "access_token": "…", "scope": "read_products", "expires_in": 86399 }
//     Only works when the app and the store are in the same Shopify
//     organization (error "shop_not_permitted" otherwise). Tokens last 24 h;
//     request a new one when needed (there is no refresh token).
//   * shopify.dev/docs/apps/build/authentication-authorization/legacy/admin-custom-apps
//     — an existing admin-created custom app's Admin API token (shpat_…) is
//     static: it works until the app is uninstalled.
//   * shopify.dev/docs/apps/build/webhooks/verify-deliveries — webhooks are
//     signed (X-Shopify-Hmac-SHA256, base64 HMAC-SHA256 of the raw body) with
//     the app's client secret; an admin-created app signs with its API secret
//     key. So the per-connection webhook secret is the client secret (mode
//     client_credentials) or the optional API secret key (mode admin_token).
//
// Mandatory compliance webhooks (customers/data_request, customers/redact,
// shop/redact) are NOT built for this path: shopify.dev/docs/apps/build/
// compliance/privacy-law-compliance says they are "callback methods that
// Shopify requires for apps listed on the Shopify App Store", and they can
// only be subscribed through the app configuration, not the Admin API. A
// single-store app belongs to the merchant's own organization, so the
// merchant is the controller of the data ShapesOS syncs from their store.
//
// The stored credential is { auth_mode, shop, access_token, webhook_secret?,
// client_id?, client_secret?, scope? } — shopifyAuthFrom
// (lib/connectors/m21/native/shopify.ts) reads only access_token + shop, so
// the adapter, the sync engine and the Business sync page work unchanged.
// Nothing here logs or returns a token or secret.

import { ConnectorApiError, scrubMessage, type LiveDeps } from "@/lib/connectors/m21/live/http";
import { safeFetch } from "@/lib/connectors/safe-fetch";
import { SHOPIFY_SCOPES } from "@/lib/connectors/m21/registry";
import { shopifyGraphql, type ShopifyAuth } from "./api";
import { normalizeShopDomain } from "./shop";

const PROVIDER = "Shopify";

export type SingleStoreMode = "client_credentials" | "admin_token";
export const SINGLE_STORE_MODES: readonly SingleStoreMode[] = ["client_credentials", "admin_token"];

export interface ClientCredentialsToken {
  access_token: string;
  scope: string;
  expires_in: number;
}

/** Exchange a Dev Dashboard app's client ID + secret for a 24-hour Admin API token. */
export async function mintClientCredentialsToken(
  shopInput: string,
  clientId: string,
  clientSecret: string,
  deps: LiveDeps = {},
): Promise<ClientCredentialsToken> {
  const shop = normalizeShopDomain(shopInput);
  if (!shop) throw new ConnectorApiError(PROVIDER, "config_missing", "The store domain must be your-store.myshopify.com.");
  let res: Response;
  try {
    res = await safeFetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }).toString(),
      },
      { fetchFn: deps.fetchImpl ?? fetch, resolve: deps.resolve },
    );
  } catch {
    throw new ConnectorApiError(PROVIDER, "provider_unreachable", "Shopify could not be reached.");
  }
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  if (!res.ok || typeof body.access_token !== "string" || !body.access_token) {
    const raw = scrubMessage(`${String(body.error ?? "")} ${String(body.error_description ?? "")}`.trim() || text.slice(0, 200), [clientSecret]);
    if (/shop_not_permitted/i.test(raw)) {
      throw new ConnectorApiError(PROVIDER, "forbidden", "Shopify refused: this store is not in the same Shopify organization as the app (shop_not_permitted). Create the app in the store's own organization in the Dev Dashboard.", res.status);
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new ConnectorApiError(PROVIDER, "auth_rejected", `Shopify rejected the client ID or secret${raw ? `: ${raw.slice(0, 160)}` : ""}.`, res.status);
    }
    throw new ConnectorApiError(PROVIDER, res.status >= 500 ? "provider_error" : "bad_request", `Shopify token request failed (HTTP ${res.status}).`, res.status);
  }
  const expires = Number(body.expires_in);
  return {
    access_token: body.access_token,
    scope: typeof body.scope === "string" ? body.scope : "",
    // Documented as always 86399; fall back to that if a response omits it.
    expires_in: Number.isFinite(expires) && expires > 0 ? expires : 86_399,
  };
}

export interface ShopProbe {
  name: string;
  domain: string;
  scopes: string[];
}

/** The cheapest useful call: the shop's name and the token's granted scopes. */
export async function probeShop(auth: ShopifyAuth, deps: LiveDeps = {}): Promise<ShopProbe> {
  const data = await shopifyGraphql<{ shop?: { name?: string; myshopifyDomain?: string }; currentAppInstallation?: { accessScopes?: Array<{ handle?: string }> } }>(
    auth,
    "query ShapesProbe { shop { name myshopifyDomain } currentAppInstallation { accessScopes { handle } } }",
    {},
    deps,
  );
  return {
    name: data.shop?.name?.slice(0, 200) || auth.shop,
    domain: data.shop?.myshopifyDomain || auth.shop,
    scopes: (data.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle ?? "").filter(Boolean),
  };
}

/** Scopes ShapesOS's sync needs that the token lacks (write_x implies read_x). PURE. */
export function missingScopes(granted: readonly string[], needed: readonly string[] = SHOPIFY_SCOPES): string[] {
  const have = new Set(granted.map((s) => s.trim()).filter(Boolean));
  for (const s of [...have]) if (s.startsWith("write_")) have.add(`read_${s.slice(6)}`);
  return needed.filter((s) => !have.has(s));
}

export interface SingleStoreCredential {
  payload: Record<string, unknown>;
  label: string;
  scopes: string[];
  expiresAt: Date | null;
  warnings: string[];
}

/**
 * Validate the typed-in credential against Shopify (token request and/or one
 * GraphQL call) and build what the vault stores. Throws ConnectorApiError
 * with a person-readable message; never echoes a secret.
 */
export async function buildSingleStoreCredential(
  mode: SingleStoreMode,
  values: Record<string, string>,
  deps: LiveDeps & { now?: () => number } = {},
): Promise<SingleStoreCredential> {
  const shop = normalizeShopDomain(values.shop);
  if (!shop) throw new ConnectorApiError(PROVIDER, "config_missing", "The store domain must be your-store.myshopify.com.");
  const now = deps.now?.() ?? Date.now();
  let payload: Record<string, unknown>;
  let expiresAt: Date | null = null;
  if (mode === "client_credentials") {
    const clientId = values.client_id ?? "";
    const clientSecret = values.client_secret ?? "";
    if (!clientId || !clientSecret) throw new ConnectorApiError(PROVIDER, "config_missing", "Client ID and client secret are required.");
    const t = await mintClientCredentialsToken(shop, clientId, clientSecret, deps);
    expiresAt = new Date(now + t.expires_in * 1000);
    payload = {
      auth_mode: "client_credentials",
      shop,
      access_token: t.access_token,
      client_id: clientId,
      client_secret: clientSecret,
      // Shopify signs this app's webhooks with its client secret.
      webhook_secret: clientSecret,
      scope: t.scope,
    };
  } else {
    const token = values.access_token ?? "";
    if (!token) throw new ConnectorApiError(PROVIDER, "config_missing", "The Admin API access token is required.");
    payload = { auth_mode: "admin_token", shop, access_token: token, ...(values.webhook_secret ? { webhook_secret: values.webhook_secret } : {}) };
  }
  const probe = await probeShop({ shop, token: String(payload.access_token) }, deps);
  const scopes = probe.scopes.length ? probe.scopes : String(payload.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const warnings: string[] = [];
  const missing = missingScopes(scopes);
  if (missing.length) warnings.push(`The app is missing scope${missing.length === 1 ? "" : "s"} ${missing.join(", ")} — those parts of the sync will be refused until you add them to the app.`);
  if (mode === "admin_token" && !values.webhook_secret) warnings.push("No API secret key: webhooks from this store will be refused until you reconnect with it.");
  return { payload, label: `${probe.name} (${shop})`.slice(0, 120), scopes, expiresAt, warnings };
}

/** Is this decrypted payload a single-store (non-OAuth) Shopify credential? PURE. */
export function singleStoreModeOf(payload: Record<string, unknown> | null | undefined): SingleStoreMode | null {
  const m = payload?.auth_mode;
  return m === "client_credentials" || m === "admin_token" ? m : null;
}

/**
 * The credential's next state for lib/vault/refresh.ts:
 *   client_credentials → a fresh 24-hour token (same client ID + secret);
 *   admin_token        → the static token, re-verified with one call (it has
 *                        nothing to rotate; a 401 means the app was removed).
 * Throws when Shopify refuses (the caller marks the connection needs_reauth).
 */
export async function renewSingleStoreCredential(
  payload: Record<string, unknown>,
  deps: LiveDeps & { now?: () => number } = {},
): Promise<{ payload: Record<string, unknown>; expiresAt: Date | null }> {
  const mode = singleStoreModeOf(payload);
  const shop = typeof payload.shop === "string" ? payload.shop : "";
  if (mode === "client_credentials") {
    const t = await mintClientCredentialsToken(shop, String(payload.client_id ?? ""), String(payload.client_secret ?? ""), deps);
    const now = deps.now?.() ?? Date.now();
    return { payload: { ...payload, access_token: t.access_token, scope: t.scope }, expiresAt: new Date(now + t.expires_in * 1000) };
  }
  if (mode === "admin_token") {
    await probeShop({ shop, token: String(payload.access_token ?? "") }, deps);
    return { payload, expiresAt: null };
  }
  throw new ConnectorApiError(PROVIDER, "config_missing", "Not a single-store Shopify credential.");
}

/**
 * Connect a store: validate with Shopify, store the credential (encrypted),
 * then point the workspace's Tier-W Shopify connector at it (per-connection
 * webhook secret). Returns the connection and any warnings.
 */
export async function connectShopifySingleStore(
  input: { userId: string; workspaceId: string; mode: SingleStoreMode; values: Record<string, string>; label?: string | null },
  deps: LiveDeps & { now?: () => number } = {},
) {
  const built = await buildSingleStoreCredential(input.mode, input.values, deps);
  const { storeCredentialPayload } = await import("@/lib/vault/apikey");
  const label = input.label?.trim() ? input.label.trim().slice(0, 120) : built.label;
  const stored = await storeCredentialPayload(input.userId, input.workspaceId, "shopify", label, built.payload, {
    scopes: built.scopes,
    expiresAt: built.expiresAt,
  });
  // Non-secret display/routing meta, like the OAuth path's { shop, label }.
  const { prisma } = await import("@/lib/prisma");
  const connection = await prisma.connectorConnection.update({
    where: { id: stored.id, workspaceId: input.workspaceId },
    data: { meta: { label, shop: String(built.payload.shop), authMode: input.mode } },
  });
  const { onBizsyncConnected } = await import("../install");
  await onBizsyncConnected({ connectorKey: "shopify", connection, singleStore: true });
  return { connection, warnings: built.warnings, label: built.label };
}
