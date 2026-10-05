// Marketr — standalone keyword research core (keyword_research action).
//
// One user intent = one charge: this is the ONLY seam that meters
// "keyword_research". It composes the existing provider primitives
// (keywordIdeas — volumes/difficulty/CPC/intent per idea) into one
// clustered report. The lighter keyword_ideas expansion (and its own
// charge) is a separate action and is NOT called from here.
// Used by POST /api/keywords/research and the MCP research_keywords tool.

import { prisma } from "@/lib/prisma";
import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { checkCap, meter } from "@/lib/metering/service";
import { capDeniedMessage, dayBucket, seedHash } from "@/lib/metering/wiring";
import { getSeoProvider, providerStatus } from "@/lib/providers";
import type { KeywordIdea, KeywordIntentLabel } from "@/lib/providers/types";
import { resolveIdeaDifficulties } from "@/lib/intelligence/difficulty/service";
import { ActionError } from "@/lib/serp/analyze";

export interface ResearchKeywordsInput {
  userId: string;
  projectId: string;
  seedKeyword: string;
  /** DataForSEO location code; default 2840 (United States). */
  locationCode?: number;
  /** Max ideas to pull for the expansion; default 50, max 100. */
  limit?: number;
  /** Evidence only, never affects billing. */
  actorId?: string;
}

export interface KeywordResearchReport {
  seed: string;
  /**
   * The seed phrase's own metrics when the provider returned a row for the
   * exact phrase; null otherwise (never invented — see note).
   */
  seedMetrics: {
    volume: number | null;
    difficulty: number | null;
    cpc: number | null;
    intent: KeywordIntentLabel;
  } | null;
  seedMetricsNote: string | null;
  /** Ideas clustered deterministically by intent label. */
  clusters: Record<KeywordIntentLabel, KeywordIdea[]>;
  ideas: KeywordIdea[];
  totalIdeas: number;
  provider: { name: string; isLive: boolean; configured: boolean };
  mock: boolean;
  notes: string[];
}

export interface ResearchKeywordsResult {
  report: KeywordResearchReport;
  charged: number;
  eventId: string;
}

const INTENTS: KeywordIntentLabel[] = [
  "informational",
  "navigational",
  "commercial",
  "transactional",
  "unknown",
];

/** Un-metered core: validation, authz, cap pre-gate, research, clustering. No ledger write. */
export async function researchKeywordsUnmetered(
  input: ResearchKeywordsInput,
): Promise<{
  report: KeywordResearchReport;
  workspaceId: string;
  projectId: string;
}> {
  const seed = input.seedKeyword.trim();
  if (!seed || seed.length > 200) {
    throw new ActionError(
      "validation",
      "seedKeyword is required (1–200 characters).",
      400,
    );
  }
  if (!input.projectId) {
    throw new ActionError("validation", "projectId is required.", 400);
  }
  const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
  const locationCode = input.locationCode ?? 2840;

  // Workspace comes from the authorized project row — never from client input (T10).
  const project = await prisma.project.findFirst({
    where: {
      id: input.projectId,
      workspace: accessibleWorkspaceWhere(input.userId),
    },
    select: { id: true, workspaceId: true },
  });
  if (!project) {
    throw new ActionError(
      "project_not_found",
      "Project not found in this workspace.",
      404,
    );
  }
  if (!(await requireProjectRole(input.userId, project.id, "editor"))) {
    throw new ActionError(
      "forbidden",
      "Editor role required to run keyword research.",
      403,
    );
  }
  const workspaceId = project.workspaceId;

  // Pre-run cap gate: a capped workspace never executes.
  const cap = await checkCap(workspaceId);
  if (!cap.allowed) {
    throw new ActionError(
      "cap_denied",
      capDeniedMessage(cap.used, cap.capCredits),
      402,
    );
  }

  const provider = getSeoProvider();
  let ideas: KeywordIdea[];
  try {
    ideas = await provider.keywordIdeas({ seed, locationCode, limit });
  } catch (err) {
    throw new ActionError(
      "provider_error",
      err instanceof Error ? err.message : "Keyword research failed.",
      502,
    );
  }

  // M5-GATE: the owned difficulty model slots behind the vendor difficulty
  // call site HERE — this is the one seam every keywordIdeas() difficulty
  // value flows through (vendor values originate in
  // lib/providers/dataforseo.ts competitionToDifficulty). While the eval bar
  // is unmet (the normal state), vendor difficulty passes through unchanged:
  // single path, no fork. When a live eval records a PASS for the current
  // model version, the model replaces the vendor value per keyword
  // (resolveIdeaDifficulties marks those rows difficultySource: "model").
  // See lib/intelligence/difficulty/EVAL.md.
  ideas = (await resolveIdeaDifficulties(workspaceId, ideas, "en-US")).ideas;

  const seedRow = ideas.find(
    (i) => i.phrase.trim().toLowerCase() === seed.toLowerCase(),
  );
  const seedMetrics = seedRow
    ? {
        volume: seedRow.volume,
        difficulty: seedRow.difficulty,
        cpc: seedRow.cpc,
        intent: seedRow.intent,
      }
    : null;
  const seedMetricsNote = seedRow
    ? null
    : "The provider did not return a row for the seed phrase itself — seed metrics are null, never estimated.";

  const clusters = {} as Record<KeywordIntentLabel, KeywordIdea[]>;
  for (const intent of INTENTS) clusters[intent] = [];
  for (const idea of ideas) {
    const bucket = INTENTS.includes(idea.intent) ? idea.intent : "unknown";
    clusters[bucket].push(idea);
  }

  const mock = !provider.isLive || ideas.some((i) => i.mock);
  const notes: string[] = [];
  if (mock) {
    notes.push(
      "Mock keyword data for development — connect a live data source for real volumes. Never treat mock rows as real measurements.",
    );
  }

  const report: KeywordResearchReport = {
    seed,
    seedMetrics,
    seedMetricsNote,
    clusters,
    ideas,
    totalIdeas: ideas.length,
    provider: providerStatus(),
    mock,
    notes,
  };

  return { report, workspaceId, projectId: project.id };
}

/**
 * Metered wrapper for the REST route — the ONLY seam that writes a
 * "keyword_research" ledger event. Meter AFTER success; replay (same seed,
 * same UTC day) returns the original charge without a second charge (T13).
 * Cap denial here is the authoritative enforcement (T9) — fail closed.
 */
export async function researchKeywords(
  input: ResearchKeywordsInput,
): Promise<ResearchKeywordsResult> {
  const { report, workspaceId, projectId } =
    await researchKeywordsUnmetered(input);
  const key = `keywordresearch:${seedHash(
    `${workspaceId}|${report.seed.toLowerCase()}|${input.locationCode ?? 2840}|${Math.max(1, Math.min(input.limit ?? 50, 100))}|${dayBucket()}`,
  )}`;
  const res = await meter({
    workspaceId,
    projectId,
    actorId: input.actorId,
    action: "keyword_research",
    idempotencyKey: key,
    evidenceRef: `keyword-research:${report.seed.slice(0, 60)}`,
  });
  if (!res.ok) {
    throw new ActionError("cap_denied", res.message, 402);
  }
  return { report, charged: res.charged, eventId: res.eventId };
}
