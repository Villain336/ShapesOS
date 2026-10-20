// ShapesOS — Phase 18.3: the caller's own sign-in session id (token.sid, the
// user_sessions row behind the JWT — lib/auth/sessions.ts), read from the
// session cookie server-side, never from the request body. Null for a token
// minted before the registry (or a token that isn't the caller's).
// Shared by the Privacy center's session routes (WS=trust) and the Web Push
// subscribe route (WS=flow), which records which session subscribed.

export async function currentSessionId(userId: string): Promise<string | null> {
  const { headers } = await import("next/headers");
  const { readSessionToken } = await import("@/lib/auth/mfa/token");
  const token = await readSessionToken({ headers: await headers() }).catch(() => null);
  if (!token || token.sub !== userId) return null;
  return typeof token.sid === "string" && token.sid ? token.sid : null;
}
