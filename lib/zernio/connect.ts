// ShapesOS — Phase 15.4 (zernio): "Connect an account" and its callback.
//
// The flow (getConnectUrl, GET /v1/connect/{platform}; connectAds, GET
// /v1/connect/{platform}/ads):
//   1. An admin clicks Connect on the Zernio card. We ask Zernio for an authUrl
//      for THIS workspace's profile, with redirect_url = our callback carrying
//      a short signed state (workspace + the user who started it, 30 min).
//   2. Zernio hosts the consent / selection screens, then redirects the
//      browser to the callback with connected=…&profileId=…&accountId=… (or
//      error=…). Those params are browser-controlled and never trusted.
//   3. The callback checks the state against the signed-in user, then asks
//      Zernio which accounts are on OUR profile (listAccounts?profileId=) and
//      records the account only if it is there — so a crafted redirect can
//      never attach another workspace's (or a made-up) account.
// X caps the URL-encoded redirect_url at 258 characters: the state is ~60
// characters and the callback path is short, and we refuse a longer one
// instead of letting X fail mid-flow.

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ZERNIO_AD_NETWORKS,
  ZERNIO_SOCIAL_PLATFORMS,
  ZERNIO_PLATFORM_LABELS,
  isZernioId,
} from "./spec";
import {
  ZernioScopeError,
  recordConnectedAccount,
  requireOwnedAccount,
  type ZernioAccountRow,
  type ZernioScope,
} from "./tenancy";

export const CONNECT_STATE_TTL_MS = 30 * 60 * 1000;
/** getConnectUrl: X's OAuth state limit on the URL-encoded redirect_url for API callers. */
export const X_REDIRECT_URL_MAX = 258;
export const CALLBACK_PATH = "/api/zernio/callback";

export class ZernioConnectConfigError extends Error {
  constructor() {
    super("Zernio connect needs AUTH_SECRET (or NEXTAUTH_SECRET) on the server to sign the callback.");
    this.name = "ZernioConnectConfigError";
  }
}

function secret(env: Record<string, string | undefined>): string {
  const s = env.AUTH_SECRET?.trim() || env.NEXTAUTH_SECRET?.trim();
  if (!s) throw new ZernioConnectConfigError();
  return s;
}

function mac(key: string, ws: string, userId: string, exp: string): string {
  const k = createHmac("sha256", key).update("shapes:zernio-connect:v1").digest();
  return createHmac("sha256", k).update(`${ws}.${userId}.${exp}`).digest("base64url").slice(0, 22);
}

const WS_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `<workspaceId>.<exp base36>.<mac>` — bound to the user who started the flow. */
export function signConnectState(
  input: { workspaceId: string; userId: string; now?: number },
  env: Record<string, string | undefined> = process.env,
): string {
  if (!WS_RE.test(input.workspaceId)) throw new Error("bad workspace id");
  const exp = Math.floor(((input.now ?? Date.now()) + CONNECT_STATE_TTL_MS) / 1000).toString(36);
  return `${input.workspaceId}.${exp}.${mac(secret(env), input.workspaceId, input.userId, exp)}`;
}

/** The workspace the state names — only for the user it was issued to, before it expires. */
export function verifyConnectState(
  state: string | null | undefined,
  input: { userId: string; now?: number },
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (typeof state !== "string" || state.length > 200) return null;
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [ws, exp, sig] = parts as [string, string, string];
  if (!WS_RE.test(ws) || !/^[0-9a-z]{1,12}$/.test(exp)) return null;
  const expected = mac(secret(env), ws, input.userId, exp);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (parseInt(exp, 36) * 1000 < (input.now ?? Date.now())) return null;
  return ws;
}

export function callbackUrl(origin: string, state: string): string {
  return `${origin.replace(/\/+$/, "")}${CALLBACK_PATH}?s=${state}`;
}

export type ConnectStart =
  | { kind: "redirect"; authUrl: string }
  | { kind: "already_connected"; account: ZernioAccountRow };

/**
 * Start connecting an account on the workspace's profile.
 *   kind "social": a posting platform (getConnectUrl) — one of the 16.
 *   kind "ads": an ad network (connectAds) — Meta, Google, TikTok, LinkedIn,
 *     Pinterest, X (needs one of this workspace's X accounts). OpenAI Ads is a
 *     key, see connectOpenAIAds().
 */
export async function startConnect(
  scope: ZernioScope,
  input: { kind: "social" | "ads"; platform: string; origin: string; userId: string; postingAccountId?: string | null },
): Promise<ConnectStart> {
  const state = signConnectState({ workspaceId: scope.workspaceId, userId: input.userId });
  const redirectUrl = callbackUrl(input.origin, state);
  if (encodeURIComponent(redirectUrl).length > X_REDIRECT_URL_MAX) {
    throw new ZernioScopeError("This server's address is too long for X's connect flow (258 characters, URL-encoded). Use a shorter domain.");
  }
  if (input.kind === "social") {
    if (!(ZERNIO_SOCIAL_PLATFORMS as readonly string[]).includes(input.platform)) {
      throw new ZernioScopeError(`Zernio can't connect "${input.platform}".`);
    }
    const { authUrl } = await scope.client.getConnectUrl(input.platform, { profileId: scope.profileId, redirectUrl });
    return { kind: "redirect", authUrl };
  }
  const network = ZERNIO_AD_NETWORKS.find((n) => n.key === input.platform);
  if (!network || network.connect.kind !== "oauth") {
    throw new ZernioScopeError(network?.connect.kind === "credentials" ? "OpenAI Ads connects with a ChatGPT Ads Manager key." : `Unknown ad network "${input.platform}".`);
  }
  let accountId: string | undefined;
  if (network.connect.needsPostingAccount) {
    // connectAds: "twitter (X Ads): accountId is REQUIRED" — and it must be OURS.
    const row = await requireOwnedAccount(scope, input.postingAccountId, { category: "social" });
    if (row.platform !== network.connect.needsPostingAccount) {
      throw new ZernioScopeError(`${network.label} needs one of this workspace's ${ZERNIO_PLATFORM_LABELS[network.connect.needsPostingAccount]} accounts — connect it first.`);
    }
    accountId = row.accountId;
  }
  const r = await scope.client.connectAds(network.connect.platform, { profileId: scope.profileId, redirectUrl, accountId });
  if (r.alreadyConnected && r.accountId) return { kind: "already_connected", account: await recordConnectedAccount(scope, r.accountId) };
  if (!r.authUrl) throw new ZernioScopeError("Zernio returned no connect URL.");
  return { kind: "redirect", authUrl: r.authUrl };
}

/** OpenAI Ads (connectOpenAIAdsCredentials): the customer's own key, passed to Zernio, never stored here. */
export async function connectOpenAIAds(scope: ZernioScope, apiKey: string): Promise<ZernioAccountRow> {
  const key = apiKey.trim();
  if (!key || key.length > 500) throw new ZernioScopeError("Paste the API key from ChatGPT Ads Manager.");
  const r = await scope.client.connectOpenAIAdsCredentials({ apiKey: key, profileId: scope.profileId });
  if (!r.accountId) throw new ZernioScopeError("Zernio did not return the connected OpenAI Ads account.");
  return recordConnectedAccount(scope, r.accountId);
}

export interface CallbackOutcome {
  ok: boolean;
  platform: string | null;
  message: string;
  account?: ZernioAccountRow;
}

/**
 * The redirect back from Zernio. `scope` is the workspace the VERIFIED state
 * names (the route checks the signed-in user is its admin). Records the
 * account only when Zernio lists it on this workspace's profile.
 */
export async function completeConnect(scope: ZernioScope, query: Record<string, string>): Promise<CallbackOutcome> {
  const platform = (query.connected ?? query.platform ?? "").slice(0, 40) || null;
  if (query.error) {
    const detail = (query.error_message ?? "").slice(0, 300);
    return { ok: false, platform, message: `${ZERNIO_PLATFORM_LABELS[platform ?? ""] ?? platform ?? "The account"} was not connected: ${detail || query.error.slice(0, 80)}.` };
  }
  if (query.profileId && query.profileId !== scope.profileId) {
    return { ok: false, platform, message: "The connection came back for a different Zernio profile, so it was not recorded." };
  }
  const accountId = query.accountId ?? "";
  if (!isZernioId(accountId)) {
    // tiktok / twitter / googleads ads flows land on redirect_url unchanged:
    // pick up whatever is now on the profile.
    const { syncZernioAccounts } = await import("./tenancy");
    await syncZernioAccounts(scope);
    return { ok: true, platform, message: "Zernio finished the connection; your accounts are refreshed below." };
  }
  const account = await recordConnectedAccount(scope, accountId);
  return { ok: true, platform: account.platform, message: `Connected ${ZERNIO_PLATFORM_LABELS[account.platform] ?? account.platform}${account.username ? ` (${account.username})` : ""}.`, account };
}
