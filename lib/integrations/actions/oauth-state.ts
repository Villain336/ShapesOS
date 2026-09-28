// Marketr — Phase 14: signed OAuth state (slice 4 hardening).
//
// The Composio connect flow round-trips through OUR callback route. The
// state token binds the OAuth handshake to the (workspaceId, appKey,
// userId) triple that initiated it, so a forged callback cannot bind an
// attacker's connected_account_id to someone else's workspace.
//
// HMAC-SHA256, domain-separated purpose string, short TTL. Fail-closed:
// no secret -> initiateConnect throws instead of minting an unsigned link.

import { createHmac, timingSafeEqual } from "node:crypto";

const PURPOSE = "marketr-composio-oauth-state-v1";
export const OAUTH_STATE_TTL_MS = 15 * 60_000; // 15 min (> Composio's ~12 min link TTL)

export interface OAuthStatePayload {
  workspaceId: string;
  appKey: string;
  userId: string;
  nonce: string;
  exp: number;
}

export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthStateError";
  }
}

/** Fail-closed: no secret, no connect links. */
export function getOAuthStateSecret(): string {
  const s =
    process.env.ACTION_OAUTH_STATE_SECRET?.trim() ||
    process.env.NEXTAUTH_SECRET?.trim();
  if (!s) {
    throw new OAuthStateError(
      "No OAuth state secret configured (ACTION_OAUTH_STATE_SECRET or NEXTAUTH_SECRET). Refusing to mint unsigned connect links.",
    );
  }
  return s;
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

function signPayload(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(`${PURPOSE}.${payloadB64}`).digest("base64url");
}

export function signOAuthState(
  input: { workspaceId: string; appKey: string; userId: string },
  opts?: { secret?: string; ttlMs?: number; nonce?: string },
): string {
  const secret = opts?.secret ?? getOAuthStateSecret();
  const payload: OAuthStatePayload = {
    workspaceId: input.workspaceId,
    appKey: input.appKey,
    userId: input.userId,
    nonce: opts?.nonce ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    exp: Date.now() + (opts?.ttlMs ?? OAUTH_STATE_TTL_MS),
  };
  const body = b64urlEncode(JSON.stringify(payload));
  return `${body}.${signPayload(body, secret)}`;
}

/** Verify a state token. Returns the bound triple, or throws. */
export function verifyOAuthState(
  state: string,
  opts?: { secret?: string; now?: number },
): { workspaceId: string; appKey: string; userId: string } {
  const secret = opts?.secret ?? getOAuthStateSecret();
  const [body, sig] = (state ?? "").split(".");
  if (!body || !sig) throw new OAuthStateError("Malformed OAuth state");
  const expected = signPayload(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new OAuthStateError("OAuth state signature mismatch");
  }
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(b64urlDecode(body)) as OAuthStatePayload;
  } catch {
    throw new OAuthStateError("OAuth state payload is not valid JSON");
  }
  if (!payload.workspaceId || !payload.appKey || !payload.userId || typeof payload.exp !== "number") {
    throw new OAuthStateError("OAuth state payload is incomplete");
  }
  if ((opts?.now ?? Date.now()) > payload.exp) {
    throw new OAuthStateError("OAuth state expired");
  }
  return { workspaceId: payload.workspaceId, appKey: payload.appKey, userId: payload.userId };
}
