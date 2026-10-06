// ShapesOS — Phase 18.3 (WS=trust): "chain verified" for the hash-chained
// trails, using each trail's OWN verification where it has one:
//
//   media_audit_event      verifyMediaAuditChain (lib/media/audit.ts) — full
//                          recompute over the workspace's chain
//   esign_audit_event      verifyAuditChain (lib/esign/audit.ts) — linkage,
//                          per envelope
//   mission_event          recomputes each event with the writer's own
//                          functions (lib/orchestrator/audit.ts: canonicalize,
//                          sha256Hex, eventHashFor), per mission
//   authority_audit_event  recomputes like the authority memory store's
//                          verifyChain (the Prisma store has none), per workspace
//   flywheel_audit_event   NOT verified here: its stores chain per stream in
//                          different ways (lib/flywheel/*/audit.ts); shown as
//                          "not checked" rather than guessed.
//
// Read-only; bounded (CHAIN_MAX rows per trail). Admin+ (the route checks).

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { canonicalize, eventHashFor, sha256Hex } from "@/lib/authority/approvals";
import type { TimelineSource } from "./normalize";

export const CHAIN_MAX = 10_000;

export interface ChainResult {
  source: TimelineSource;
  /** null = this trail isn't verified here. */
  ok: boolean | null;
  checked: number;
  /** Id of the first entry that doesn't chain. */
  brokenAt?: string;
}

/** Linkage + recompute over one ordered chain. PURE. */
export function verifyLinkedChain<T extends { id: string; prevHash: string; eventHash: string }>(
  rows: readonly T[],
  recompute: (row: T, prev: string) => string,
): { ok: boolean; brokenAt?: string } {
  let prev = "GENESIS";
  for (const r of rows) {
    if (r.prevHash !== prev || recompute(r, prev) !== r.eventHash) return { ok: false, brokenAt: r.id };
    prev = r.eventHash;
  }
  return { ok: true };
}

/** A mission event's hash, exactly as appendMissionEvent writes it. PURE. */
export function missionEventHash(
  r: { missionId: string; actor: string; step: string | null; tool: string | null; args: unknown; observation: unknown; costCents: number; ts: Date },
  prev: string,
): string {
  const payloadHash = sha256Hex(canonicalize({ step: r.step ?? null, tool: r.tool ?? null, args: r.args ?? {}, observation: r.observation ?? {}, costCents: r.costCents ?? 0 }));
  return eventHashFor(prev, r.missionId, r.actor, payloadHash, r.ts);
}

async function missionChains(workspaceId: string): Promise<ChainResult> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.missionEvent.findMany({
      where: { workspaceId },
      orderBy: [{ missionId: "asc" }, { ts: "asc" }, { id: "asc" }],
      take: CHAIN_MAX,
      select: { id: true, missionId: true, actor: true, step: true, tool: true, args: true, observation: true, costCents: true, ts: true, prevHash: true, eventHash: true },
    }),
  );
  const byMission = new Map<string, typeof rows>();
  for (const r of rows) byMission.set(r.missionId, [...(byMission.get(r.missionId) ?? []), r]);
  for (const chain of byMission.values()) {
    const v = verifyLinkedChain(chain, missionEventHash);
    if (!v.ok) return { source: "mission_event", ok: false, checked: rows.length, brokenAt: v.brokenAt };
  }
  return { source: "mission_event", ok: true, checked: rows.length };
}

async function authorityChain(workspaceId: string): Promise<ChainResult> {
  const rows = await prisma.authorityAuditEvent.findMany({
    where: { workspaceId },
    orderBy: [{ ts: "asc" }, { id: "asc" }],
    take: CHAIN_MAX,
    select: { id: true, ts: true, entityId: true, action: true, payloadHash: true, prevHash: true, eventHash: true },
  });
  const v = verifyLinkedChain(rows, (r, prev) => eventHashFor(prev, r.entityId, r.action, r.payloadHash, r.ts));
  return { source: "authority_audit_event", ok: v.ok, checked: rows.length, ...(v.brokenAt ? { brokenAt: v.brokenAt } : {}) };
}

async function mediaChain(workspaceId: string): Promise<ChainResult> {
  const [{ verifyMediaAuditChain }, { SqlMediaAuditStore }] = await Promise.all([import("@/lib/media/audit"), import("@/lib/media/db")]);
  const v = await verifyMediaAuditChain(new SqlMediaAuditStore(), workspaceId);
  return { source: "media_audit_event", ok: v.ok, checked: v.events, ...(v.brokenAt ? { brokenAt: v.brokenAt } : {}) };
}

async function esignChains(workspaceId: string): Promise<ChainResult> {
  const { verifyAuditChain } = await import("@/lib/esign/audit");
  const rows = await prisma.esignAuditEvent.findMany({
    where: { envelope: { workspaceId } },
    orderBy: [{ envelopeId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: CHAIN_MAX,
    select: { id: true, envelopeId: true, hash: true, previousHash: true },
  });
  const byEnvelope = new Map<string, typeof rows>();
  for (const r of rows) byEnvelope.set(r.envelopeId, [...(byEnvelope.get(r.envelopeId) ?? []), r]);
  for (const chain of byEnvelope.values()) {
    if (!verifyAuditChain(chain)) return { source: "esign_audit_event", ok: false, checked: rows.length, brokenAt: chain[0]?.id };
  }
  return { source: "esign_audit_event", ok: true, checked: rows.length };
}

/** Verify every hash-chained trail of the workspace. Never throws per trail. */
export async function verifyChains(workspaceId: string): Promise<ChainResult[]> {
  const runs: Array<[TimelineSource, () => Promise<ChainResult>]> = [
    ["mission_event", () => missionChains(workspaceId)],
    ["media_audit_event", () => mediaChain(workspaceId)],
    ["authority_audit_event", () => authorityChain(workspaceId)],
    ["esign_audit_event", () => esignChains(workspaceId)],
  ];
  const out = await Promise.all(
    runs.map(async ([source, fn]) => {
      try {
        return await fn();
      } catch (err) {
        console.warn(`[audit-timeline] chain check failed for ${source}:`, err instanceof Error ? err.message : err);
        return { source, ok: null, checked: 0 } satisfies ChainResult;
      }
    }),
  );
  out.push({ source: "flywheel_audit_event", ok: null, checked: 0 });
  return out;
}
