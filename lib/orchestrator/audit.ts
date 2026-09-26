// Marketr — Phase 9 M1: orchestrator audit helpers (SPEC-PHASE9.md §3.6).
//
// Two append-only writers. Both set the app.workspace_id tenant GUC per
// transaction (same contract as lib/substrate/graph/rls.ts) — sessions
// without the GUC see ZERO rows (fail-closed RLS).

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { canonicalize, eventHashFor, sha256Hex } from "@/lib/authority/approvals";

/** Prisma transaction client type (same shape as lib/substrate/graph/rls.ts). */
type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Run fn in a transaction with the tenant GUC pinned via SET LOCAL. */
async function withTenantScope<T>(workspaceId: string, fn: (tx: TxClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Parameterized — never interpolate the workspace id into SQL.
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    return fn(tx);
  });
}

export interface MissionEventInput {
  missionId: string;
  workspaceId: string;
  actor: string;
  step?: string;
  tool?: string;
  args?: Record<string, unknown>;
  observation?: Record<string, unknown>;
  costCents?: number;
}

export interface AppendedMissionEvent {
  id: string;
  eventHash: string;
  prevHash: string;
}

/**
 * appendMissionEvent — hash-chained mission timeline write.
 * prevHash = previous eventHash for this mission ("GENESIS" for the first).
 */
export async function appendMissionEvent(input: MissionEventInput): Promise<AppendedMissionEvent> {
  const { missionId, workspaceId, actor } = input;
  if (!missionId || !workspaceId || !actor) {
    throw new Error("appendMissionEvent: missionId, workspaceId, and actor are required.");
  }
  return withTenantScope(workspaceId, async (tx) => {
    const last = await tx.missionEvent.findFirst({
      where: { missionId, workspaceId },
      orderBy: { ts: "desc" },
      select: { eventHash: true },
    });
    const prevHash = last?.eventHash ?? "GENESIS";
    const ts = new Date();
    const payloadHash = sha256Hex(
      canonicalize({
        step: input.step ?? null,
        tool: input.tool ?? null,
        args: (input.args ?? {}) as Prisma.InputJsonObject,
        observation: (input.observation ?? {}) as Prisma.InputJsonObject,
        costCents: input.costCents ?? 0,
      }),
    );
    const eventHash = eventHashFor(prevHash, missionId, actor, payloadHash, ts);
    const row = await tx.missionEvent.create({
      data: {
        missionId,
        workspaceId,
        ts,
        actor,
        step: input.step ?? null,
        tool: input.tool ?? null,
        args: (input.args ?? {}) as Prisma.InputJsonObject,
        observation: (input.observation ?? {}) as Prisma.InputJsonObject,
        costCents: input.costCents ?? 0,
        eventHash,
        prevHash,
      },
      select: { id: true },
    });
    return { id: row.id, eventHash, prevHash };
  });
}

export type CommandKindName = "template" | "ask" | "go" | "do";

export interface LogCommandInput {
  workspaceId: string;
  userId: string;
  kind: CommandKindName;
  /** For kind=template: the template id that was rendered. */
  templateId?: string;
  /** Free-form prompt text. Stored in FULL only for kind=ask; otherwise only its hash. */
  prompt?: string;
  resultSummary?: string;
}

/**
 * logCommand — command_audit writer (SPEC §P9B).
 * Templated actions log {template_id, prompt_hash}; free-form asks log the
 * FULL prompt. prompt_full is NEVER written for template/go/do kinds —
 * storing full prompts there would silently widen the audit surface.
 */
export async function logCommand(input: LogCommandInput): Promise<{ id: string }> {
  const { workspaceId, userId, kind } = input;
  if (!workspaceId || !userId || !kind) {
    throw new Error("logCommand: workspaceId, userId, and kind are required.");
  }
  const isAsk = kind === "ask";
  const promptHash = input.prompt ? sha256Hex(input.prompt) : null;
  const promptFull = isAsk ? (input.prompt ?? null) : null;
  return withTenantScope(workspaceId, async (tx) => {
    const row = await tx.commandAudit.create({
      data: {
        workspaceId,
        userId,
        kind: kind === "do" ? "doAction" : kind,
        templateId: input.templateId ?? null,
        promptHash,
        promptFull,
        resultSummary: input.resultSummary ?? null,
      },
      select: { id: true },
    });
    return { id: row.id };
  });
}
