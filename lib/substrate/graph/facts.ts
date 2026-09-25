// Marketr — Phase 8 G1: append-only fact log (SPEC-PHASE8.md §4 graph_facts).
//
// Safety invariant §9.4: application code NEVER updates or deletes
// graph_facts. Corrections are new facts; retention archival moves rows to
// cold storage without mutating them. This module exports NO update/delete
// path — the type system is the guardrail.

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { GraphFact } from "@prisma/client";
import { withWorkspaceScope, type TxClient } from "./rls";
import { projectFact } from "./project";
import { auditEvent } from "@/lib/auditlog";
import type { FactPayload } from "./types";

export interface AppendFactInput {
  workspaceId: string;
  /** connector id | "manual" | "import" | "onboarding" */
  source: string;
  sourceRecordId: string;
  /** "customer:email:amy@example.com" — deterministic node key hint */
  entityRef: string;
  factType: string;
  payload: FactPayload;
  observedAt?: Date;
  /** actor for the audit trail (user id, "system", "webhook:hubspot", ...) */
  actor?: string;
  /** skip projection (bulk loads project at the end via projectWorkspace) */
  deferProjection?: boolean;
}

/** Canonical JSON: stable key order so identical payloads hash identically. */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentHashFor(
  input: Pick<AppendFactInput, "source" | "sourceRecordId" | "entityRef" | "factType" | "payload" | "observedAt">,
): string {
  return createHash("sha256")
    .update(
      canonicalize({
        source: input.source,
        sourceRecordId: input.sourceRecordId,
        entityRef: input.entityRef,
        factType: input.factType,
        observedAt: input.observedAt ? input.observedAt.toISOString() : null,
        payload: input.payload,
      }),
    )
    .digest("hex");
}

/**
 * Append a fact to the immutable log, then project it into nodes/edges.
 * Idempotent: re-ingesting the same (source, record, type, hash) returns
 * the existing row without re-projecting. Pass `tx` to join an existing
 * scoped transaction (sync runner); otherwise a scoped transaction is opened.
 */
export async function appendFact(input: AppendFactInput, tx?: TxClient): Promise<GraphFact> {
  const observedAt = input.observedAt ?? new Date();
  const contentHash = contentHashFor({ ...input, observedAt });
  const run = async (t: TxClient) => {
    const existing = await t.graphFact.findFirst({
      where: {
        workspaceId: input.workspaceId,
        source: input.source,
        sourceRecordId: input.sourceRecordId,
        factType: input.factType,
        contentHash,
      },
    });
    if (existing) return existing;

    const fact = await t.graphFact.create({
      data: {
        workspaceId: input.workspaceId,
        source: input.source,
        sourceRecordId: input.sourceRecordId,
        entityRef: input.entityRef,
        factType: input.factType,
        payload: input.payload as object,
        observedAt,
        contentHash,
      },
    });
    if (!input.deferProjection) {
      await projectFact(t, fact);
    }
    await auditEvent({
      projectId: null,
      workspaceId: input.workspaceId,
      action: "graph_fact_appended",
      summary: `graph fact appended: ${input.factType} ← ${input.source}:${input.sourceRecordId}`,
      actor: input.actor === "user" ? "user" : "ai",
      actorUserId: input.actor,
    }).catch(() => {});
    return fact;
  };
  if (tx) return run(tx);
  return withWorkspaceScope(input.workspaceId, run);
}

/** Ordered fact log for an entity — the audit trail / provenance view. */
export async function listFacts(
  workspaceId: string,
  opts: { entityRef?: string; factType?: string; source?: string; limit?: number } = {},
): Promise<GraphFact[]> {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.graphFact.findMany({
      where: {
        workspaceId,
        ...(opts.entityRef ? { entityRef: opts.entityRef } : {}),
        ...(opts.factType ? { factType: opts.factType } : {}),
        ...(opts.source ? { source: opts.source } : {}),
      },
      orderBy: { ingestedAt: "asc" },
      take: opts.limit ?? 200,
    }),
  );
}

export interface ExportedFact {
  source: string;
  sourceRecordId: string;
  entityRef: string;
  factType: string;
  payload: FactPayload;
  observedAt: string;
}

/**
 * Export the workspace's fact log in ingest order. Replay = re-append every
 * exported fact into a fresh workspace: the projection is deterministic, so
 * the rebuilt graph must equal the original (battery proof of the
 * append-only contract).
 */
export async function exportFacts(workspaceId: string): Promise<ExportedFact[]> {
  const facts = await listFacts(workspaceId, { limit: 100_000 });
  return facts.map((f) => ({
    source: f.source,
    sourceRecordId: f.sourceRecordId,
    entityRef: f.entityRef,
    factType: f.factType,
    payload: f.payload as FactPayload,
    observedAt: f.observedAt.toISOString(),
  }));
}

/** Replay an exported log into `targetWorkspaceId`. Returns counts. */
export async function replayFacts(
  targetWorkspaceId: string,
  exported: ExportedFact[],
  actor = "system:replay",
): Promise<{ facts: number; skipped: number }> {
  let facts = 0;
  let skipped = 0;
  for (const e of exported) {
    const before = await withWorkspaceScope(targetWorkspaceId, (tx) =>
      tx.graphFact.count({ where: { workspaceId: targetWorkspaceId } }),
    );
    await appendFact({
      workspaceId: targetWorkspaceId,
      source: e.source,
      sourceRecordId: e.sourceRecordId,
      entityRef: e.entityRef,
      factType: e.factType,
      payload: e.payload,
      observedAt: new Date(e.observedAt),
      actor,
    });
    const after = await withWorkspaceScope(targetWorkspaceId, (tx) =>
      tx.graphFact.count({ where: { workspaceId: targetWorkspaceId } }),
    );
    if (after > before) facts++;
    else skipped++;
  }
  return { facts, skipped };
}
