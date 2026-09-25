// Marketr — POST /api/media/approvals/:id/otp
// Mint a single-use OTP challenge for high-value approvals.
// The code is returned here in fake/test mode only (delivered out-of-band
// in production — authenticator/SMS). Never logged, never stored in the DB.

import type { NextRequest } from "next/server";
import { mediaGuard, safetyError, requireMediaOwner } from "../../../_lib";
import { otpChallenges } from "@/lib/media/otp";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  const ownerCheck = requireMediaOwner(gate.mediaRole);
  if (ownerCheck) return ownerCheck;
  try {
    const { challengeId, expiresAt } = otpChallenges.mint(10);
    // Fake/test mode: return the code so the harness can complete the flow.
    // Production: deliver via the user's authenticator/SMS channel instead.
    const code = otpChallenges.testPeekCode(challengeId);
    return Response.json({
      challengeId,
      expiresAt: expiresAt.toISOString(),
      ...(code ? { code, testMode: true } : {}),
    });
  } catch (err) {
    return safetyError(err);
  }
}
