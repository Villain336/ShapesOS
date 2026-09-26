// Marketr — Phase 10 M3: versioned prompt panels.
//
// Extends Phase 6's AEO versioned-prompt pattern (lib/authority/aeo/prompts.ts):
// frozen real buyer prompts, fixed cadence, N-repeat runs on money prompts,
// prompts never swapped weekly — a panel version is immutable once created.
// Phase 6 used 20–50 prompts per set; M3 panels are tighter (12–25) because
// every prompt costs N engine reps.
//
// Storage: the migrated `geo_prompt_panel` table (prisma GeoPromptPanel).
// All access goes through withWorkspaceScope (RLS fail-closed).

import { withWorkspaceScope, type TxClient } from "@/lib/substrate/graph/rls";
import { auditEvent } from "@/lib/auditlog";
import type { FileChangeAction } from "@prisma/client";

/** M3 panel bounds: 12–25 frozen real buyer prompts per panel. */
export const GEO_PANEL_MIN_PROMPTS = 12;
export const GEO_PANEL_MAX_PROMPTS = 25;

export class GeoPanelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeoPanelValidationError";
  }
}

/** The four official-API engines the M3 runner can probe. */
export const GEO_ENGINES = ["openai", "anthropic", "gemini", "perplexity"] as const;
export type GeoEngine = (typeof GEO_ENGINES)[number];

/** Env var holding the BYO API key for each engine. */
export const GEO_ENGINE_KEY_ENV: Record<GeoEngine, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GOOGLE_AI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};

/** Nano-class probe model per engine (the $1–5/mo/brand economics). */
export const GEO_ENGINE_MODELS: Record<GeoEngine, string> = {
  openai: "gpt-5-nano",
  anthropic: "claude-haiku-4-5",
  gemini: "gemini-2.5-flash",
  perplexity: "sonar",
};

/**
 * Normalize + validate a frozen prompt panel. Throws on count, empty-prompt,
 * or duplicate violations. Mirrors Phase 6's validatePrompts with M3 bounds.
 */
export function validatePanelPrompts(raw: unknown[]): string[] {
  if (!Array.isArray(raw))
    throw new GeoPanelValidationError("prompts must be an array.");
  const prompts = raw
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (prompts.length < GEO_PANEL_MIN_PROMPTS) {
    throw new GeoPanelValidationError(
      `A prompt panel needs at least ${GEO_PANEL_MIN_PROMPTS} frozen buyer prompts (got ${prompts.length}). Source them from sales calls and support tickets.`,
    );
  }
  if (prompts.length > GEO_PANEL_MAX_PROMPTS) {
    throw new GeoPanelValidationError(
      `A prompt panel caps at ${GEO_PANEL_MAX_PROMPTS} prompts (got ${prompts.length}). Split into a second panel version.`,
    );
  }
  const seen = new Set<string>();
  for (const p of prompts) {
    const k = p.toLowerCase();
    if (seen.has(k))
      throw new GeoPanelValidationError(`Duplicate prompt: "${p.slice(0, 80)}".`);
    seen.add(k);
  }
  return prompts;
}

/** Next panel version for (workspace, engine) given existing versions. */
export function nextPanelVersion(existingVersions: number[]): number {
  return existingVersions.length === 0 ? 1 : Math.max(...existingVersions) + 1;
}

export interface CreatePanelInput {
  engine: GeoEngine;
  prompts: unknown[];
  cadence?: string;
  nReps?: number;
  createdBy?: string;
}

export interface GeoPanel {
  id: string;
  workspaceId: string;
  engine: GeoEngine;
  promptSetVersion: number;
  prompts: string[];
  cadence: string;
  nReps: number;
  createdAt: Date;
}

function toGeoPanel(row: {
  id: string;
  workspaceId: string;
  engine: string;
  promptSetVersion: number;
  prompts: unknown;
  cadence: string;
  nReps: number;
  createdAt: Date;
}): GeoPanel {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    engine: row.engine as GeoEngine,
    promptSetVersion: row.promptSetVersion,
    prompts: Array.isArray(row.prompts) ? (row.prompts as string[]) : [],
    cadence: row.cadence,
    nReps: row.nReps,
    createdAt: row.createdAt,
  };
}

/**
 * Create a new frozen panel version. Panels are immutable once created —
 * to change prompts, create a new version (never edit in place, never swap
 * weekly). Emits an audit event.
 */
export async function createPanel(
  workspaceId: string,
  input: CreatePanelInput,
): Promise<GeoPanel> {
  const prompts = validatePanelPrompts(input.prompts);
  if (!GEO_ENGINES.includes(input.engine)) {
    throw new GeoPanelValidationError(
      `Unknown engine "${input.engine}". One of: ${GEO_ENGINES.join(", ")}.`,
    );
  }
  const nReps = input.nReps ?? 3;
  if (!Number.isInteger(nReps) || nReps < 1 || nReps > 10) {
    throw new GeoPanelValidationError("nReps must be an integer 1–10.");
  }
  const panel = await withWorkspaceScope(workspaceId, async (tx: TxClient) => {
    const existing = await tx.geoPromptPanel.findMany({
      where: { workspaceId, engine: input.engine },
      select: { promptSetVersion: true },
    });
    const version = nextPanelVersion(existing.map((e) => e.promptSetVersion));
    const row = await tx.geoPromptPanel.create({
      data: {
        workspaceId,
        engine: input.engine,
        promptSetVersion: version,
        prompts,
        cadence: input.cadence ?? "weekly",
        nReps,
      },
    });
    return toGeoPanel(row);
  });
  await auditEvent({
    projectId: null,
    workspaceId,
    action: "created" as FileChangeAction, // house pattern (lib/intelligence/difficulty/*); new enum value needs a migration
    summary: `GEO panel v${panel.promptSetVersion} created for ${panel.engine} (${prompts.length} prompts, ${nReps} reps)`,
    actor: "user",
    actorUserId: input.createdBy,
  });
  return panel;
}

/** All panel versions for an engine, newest first. */
export async function listPanels(
  workspaceId: string,
  engine?: GeoEngine,
): Promise<GeoPanel[]> {
  return withWorkspaceScope(workspaceId, async (tx: TxClient) => {
    const rows = await tx.geoPromptPanel.findMany({
      where: { workspaceId, ...(engine ? { engine } : {}) },
      orderBy: [{ engine: "asc" }, { promptSetVersion: "desc" }],
    });
    return rows.map(toGeoPanel);
  });
}

/** The active panel per engine = the latest version. Never "the edited one". */
export async function getActivePanels(
  workspaceId: string,
): Promise<GeoPanel[]> {
  const all = await listPanels(workspaceId);
  const latest = new Map<GeoEngine, GeoPanel>();
  for (const p of all) {
    if (!latest.has(p.engine)) latest.set(p.engine, p);
  }
  return [...latest.values()];
}

export async function getPanel(
  workspaceId: string,
  panelId: string,
): Promise<GeoPanel | null> {
  return withWorkspaceScope(workspaceId, async (tx: TxClient) => {
    const row = await tx.geoPromptPanel.findFirst({
      where: { workspaceId, id: panelId },
    });
    return row ? toGeoPanel(row) : null;
  });
}
