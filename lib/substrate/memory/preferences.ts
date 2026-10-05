// Marketr — Phase 13B: workspace preference profile helpers.
//
// WorkspacePreference is NOT a table — it is a convention over
// memory_facts (see prisma/schema.prisma Phase 13B block + docs/phases/
// 13b/DATA-MODEL.md): predicate="pref:<key>", subjectNodeId=NULL,
// object={value, pinned?, ...}. Preferences evolve by INVALIDATION
// (supersede chain), never deletion — the semantic store's bi-temporal
// semantics are exactly the preference lifecycle.
//
// The learning-pause toggle ("Settings → Agents → Memory: pause
// learning") is key "learning_paused": object={value: bool, pausedAt}.

import type { Prisma, PrismaClient } from "@prisma/client";
import { withWorkspaceScope } from "./rls";

type TxClient = Prisma.TransactionClient | PrismaClient;

export const PREF_NAMESPACE = "pref:";

export function prefPredicate(key: string): string {
  return `${PREF_NAMESPACE}${key}`;
}

/** Well-known preference keys. Onboarding (worker 7) seeds these. */
export const PREF_KEYS = {
  voiceStyle: "voice_style",
  riskTolerance: "risk_tolerance",
  detailLevel: "detail_level",
  channels: "channels",
  definitionOfGood: "definition_of_good",
  learningPaused: "learning_paused",
} as const;

export interface Preference {
  id: string;
  key: string;
  value: unknown;
  confidence: number;
  pinned: boolean;
  origin: string;
  validAt: Date;
}

function rowToPreference(predicate: string, row: {
  id: string; object: unknown; confidence: number; origin: string; validAt: Date;
}): Preference {
  const obj = (row.object ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    key: predicate.slice(PREF_NAMESPACE.length),
    value: obj.value,
    confidence: row.confidence,
    pinned: obj.pinned === true,
    origin: row.origin,
    validAt: row.validAt,
  };
}

/** Latest active (non-invalidated) preference for key, or null. */
export async function getPreference(
  tx: TxClient,
  workspaceId: string,
  key: string,
): Promise<Preference | null> {
  const row = await tx.memoryFact.findFirst({
    where: {
      workspaceId,
      predicate: prefPredicate(key),
      invalidAt: null,
    },
    orderBy: { validAt: "desc" },
    select: { id: true, object: true, confidence: true, origin: true, validAt: true },
  });
  return row ? rowToPreference(prefPredicate(key), row) : null;
}

export interface SetPreferenceOpts {
  /** 0..1; defaults to 1.0 for user-set, 0.6 for learner-derived. */
  confidence?: number;
  /** Pinned prefs are read-only to the learner (worker 6 must skip). */
  pinned?: boolean;
  /** "user_told" survives decay-to-floor; "agent_inferred" fades. */
  origin?: "user_told" | "agent_inferred" | "imported";
  sourceEpisodeId?: string | null;
  tx?: TxClient;
}

/**
 * Set a preference: invalidates the current active row (supersede
 * chain preserved) and writes the new value. Pinned prefs can only be
 * overwritten by an explicit user action — callers MUST check
 * getPreference().pinned first and refuse learner writes.
 */
export async function setPreference(
  workspaceId: string,
  key: string,
  value: unknown,
  opts: SetPreferenceOpts = {},
): Promise<string> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const now = new Date();
    const predicate = prefPredicate(key);
    const current = await getPreference(tx, workspaceId, key);
    const created = await tx.memoryFact.create({
      data: {
        workspaceId,
        subjectNodeId: null,
        predicate,
        object: { value: JSON.parse(JSON.stringify(value)), pinned: opts.pinned === true },
        confidence: opts.confidence ?? (opts.origin === "agent_inferred" ? 0.6 : 1.0),
        validAt: now,
        sourceEpisodeId: opts.sourceEpisodeId ?? null,
        origin: opts.origin ?? "agent_inferred",
      },
      select: { id: true },
    });
    if (current) {
      await tx.memoryFact.update({
        where: { id: current.id, workspaceId },
        data: { invalidAt: now, expiredAt: now, supersededById: created.id },
      });
    }
    return created.id;
  });
}

/** Pause-learning toggle state. Defaults to false (learning on). */
export async function getLearningPaused(
  tx: TxClient,
  workspaceId: string,
): Promise<boolean> {
  const pref = await getPreference(tx, workspaceId, PREF_KEYS.learningPaused);
  return pref?.value === true;
}

/** Flip the pause-learning toggle. Always origin="user_told" (explicit user action). */
export async function setLearningPaused(
  workspaceId: string,
  paused: boolean,
): Promise<string> {
  return setPreference(workspaceId, PREF_KEYS.learningPaused, paused, {
    confidence: 1.0,
    origin: "user_told",
  });
}

/** All active preferences for a workspace (powers the Memory UI list). */
export async function listPreferences(
  workspaceId: string,
): Promise<Preference[]> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const rows = await tx.memoryFact.findMany({
      where: {
        workspaceId,
        predicate: { startsWith: PREF_NAMESPACE },
        invalidAt: null,
      },
      orderBy: { predicate: "asc" },
      select: { id: true, predicate: true, object: true, confidence: true, origin: true, validAt: true },
    });
    return rows.map((r) => rowToPreference(r.predicate, r));
  });
}

// Convenience: read a single preference outside an existing transaction
// (opens its own workspace scope internally).
export async function getPreferenceScoped(
  workspaceId: string,
  key: string,
): Promise<Preference | null> {
  return withWorkspaceScope(workspaceId, (tx) => getPreference(tx, workspaceId, key));
}
