"use client";

import { useSyncExternalStore } from "react";

// ShapesOS — browser side of email sign-in (Phase 6): JSON calls to the
// public /api/auth/email/* routes. Sign-in itself always goes through
// Auth.js signIn() so the httpOnly session cookie is set by the server.

export interface EmailAuthResult {
  ok: boolean;
  status: number;
  message: string;
  code: string | null;
}

export async function postEmailAuth(path: string, body: Record<string, unknown>): Promise<EmailAuthResult> {
  try {
    const res = await fetch(`/api/auth/email/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string; code?: string };
    if (res.status === 429 && !data.code) {
      return { ok: false, status: 429, message: "Too many requests. Wait a minute, then try again.", code: "rate_limited" };
    }
    return {
      ok: res.ok,
      status: res.status,
      message: (res.ok ? data.message : data.error) ?? (res.ok ? "Done." : "Something went wrong. Try again."),
      code: data.code ?? null,
    };
  } catch {
    return { ok: false, status: 0, message: "Couldn't reach the server. Check your connection and try again.", code: null };
  }
}

/**
 * The one-time token from an emailed link. Links carry it in the fragment
 * (#token=…) so it never reaches a server log; ?token=… is accepted too.
 * The fragment is then removed from the address bar and history.
 */
let linkToken: string | null | undefined;

export function readLinkToken(): string | null {
  if (typeof window === "undefined") return null;
  // Read once per page load (React may run effects twice in development, and
  // the first read clears the URL).
  if (linkToken !== undefined) return linkToken;
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
  const fromQuery = new URLSearchParams(window.location.search).get("token");
  const token = fromHash || fromQuery;
  if (token) window.history.replaceState(null, "", window.location.pathname);
  linkToken = token;
  return token;
}

const noSubscribe = () => () => {};

/** The link token as render state: undefined on the server, string | null on the client. */
export function useLinkToken(): string | null | undefined {
  return useSyncExternalStore(noSubscribe, readLinkToken, () => undefined);
}
