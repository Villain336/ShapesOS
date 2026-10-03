// Marketr — Growth Memory write path (Phase 8 G3).
//
// Write discipline (the 2026 field-guide rules, SPEC-PHASE8.md §2 G3):
//   - selective writes: decisions, corrections, gotchas + their WHY.
//     Not the derivable, trivial, or duplicate.
//   - every write carries provenance (source episode / actor / timestamps).
//   - contradictions resolve by INVALIDATION (invalid_at/expired_at +
//     superseded_by_id), never deletion. memory_episodes are immutable:
//     application code never UPDATEs or DELETEs them.
//   - secret-shaped values are scrubbed BEFORE persistence (spec §9.9).
//   - every write is tenant-scoped via withWorkspaceScope (FORCE RLS,
//     fail-closed) and embedded with the local model for hybrid recall.

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "./rls";

type TxClient = Prisma.TransactionClient;
import { scrubSecrets, scrubJson } from "./scrub";
import { embedText, toVectorLiteral } from "./embed";
import type {
  EpisodeInput,
  FactInput,
  LearningInput,
  MemoryEpisodeType,
  MemoryLearningResult,
  MemoryLearningSource,
} from "./types";
import { NotFoundError } from "@/lib/api/errors";

/** Selectivity gate: refuse writes that are trivially derivable/empty. */
export function assertWriteWorthy(kind: string, text: string): void {
  const t = text.trim();
  if (t.length < 12) {
    throw new Error(
      `Memory write rejected (${kind}): below the selectivity floor — record decisions, corrections, gotchas + why, not fragments.`,
    );
  }
}

async function setEmbedding(
  tx: { $executeRawUnsafe: (q: string, ...p: unknown[]) => Promise<unknown> },
  table: "memory_episodes" | "memory_facts" | "memory_learnings",
  id: string,
  text: string,
): Promise<void> {
  const vec = await embedText(text);
  await tx.$executeRawUnsafe(
    `UPDATE "${table}" SET "embedding" = $1::vector WHERE "id" = $2`,
    toVectorLiteral(vec),
    id,
  );
}

/** Record an episode (immutable — no update/delete path exists by design). */
export async function recordEpisode(
  workspaceId: string,
  input: EpisodeInput,
): Promise<{ id: string; redactions: number }> {
  assertWriteWorthy("episode", input.summary);
  const scrubbed = scrubSecrets(input.summary);
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await tx.memoryEpisode.create({
      data: {
        workspaceId,
        episodeType: input.episodeType as MemoryEpisodeType,
        actor: input.actor.slice(0, 120),
        summary: scrubbed.text,
        refs: (scrubJson(input.refs ?? {}).value ?? {}) as object,
        startedAt: input.startedAt ?? new Date(),
        endedAt: input.endedAt ?? null,
      },
      select: { id: true },
    });
    await setEmbedding(tx, "memory_episodes", row.id, `${input.actor} ${scrubbed.text}`);
    return { id: row.id, redactions: scrubbed.redactions };
  });
}

/** Distill a semantic fact (bi-temporal). */
export async function recordFact(
  workspaceId: string,
  input: FactInput,
  opts: { tx?: TxClient } = {},
): Promise<{ id: string; redactions: number }> {
  assertWriteWorthy("fact", input.predicate);
  const obj = scrubJson(input.object ?? {});
  const write = async (tx: TxClient) => {
    const row = await tx.memoryFact.create({
      data: {
        workspaceId,
        subjectNodeId: input.subjectNodeId ?? null,
        predicate: input.predicate.slice(0, 240),
        object: (obj.value ?? {}) as object,
        confidence: input.confidence ?? 1.0,
        validAt: input.validAt ?? new Date(),
        sourceEpisodeId: input.sourceEpisodeId ?? null,
        origin: input.origin ?? "agent_inferred",
      },
      select: { id: true },
    });
    await setEmbedding(
      tx,
      "memory_facts",
      row.id,
      `${input.predicate} ${JSON.stringify(obj.value)}`,
    );
    return { id: row.id, redactions: obj.redactions };
  };
  if (opts.tx) return write(opts.tx);
  return withWorkspaceScope(workspaceId, write);
}

/**
 * Supersede a fact: the old row is INVALIDATED (invalid_at/expired_at set),
 * the new row points back via superseded_by_id. Both eras stay queryable
 * (the contradiction proof in the battery exercises this).
 */
export async function supersedeFact(
  workspaceId: string,
  oldFactId: string,
  replacement: FactInput,
): Promise<{ oldId: string; newId: string }> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const old = await tx.memoryFact.findFirst({ where: { id: oldFactId, workspaceId } });
    if (!old || old.workspaceId !== workspaceId) throw new Error("Fact not found in workspace.");
    if (old.invalidAt) throw new Error("Fact is already superseded.");
    const now = new Date();
    const created = await tx.memoryFact.create({
      data: {
        workspaceId,
        subjectNodeId: replacement.subjectNodeId ?? old.subjectNodeId,
        predicate: replacement.predicate.slice(0, 240),
        object: ((scrubJson(replacement.object ?? {}).value ?? {}) as object),
        confidence: replacement.confidence ?? 1.0,
        validAt: replacement.validAt ?? now,
        sourceEpisodeId: replacement.sourceEpisodeId ?? null,
        origin: replacement.origin ?? old.origin,
      },
      select: { id: true },
    });
    await tx.memoryFact.update({
      where: { id: oldFactId, workspaceId },
      data: { invalidAt: now, expiredAt: now, supersededById: created.id },
    });
    await setEmbedding(
      tx,
      "memory_facts",
      created.id,
      `${replacement.predicate} ${JSON.stringify(replacement.object)}`,
    );
    return { oldId: oldFactId, newId: created.id };
  });
}

/** Record a procedural learning (the F3 sink schema made real). */
export async function recordLearning(
  workspaceId: string,
  input: LearningInput,
): Promise<{ id: string; redactions: number }> {
  assertWriteWorthy("learning.hypothesis", input.hypothesis);
  assertWriteWorthy("learning.action", input.action);
  const h = scrubSecrets(input.hypothesis);
  const a = scrubSecrets(input.action);
  const md = scrubJson(input.metricDelta ?? {});
  const cr = scrubJson(input.contextRefs ?? {});
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await tx.memoryLearning.create({
      data: {
        workspaceId,
        hypothesis: h.text,
        action: a.text,
        result: input.result as MemoryLearningResult,
        metricDelta: (md.value ?? {}) as object,
        observedAt: input.observedAt ?? new Date(),
        contextRefs: (cr.value ?? {}) as object,
        source: input.source as MemoryLearningSource,
        sourceEpisodeId: input.sourceEpisodeId ?? null,
      },
      select: { id: true },
    });
    await setEmbedding(tx, "memory_learnings", row.id, `${h.text} ${a.text}`);
    return { id: row.id, redactions: h.redactions + a.redactions + md.redactions + cr.redactions };
  });
}

/**
 * Invalidate a learning (correction path) — sets invalidated_at, never
 * deletes. The invalidated row stays recallable for its era via as_of.
 */
export async function invalidateLearning(
  workspaceId: string,
  learningId: string,
  reason: string,
): Promise<void> {
  assertWriteWorthy("invalidation.reason", reason);
  const scrubbed = scrubSecrets(reason);
  await withWorkspaceScope(workspaceId, async (tx) => {
    const row = await tx.memoryLearning.findFirst({ where: { id: learningId, workspaceId } });
    if (!row || row.workspaceId !== workspaceId) throw new Error("Learning not found in workspace.");
    await tx.memoryLearning.update({
      where: { id: learningId, workspaceId },
      data: {
        invalidatedAt: new Date(),
        contextRefs: {
          ...((row.contextRefs as Record<string, unknown>) ?? {}),
          invalidationReason: scrubbed.text,
        },
      },
    });
  });
}

/**
 * Human acceptance of an agent-inferred learning (memory-poisoning guard):
 * stamps contextRefs.acceptedAt/acceptedBy so prompt-feeding recall
 * (RecallOptions.acceptedOnly) starts including it. Idempotent.
 */
export async function acceptLearning(
  workspaceId: string,
  learningId: string,
  userId: string,
): Promise<{ acceptedAt: string }> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await tx.memoryLearning.findFirst({ where: { id: learningId, workspaceId } });
    if (!row) throw new NotFoundError("Learning not found in workspace.");
    const refs = (row.contextRefs as Record<string, unknown>) ?? {};
    if (typeof refs.acceptedAt === "string") return { acceptedAt: refs.acceptedAt };
    const acceptedAt = new Date().toISOString();
    await tx.memoryLearning.update({
      where: { id: learningId, workspaceId },
      data: { contextRefs: { ...refs, acceptedAt, acceptedBy: userId } },
    });
    return { acceptedAt };
  });
}

/** Episodes have no update path — this exists only to fail loudly if called. */
export function updateEpisode(): never {
  throw new Error(
    "memory_episodes are immutable (spec §9.4): corrections are new episodes, never edits.",
  );
}

export async function getEpisode(workspaceId: string, id: string) {
  return withWorkspaceScope(workspaceId, async (tx) =>
    tx.memoryEpisode.findFirst({ where: { id, workspaceId } }),
  );
}

export async function listEpisodes(
  workspaceId: string,
  opts: { type?: MemoryEpisodeType; limit?: number; offset?: number } = {},
) {
  return withWorkspaceScope(workspaceId, async (tx) =>
    tx.memoryEpisode.findMany({
      where: { workspaceId, ...(opts.type ? { episodeType: opts.type } : {}) },
      orderBy: { startedAt: "desc" },
      take: Math.min(opts.limit ?? 50, 200),
      skip: opts.offset ?? 0,
    }),
  );
}

// Re-export prisma for callers that need a scoped transaction client.
export { prisma };
