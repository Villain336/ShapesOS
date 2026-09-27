// Marketr — Phase 12 persona seeds (Agency-Agents distillations).
//
// Source of truth for the WORDS: the individual seed modules in this
// directory (each is an ORIGINAL distillation — ideas from
// msitarzewski/agency-agents, MIT, rewritten in Marketr's constitution
// voice; never verbatim text). Provenance is recorded in every module's
// PERSONA_PROVENANCE export and must travel with the persona wherever it
// is registered or displayed.
//
// Wiring map (approved Phase 12 mapping):
//   playbooks → "multi-agent-systems-architect" | "workflow-architect"
//     (see lib/playbooks/store.ts PLAYBOOK_STRATEGIST_PERSONAS)
//   missions  → "studio-producer"
//     (see lib/orchestrator/executors/planner.ts MISSION_PLANNING_PERSONAS)
//   csa       → "business-strategist" | "agents-orchestrator"
//     (see lib/chat/agent.ts CSA_ADVISOR_PERSONAS)
//
// Prompt contract: personaSystemPrompt(id) composes the persona seed
// BEHIND the global hard rules — the same layering contract as
// constitutionSystemPrompt() in ../constitution.ts. The hard rules always
// sit in front; retrieval grounding and the task always sit behind.

import { GLOBAL_HARD_RULES } from "../constitution";
import {
  PERSONA_PROVENANCE as MASA_PROVENANCE,
  MULTI_AGENT_SYSTEMS_ARCHITECT_DESCRIPTION,
  MULTI_AGENT_SYSTEMS_ARCHITECT_PROMPT,
} from "./multi-agent-systems-architect";
import {
  PERSONA_PROVENANCE as WA_PROVENANCE,
  WORKFLOW_ARCHITECT_DESCRIPTION,
  WORKFLOW_ARCHITECT_PROMPT,
} from "./workflow-architect";
import {
  PERSONA_PROVENANCE as SP_PROVENANCE,
  STUDIO_PRODUCER_DESCRIPTION,
  STUDIO_PRODUCER_PROMPT,
} from "./studio-producer";
import {
  PERSONA_PROVENANCE as BS_PROVENANCE,
  BUSINESS_STRATEGIST_DESCRIPTION,
  BUSINESS_STRATEGIST_PROMPT,
} from "./business-strategist";
import {
  PERSONA_PROVENANCE as AO_PROVENANCE,
  AGENTS_ORCHESTRATOR_DESCRIPTION,
  AGENTS_ORCHESTRATOR_PROMPT,
} from "./agents-orchestrator";

export type PersonaId =
  | "multi-agent-systems-architect"
  | "workflow-architect"
  | "studio-producer"
  | "business-strategist"
  | "agents-orchestrator";

/** Which Marketr surface a persona is selectable on. */
export type PersonaSurface = "playbooks" | "missions" | "csa";

export interface PersonaProvenance {
  repo: string;
  license: string;
  sourceFile: string;
  retrieved: string;
}

export interface PersonaSeed {
  id: PersonaId;
  /** Short display name for pickers. */
  name: string;
  /** One-paragraph role description for pickers. */
  description: string;
  provenance: PersonaProvenance;
  /** The original-distillation system-prompt seed (no hard rules — those
   * are prepended by personaSystemPrompt()). */
  systemPrompt: string;
  /** Surfaces this persona is approved as selectable on. */
  surfaces: readonly PersonaSurface[];
}

export const PERSONAS: Record<PersonaId, PersonaSeed> = {
  "multi-agent-systems-architect": {
    id: "multi-agent-systems-architect",
    name: "Multi-Agent Systems Architect",
    description: MULTI_AGENT_SYSTEMS_ARCHITECT_DESCRIPTION,
    provenance: { ...MASA_PROVENANCE },
    systemPrompt: MULTI_AGENT_SYSTEMS_ARCHITECT_PROMPT,
    surfaces: ["playbooks"],
  },
  "workflow-architect": {
    id: "workflow-architect",
    name: "Workflow Architect",
    description: WORKFLOW_ARCHITECT_DESCRIPTION,
    provenance: { ...WA_PROVENANCE },
    systemPrompt: WORKFLOW_ARCHITECT_PROMPT,
    surfaces: ["playbooks"],
  },
  "studio-producer": {
    id: "studio-producer",
    name: "Studio Producer",
    description: STUDIO_PRODUCER_DESCRIPTION,
    provenance: { ...SP_PROVENANCE },
    systemPrompt: STUDIO_PRODUCER_PROMPT,
    surfaces: ["missions"],
  },
  "business-strategist": {
    id: "business-strategist",
    name: "Business Strategist",
    description: BUSINESS_STRATEGIST_DESCRIPTION,
    provenance: { ...BS_PROVENANCE },
    systemPrompt: BUSINESS_STRATEGIST_PROMPT,
    surfaces: ["csa"],
  },
  "agents-orchestrator": {
    id: "agents-orchestrator",
    name: "Agents Orchestrator",
    description: AGENTS_ORCHESTRATOR_DESCRIPTION,
    provenance: { ...AO_PROVENANCE },
    systemPrompt: AGENTS_ORCHESTRATOR_PROMPT,
    surfaces: ["csa"],
  },
};

export const PERSONA_IDS: readonly PersonaId[] = [
  "multi-agent-systems-architect",
  "workflow-architect",
  "studio-producer",
  "business-strategist",
  "agents-orchestrator",
] as const;

/**
 * The selectable persona ids for one surface, in picker order.
 */
export function personasForSurface(surface: PersonaSurface): PersonaId[] {
  return PERSONA_IDS.filter((id) => PERSONAS[id].surfaces.includes(surface));
}

/**
 * The drop-in system prompt for a persona: global hard rules FIRST, then
 * the persona seed. Same layering contract as constitutionSystemPrompt().
 * Retrieval grounding and the task always go after this, never before.
 */
export function personaSystemPrompt(id: PersonaId): string {
  return [GLOBAL_HARD_RULES, PERSONAS[id].systemPrompt].join("\n\n");
}

/**
 * Assert a persona is approved for a surface before selecting it.
 * Throws on mismatch — selection is a code-level decision, so a loud
 * failure beats a silently wrong advisor.
 */
export function assertPersonaForSurface(
  id: PersonaId,
  surface: PersonaSurface,
): PersonaSeed {
  const seed = PERSONAS[id];
  if (!seed.surfaces.includes(surface)) {
    throw new Error(
      `persona "${id}" is not selectable on surface "${surface}" ` +
        `(approved: ${seed.surfaces.join(", ")})`,
    );
  }
  return seed;
}
