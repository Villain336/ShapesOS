// Marketr — R1 shared GBP client + approval secret helpers (routes layer).
//
// The fake GBP client is process-scoped (singleton) so ReviewReplyState
// polling state survives across route calls in this process — mirroring how
// Google's moderation queue holds state server-side. Real adapters still
// throw NotConfiguredError without a key (see lib/authority/fake.ts).

import { resolveGbpClient, type GbpClient } from "../fake";

let shared: GbpClient | null = null;

/** Resolve the GBP client for routes. Fake by default (honest not-configured for real). */
export function gbpClientForRoutes(): GbpClient {
  if (!shared) {
    shared = resolveGbpClient({ apiKey: process.env.GBP_API_KEY ?? null });
  }
  return shared;
}

/** Approval receipt secret — mirrors lib/media/safety.ts convention. */
export function approvalSecret(): string {
  const s = (process.env.MARKETR_APPROVAL_SECRET ?? "").trim();
  if (s) return s;
  // Fail closed in production: a hardcoded fallback secret would let anyone
  // forge approval receipts. Dev-only fallback with a loud warning.
  if (process.env.NODE_ENV === "production") {
    throw new Error("MARKETR_APPROVAL_SECRET is not set — refusing to sign approvals with a fallback secret.");
  }
  console.warn("[authority] WARNING: MARKETR_APPROVAL_SECRET unset — using insecure dev fallback. Set it before any production use.");
  return "marketr-approval-dev-secret";
}
