// ShapesOS — Auth.js credentials providers for the second step (Phase 4a).
//
//   "two-factor"  finishes a PENDING sign-in (or refreshes a full session's
//                 second-factor time for re-auth) with a TOTP code, a
//                 recovery code, or an enrollment proof. The subject comes
//                 from the caller's own session cookie — never from the form.
//   "passkey"     signs in with a WebAuthn assertion (usernameless), or
//                 completes a pending sign-in, or re-authenticates.
//
// Rate limiting reuses the login lockout (lib/auth/rate-limit.ts): failures
// count per IP and per "2fa:<user>" / "passkey:<credential>" account key, so
// 5 wrong codes for one user lock that user's second step with the same
// capped backoff as the password login.

import { CredentialsSignin, type User } from "next-auth";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { prisma } from "@/lib/prisma";
import { clientIpFromHeaders } from "@/lib/api/client-ip";
import { loginLockedOutAsync, recordLoginFailureAsync, recordLoginSuccessAsync } from "@/lib/auth/rate-limit";
import { readSessionToken } from "./token";
import { fullSubject, pendingSubject, type AuthMethod, type SecondFactorMethod } from "./session-token";
import { verifySecondFactorCode } from "./store";
import { redeemMfaProof } from "./challenge";
import { verifyPasskeyAuthentication } from "./webauthn";

/** Locked out by the shared login limiter. */
export class SecondFactorLockedError extends CredentialsSignin {
  code = "locked";
}

/** What authorize() attaches to the user for the jwt callback. */
export interface MfaSignInMarker {
  secondFactor: SecondFactorMethod;
  firstFactor?: AuthMethod;
}

export type MfaUser = User & { mfa: MfaSignInMarker };

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function auditFailure(summary: string): Promise<void> {
  await prisma.fileChangeLog
    .create({
      data: { projectId: null, workspaceId: null, filePath: "(auth)", actor: "system", action: "auth_login_failed", summary },
    })
    .catch((err: unknown) => console.error("[auth] audit write failed:", err));
}

export async function authorizeTwoFactor(
  credentials: Partial<Record<string, unknown>>,
  request: Request,
): Promise<MfaUser | null> {
  const token = await readSessionToken(request);
  const now = nowSec();
  const subject = pendingSubject(token, now) ?? fullSubject(token);
  if (!subject || !token) return null;
  const ip = clientIpFromHeaders(request.headers);
  const key = `2fa:${subject}`;
  if (await loginLockedOutAsync(ip, key)) throw new SecondFactorLockedError();

  const code = typeof credentials?.code === "string" ? credentials.code.slice(0, 64) : "";
  const proof = typeof credentials?.proof === "string" ? credentials.proof.slice(0, 200) : "";
  let method: SecondFactorMethod | null = null;
  if (proof) method = await redeemMfaProof(subject, proof);
  else if (code) method = await verifySecondFactorCode(subject, code);

  if (!method) {
    await recordLoginFailureAsync(ip, key);
    await auditFailure(`second-factor check failed for ${String(token.email ?? subject)} from ${ip ?? "unknown ip"}`);
    return null;
  }
  await recordLoginSuccessAsync(ip, key);
  const first = Array.isArray(token.amr) ? (token.amr[0] as AuthMethod | undefined) : undefined;
  return {
    id: subject,
    name: typeof token.name === "string" ? token.name : null,
    email: typeof token.email === "string" ? token.email : null,
    image: typeof token.picture === "string" ? token.picture : null,
    mfa: { secondFactor: method, firstFactor: first === "otp" || first === "recovery" || first === "passkey" ? undefined : first },
  };
}

export async function authorizePasskey(
  credentials: Partial<Record<string, unknown>>,
  request: Request,
): Promise<MfaUser | null> {
  const ip = clientIpFromHeaders(request.headers);
  const challengeId = typeof credentials?.challengeId === "string" ? credentials.challengeId.slice(0, 64) : "";
  const raw = typeof credentials?.response === "string" ? credentials.response : "";
  if (!challengeId || !raw || raw.length > 16_384) return null;
  let response: AuthenticationResponseJSON;
  try {
    response = JSON.parse(raw) as AuthenticationResponseJSON;
  } catch {
    return null;
  }
  const credId = typeof response?.id === "string" ? response.id.slice(0, 512) : "unknown";
  const key = `passkey:${credId}`;
  if (await loginLockedOutAsync(ip, key)) throw new SecondFactorLockedError();
  const verified = await verifyPasskeyAuthentication({ challengeId, response });
  if (!verified) {
    await recordLoginFailureAsync(ip, key);
    await auditFailure(`passkey sign-in failed from ${ip ?? "unknown ip"}`);
    return null;
  }
  await recordLoginSuccessAsync(ip, key);
  await prisma.fileChangeLog
    .create({
      data: {
        projectId: null,
        workspaceId: null,
        filePath: "(auth)",
        actor: "system",
        action: "auth_login_succeeded",
        summary: `passkey sign-in for ${verified.email ?? verified.userId} from ${ip ?? "unknown ip"}`,
      },
    })
    .catch(() => {});
  return {
    id: verified.userId,
    email: verified.email,
    name: verified.userName,
    mfa: { secondFactor: "passkey" },
  };
}
