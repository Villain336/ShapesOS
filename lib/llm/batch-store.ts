// ShapesOS — Phase 17 (A4, WS=model): the prisma BatchStore (llm_batch_jobs,
// FORCE RLS — every query runs under the row's own tenant GUC).

import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { BatchRequestItem, BatchResults, BatchRow, BatchStatus, BatchStore } from "./batch";

type Db = {
  id: string;
  workspaceId: string;
  purpose: string;
  idempotencyKey: string;
  status: string;
  workload: string;
  provider: string | null;
  model: string | null;
  providerBatchId: string | null;
  requests: unknown;
  results: unknown;
  context: unknown;
  polls: number;
  lastError: string | null;
  updatedAt: Date;
};

function toRow(r: Db): BatchRow {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    purpose: r.purpose,
    idempotencyKey: r.idempotencyKey,
    status: r.status as BatchStatus,
    workload: r.workload,
    provider: r.provider,
    model: r.model,
    providerBatchId: r.providerBatchId,
    requests: (r.requests ?? []) as BatchRequestItem[],
    results: (r.results ?? null) as BatchResults | null,
    context: (r.context ?? null) as Record<string, unknown> | null,
    polls: r.polls,
    lastError: r.lastError,
    updatedAt: r.updatedAt,
  };
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

export const prismaBatchStore: BatchStore = {
  async upsert(input) {
    return withWorkspaceScope(input.workspaceId, async (tx) => {
      const existing = await tx.llmBatchJob.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
      });
      if (existing) return { row: toRow(existing), created: false };
      try {
        const row = await tx.llmBatchJob.create({
          data: {
            workspaceId: input.workspaceId,
            purpose: input.purpose,
            idempotencyKey: input.idempotencyKey,
            workload: input.workload,
            requests: json(input.requests),
            ...(input.context ? { context: json(input.context) } : {}),
          },
        });
        return { row: toRow(row), created: true };
      } catch (err) {
        // A concurrent submit of the same key won the unique index.
        const again = await tx.llmBatchJob.findUnique({
          where: { workspaceId_idempotencyKey: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } },
        });
        if (again) return { row: toRow(again), created: false };
        throw err;
      }
    });
  },
  async get(workspaceId, id) {
    const r = await withWorkspaceScope(workspaceId, (tx) => tx.llmBatchJob.findFirst({ where: { id, workspaceId } }));
    return r ? toRow(r) : null;
  },
  async update(workspaceId, id, patch) {
    const data: Prisma.LlmBatchJobUpdateManyMutationInput = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.provider !== undefined) data.provider = patch.provider;
    if (patch.model !== undefined) data.model = patch.model;
    if (patch.providerBatchId !== undefined) data.providerBatchId = patch.providerBatchId;
    if (patch.results !== undefined) data.results = json(patch.results);
    if (patch.polls !== undefined) data.polls = patch.polls;
    if (patch.lastError !== undefined) data.lastError = patch.lastError;
    if (patch.submittedAt) data.submittedAt = patch.submittedAt;
    if (patch.endedAt) data.endedAt = patch.endedAt;
    if (patch.deliveredAt) data.deliveredAt = patch.deliveredAt;
    await withWorkspaceScope(workspaceId, (tx) => tx.llmBatchJob.updateMany({ where: { id, workspaceId }, data }));
  },
  async transition(workspaceId, id, from, to, olderThan) {
    const res = await withWorkspaceScope(workspaceId, (tx) =>
      tx.llmBatchJob.updateMany({
        where: {
          id,
          workspaceId,
          OR: [
            { status: { in: from.filter((s) => s !== "delivering") } },
            ...(from.includes("delivering") && olderThan ? [{ status: "delivering", updatedAt: { lt: olderThan } }] : []),
          ],
        },
        data: { status: to },
      }),
    );
    return res.count === 1;
  },
};
