"use client";

// ShapesOS — browser side of two-factor + passkeys (Phase 4a). Every call
// that changes the session goes through Auth.js signIn() (redirect: false),
// so the httpOnly session cookie is replaced by the server, never by JS.

import { useSyncExternalStore } from "react";
import { signIn } from "next-auth/react";
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";

export type SignInOutcome = { ok: true } | { ok: false; code: string | null };

function outcome(res: { error?: string | null; code?: string | null } | undefined): SignInOutcome {
  if (!res || res.error) return { ok: false, code: res?.code ?? null };
  return { ok: true };
}

export function passkeysSupported(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

const noSubscribe = () => () => {};

/** Passkey support as render state: false on the server, real value on the client. */
export function usePasskeySupport(): boolean {
  return useSyncExternalStore(noSubscribe, passkeysSupported, () => false);
}

/** The user dismissed the browser prompt (not worth an error message). */
export function isPasskeyCancel(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === "NotAllowedError" || name === "AbortError";
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

/** Second step with a TOTP or recovery code (also used for re-auth). */
export async function verifyCode(code: string): Promise<SignInOutcome> {
  return outcome(await signIn("two-factor", { code, redirect: false }));
}

/** Redeem a single-use enrollment proof: upgrades THIS session. */
export async function redeemProof(proof: string): Promise<SignInOutcome> {
  return outcome(await signIn("two-factor", { proof, redirect: false }));
}

/** Passkey sign-in (usernameless, or the pending user's second step). */
export async function signInWithPasskey(): Promise<SignInOutcome> {
  const { challengeId, options } = await postJson<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>(
    "/api/auth/passkey/options",
  );
  const response = await startAuthentication({ optionsJSON: options });
  return outcome(await signIn("passkey", { challengeId, response: JSON.stringify(response), redirect: false }));
}

/** Re-authenticate the signed-in user with one of their passkeys. */
export async function reauthWithPasskey(): Promise<SignInOutcome> {
  const { challengeId, options } = await postJson<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>(
    "/api/account/security/passkeys/reauth-options",
  );
  const response = await startAuthentication({ optionsJSON: options });
  return outcome(await signIn("passkey", { challengeId, response: JSON.stringify(response), redirect: false }));
}

/** Register a passkey, then upgrade the session with the returned proof. */
export async function registerPasskey(name: string): Promise<void> {
  const { challengeId, options } = await postJson<{ challengeId: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>(
    "/api/account/security/passkeys/options",
  );
  const response = await startRegistration({ optionsJSON: options });
  const { proof } = await postJson<{ proof: string }>("/api/account/security/passkeys", { challengeId, response, name });
  await redeemProof(proof);
}

/** Session state as the login page needs it. */
export async function fetchAuthState(): Promise<{ signedIn: boolean; pending: boolean; methods: string[] }> {
  const res = await fetch("/api/auth/session", { cache: "no-store" });
  const s = (await res.json().catch(() => null)) as { user?: { id?: string }; mfa?: { pending?: boolean; methods?: string[] } } | null;
  return {
    signedIn: !!s?.user?.id,
    pending: !!s?.mfa?.pending,
    methods: Array.isArray(s?.mfa?.methods) ? s!.mfa!.methods! : [],
  };
}
