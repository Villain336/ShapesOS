// ShapesOS — Phase 8: tool-group availability, worked out on the server.
//
// lib/agents/grants.ts stays pure: it takes a GroupAvailability. This is the
// server-only helper that fills it in from the sandbox provider (cached in
// sandboxAvailability()), for the composer API and anything else that wants
// to say whether the "code" group can run here.

import type { GroupAvailability } from "@/lib/agents/grants";
import { sandboxAvailability } from "./index";

export async function toolGroupAvailability(): Promise<GroupAvailability & { codeProvider: string | null }> {
  const a = await sandboxAvailability();
  return {
    code: a.ok ? { ok: true } : { ok: false, reason: a.reason },
    codeProvider: a.provider,
  };
}
