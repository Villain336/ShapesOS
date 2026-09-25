// Marketr — Phase 5 SAFETY: shared OTP challenge store instance.
//
// Module-level singleton shared by the OTP-mint and approve routes.
// TEST/FAKE posture: in-memory. PRODUCTION NOTE: persist challenges in the
// DB or a short-lived KV store — a process restart must not resurrect or
// lose pending challenges silently.

import { OtpChallengeStore } from "./safety";

export const otpChallenges = new OtpChallengeStore();
