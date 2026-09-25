// Marketr — A1 AEO: versioned prompt sets.
// 20–50 money prompts per set, version increments, exactly one active set.
// Pure validation/versioning + a memory store twin for batteries;
// the prisma-backed paths live in the API routes (tables are migrated).

export const AEO_MIN_PROMPTS = 20;
export const AEO_MAX_PROMPTS = 50;

export class PromptSetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptSetValidationError";
  }
}

/** Normalize + validate a prompt set. Throws on count or empty-prompt violations. */
export function validatePrompts(raw: unknown[]): string[] {
  if (!Array.isArray(raw)) throw new PromptSetValidationError("prompts must be an array.");
  const prompts = raw
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (prompts.length < AEO_MIN_PROMPTS) {
    throw new PromptSetValidationError(
      `A prompt set needs at least ${AEO_MIN_PROMPTS} money prompts (got ${prompts.length}). Source them from sales calls and support tickets.`,
    );
  }
  if (prompts.length > AEO_MAX_PROMPTS) {
    throw new PromptSetValidationError(
      `A prompt set caps at ${AEO_MAX_PROMPTS} prompts (got ${prompts.length}). Split into a second version.`,
    );
  }
  const seen = new Set<string>();
  for (const p of prompts) {
    const k = p.toLowerCase();
    if (seen.has(k)) throw new PromptSetValidationError(`Duplicate prompt: "${p.slice(0, 80)}".`);
    seen.add(k);
  }
  return prompts;
}

/** Next version number given the existing versions in the workspace. */
export function nextVersion(existingVersions: number[]): number {
  return existingVersions.length === 0 ? 1 : Math.max(...existingVersions) + 1;
}

// ---------------------------------------------------------------------------
// Memory twin (batteries). Mirrors the AeoPromptSet table shape.
// ---------------------------------------------------------------------------

export interface MemoryPromptSet {
  id: string;
  workspaceId: string;
  version: number;
  prompts: string[];
  createdBy: string;
  active: boolean;
  createdAt: Date;
}

export interface PromptSetStore {
  create(workspaceId: string, prompts: string[], createdBy: string): MemoryPromptSet;
  activate(id: string, workspaceId: string): MemoryPromptSet;
  get(id: string, workspaceId: string): MemoryPromptSet | null;
  getActive(workspaceId: string): MemoryPromptSet | null;
  list(workspaceId: string): MemoryPromptSet[];
}

let idCounter = 0;

export function createMemoryPromptSetStore(): PromptSetStore {
  const sets: MemoryPromptSet[] = [];
  return {
    create(workspaceId, rawPrompts, createdBy) {
      const prompts = validatePrompts(rawPrompts);
      const version = nextVersion(sets.filter((s) => s.workspaceId === workspaceId).map((s) => s.version));
      const set: MemoryPromptSet = {
        id: `aeops_${Date.now().toString(36)}_${(idCounter++).toString(36)}`,
        workspaceId,
        version,
        prompts,
        createdBy,
        active: false,
        createdAt: new Date(),
      };
      sets.push(set);
      return set;
    },
    activate(id, workspaceId) {
      const set = sets.find((s) => s.id === id && s.workspaceId === workspaceId);
      if (!set) throw new PromptSetValidationError("Prompt set not found in workspace.");
      for (const s of sets) if (s.workspaceId === workspaceId) s.active = false;
      set.active = true;
      return set;
    },
    get(id, workspaceId) {
      return sets.find((s) => s.id === id && s.workspaceId === workspaceId) ?? null;
    },
    getActive(workspaceId) {
      return sets.find((s) => s.workspaceId === workspaceId && s.active) ?? null;
    },
    list(workspaceId) {
      return sets
        .filter((s) => s.workspaceId === workspaceId)
        .sort((a, b) => b.version - a.version);
    },
  };
}
