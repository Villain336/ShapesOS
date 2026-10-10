// ShapesOS — Phase 21A (WS=agentweb): per-workspace settings of the agent web layer.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { Prisma } from "@prisma/client";

export const ANSWER_CAP_MIN = 1;
export const ANSWER_CAP_MAX = 500;
export const DEFAULT_ANSWER_CAP_CREDITS = 25;
export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 365;

export interface AgentwebConfig {
  providerOrder: string[];
  captureRetentionDays: number;
  answerCapCredits: number;
}

export const DEFAULT_CONFIG: AgentwebConfig = { providerOrder: [], captureRetentionDays: 30, answerCapCredits: DEFAULT_ANSWER_CAP_CREDITS };

export async function getConfig(workspaceId: string): Promise<AgentwebConfig> {
  const row = await withWorkspaceScope(workspaceId, (tx) => (tx as Prisma.TransactionClient).agentwebSettings.findUnique({ where: { workspaceId } }));
  return row ? { providerOrder: row.providerOrder, captureRetentionDays: row.captureRetentionDays, answerCapCredits: row.answerCapCredits } : { ...DEFAULT_CONFIG };
}

export class SettingsError extends Error {}

/** Validate and store settings. `knownProviders` are the ids the engine can run. */
export async function saveConfig(workspaceId: string, input: Partial<AgentwebConfig>, knownProviders: readonly string[]): Promise<AgentwebConfig> {
  const next = { ...(await getConfig(workspaceId)), ...input };
  if (!Number.isInteger(next.answerCapCredits) || next.answerCapCredits < ANSWER_CAP_MIN || next.answerCapCredits > ANSWER_CAP_MAX) {
    throw new SettingsError(`The per-answer credit cap must be a whole number from ${ANSWER_CAP_MIN} to ${ANSWER_CAP_MAX}.`);
  }
  if (!Number.isInteger(next.captureRetentionDays) || next.captureRetentionDays < RETENTION_MIN_DAYS || next.captureRetentionDays > RETENTION_MAX_DAYS) {
    throw new SettingsError(`Capture retention must be a whole number of days from ${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS}.`);
  }
  const order = [...new Set(next.providerOrder)];
  const unknown = order.filter((p) => !knownProviders.includes(p));
  if (unknown.length) throw new SettingsError(`Unknown search provider: ${unknown.join(", ")}.`);
  await withWorkspaceScope(workspaceId, (tx) =>
    (tx as Prisma.TransactionClient).agentwebSettings.upsert({
      where: { workspaceId },
      create: { workspaceId, providerOrder: order, captureRetentionDays: next.captureRetentionDays, answerCapCredits: next.answerCapCredits },
      update: { providerOrder: order, captureRetentionDays: next.captureRetentionDays, answerCapCredits: next.answerCapCredits },
    }),
  );
  return { ...next, providerOrder: order };
}
