// Marketr — Phase 10 M5: difficulty_estimate persistence.
//
// Versioned artifacts: every estimate is written with its model_version and
// the table's unique (workspaceId, keyword, locale, modelVersion) key.
// Bumping the model NEVER rewrites history — a new model version inserts
// new rows alongside the old ones, so evals can compare versions side by
// side.
//
// All access goes through withWorkspaceScope (difficulty_estimate has FORCE
// RLS with the tenant policy — a session without the GUC sees zero rows).

import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import type { Prisma } from "@prisma/client";
import type { DifficultyOutput } from "./model";

export interface EstimateRow {
  id: string;
  keyword: string;
  locale: string;
  estimate: number;
  uncertaintyBand: [number, number];
  inputsProvenance: DifficultyOutput["inputsProvenance"];
  modelVersion: string;
  evaluatedAt: Date;
}

function toRow(r: {
  id: string;
  keyword: string;
  locale: string;
  estimate: number;
  uncertaintyBand: unknown;
  inputsProvenance: unknown;
  modelVersion: string;
  evaluatedAt: Date;
}): EstimateRow {
  const band = r.uncertaintyBand as [number, number] | null;
  return {
    id: r.id,
    keyword: r.keyword,
    locale: r.locale,
    estimate: r.estimate,
    uncertaintyBand: band ?? [0, 100],
    inputsProvenance: r.inputsProvenance as EstimateRow["inputsProvenance"],
    modelVersion: r.modelVersion,
    evaluatedAt: r.evaluatedAt,
  };
}

/**
 * Upsert one estimate. The composite unique key (workspaceId, keyword,
 * locale, modelVersion) makes re-estimating with the same model version
 * idempotent and guarantees a model bump writes NEW rows, never updates.
 */
export async function upsertEstimate(
  workspaceId: string,
  params: {
    keyword: string;
    locale: string;
    output: DifficultyOutput;
  },
): Promise<EstimateRow> {
  const { keyword, locale, output } = params;
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.difficultyEstimate.upsert({
      where: {
        workspaceId_keyword_locale_modelVersion: {
          workspaceId,
          keyword,
          locale,
          modelVersion: output.modelVersion,
        },
      },
      create: {
        workspaceId,
        keyword,
        locale,
        estimate: output.estimate,
        uncertaintyBand: output.uncertaintyBand,
        inputsProvenance: output.inputsProvenance as unknown as Prisma.InputJsonValue,
        modelVersion: output.modelVersion,
      },
      update: {
        estimate: output.estimate,
        uncertaintyBand: output.uncertaintyBand,
        inputsProvenance: output.inputsProvenance as unknown as Prisma.InputJsonValue,
        evaluatedAt: new Date(),
      },
      select: {
        id: true,
        keyword: true,
        locale: true,
        estimate: true,
        uncertaintyBand: true,
        inputsProvenance: true,
        modelVersion: true,
        evaluatedAt: true,
      },
    }),
  );
  return toRow(row);
}

/** Latest estimates for the workspace, newest first. */
export async function listEstimates(
  workspaceId: string,
  opts: { limit?: number; modelVersion?: string } = {},
): Promise<EstimateRow[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.difficultyEstimate.findMany({
      where: {
        workspaceId,
        ...(opts.modelVersion ? { modelVersion: opts.modelVersion } : {}),
      },
      orderBy: { evaluatedAt: "desc" },
      take: Math.min(opts.limit ?? 100, 500),
      select: {
        id: true,
        keyword: true,
        locale: true,
        estimate: true,
        uncertaintyBand: true,
        inputsProvenance: true,
        modelVersion: true,
        evaluatedAt: true,
      },
    }),
  );
  return rows.map(toRow);
}

/** One keyword's estimate history across model versions (for eval comparison). */
export async function estimateHistory(
  workspaceId: string,
  keyword: string,
  locale: string,
): Promise<EstimateRow[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.difficultyEstimate.findMany({
      where: { workspaceId, keyword, locale },
      orderBy: { evaluatedAt: "desc" },
      select: {
        id: true,
        keyword: true,
        locale: true,
        estimate: true,
        uncertaintyBand: true,
        inputsProvenance: true,
        modelVersion: true,
        evaluatedAt: true,
      },
    }),
  );
  return rows.map(toRow);
}
