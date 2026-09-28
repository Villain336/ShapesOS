// Marketr — Phase 13B persona profiles: the PersonaProfile read path +
// voice-layered prompt assembly.
//
// PersonaProfile rows are USER OVERRIDES ONLY (one per
// (workspaceId, agentId) — no built-in rows; see voices.ts for the
// defaults). Every read/write here goes through withWorkspaceScope() — the
// persona_profiles table is FORCE RLS, fail-closed (worker 1 battery).

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { GLOBAL_HARD_RULES } from "../constitution";
import { PERSONAS, type PersonaId } from "./index";
import {
  personaVoiceBlock,
  type PersonaVoice,
} from "./voices";

export interface PersonaProfileOverride {
  voice: Partial<PersonaVoice> | null;
  continuityNotes: string | null;
  uncertaintyStyle: string | null;
}

/**
 * Read the user override for (workspaceId, agentId). Returns null when the
 * workspace has no override — the caller then falls back to the built-in
 * default voice from voices.ts.
 */
export async function getPersonaProfileOverride(
  workspaceId: string,
  agentId: PersonaId,
): Promise<PersonaProfileOverride | null> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await tx.personaProfile.findUnique({
      where: { workspaceId_agentId: { workspaceId, agentId } },
      select: { voice: true, continuityNotes: true, uncertaintyStyle: true },
    });
    if (!row) return null;
    return {
      voice: (row.voice as Partial<PersonaVoice>) ?? null,
      continuityNotes: row.continuityNotes,
      uncertaintyStyle: row.uncertaintyStyle,
    };
  });
}

/**
 * Pure composition — the layering contract: hard rules FIRST, then the
 * persona seed, then the voice block (user override when provided,
 * built-in default otherwise). Retrieval grounding and the task always
 * sit after this, never before.
 */
export function assemblePersonaPrompt(
  id: PersonaId,
  override?: PersonaProfileOverride | null,
): string {
  return [
    GLOBAL_HARD_RULES,
    PERSONAS[id].systemPrompt,
    personaVoiceBlock(id, override),
  ].join("\n\n");
}

/**
 * Async variant of personaSystemPrompt(id): same layering contract,
 * with the PersonaProfile voice block layered in — user override when one
 * exists, built-in default otherwise.
 *
 * Keep personaSystemPrompt() (sync, defaults) for non-LLM paths that
 * cannot do a DB read; any live LLM call MUST use this instead.
 */
export async function personaSystemPromptFor(
  id: PersonaId,
  workspaceId: string,
): Promise<string> {
  const override = await getPersonaProfileOverride(workspaceId, id);
  return assemblePersonaPrompt(id, override);
}
