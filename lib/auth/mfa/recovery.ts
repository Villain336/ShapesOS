// ShapesOS — one-time recovery codes for the second factor (Phase 4a).
//
// Ten codes, each 80 bits from the CSPRNG, shown to the user once as
// "xxxx-xxxx-xxxx-xxxx" (lower-case base32, no ambiguous padding). Only a
// SHA-256 of the normalized code is stored: at 80 bits of entropy an offline
// guess of a leaked hash is infeasible, so a slow KDF buys nothing and a
// direct indexed lookup by hash stays cheap. Each code works once (the store
// consumes it atomically: UPDATE … WHERE used_at IS NULL).

import { createHash, randomBytes } from "node:crypto";
import { base32Encode } from "./totp";

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 10; // 80 bits → 16 base32 chars

/** Lower-case, strip separators/whitespace. */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, "");
}

/** 16 base32 characters once normalized. */
export function looksLikeRecoveryCode(code: string): boolean {
  return /^[a-z2-7]{16}$/.test(normalizeRecoveryCode(code));
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(`shapesos-recovery:${normalizeRecoveryCode(code)}`, "utf8").digest("hex");
}

function formatCode(raw: string): string {
  return raw.match(/.{1,4}/g)!.join("-");
}

/** Fresh codes, formatted for display. Hash each with hashRecoveryCode before storing. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    codes.add(formatCode(base32Encode(randomBytes(RECOVERY_CODE_BYTES)).toLowerCase()));
  }
  return [...codes];
}
