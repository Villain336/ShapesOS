// ShapesOS — Phase 18.3 (WS=trust): memory controls — see and forget what
// agents remember.
//
// Over the EXISTING memory stores (no copy): MemoryEpisode, MemoryFact,
// MemoryLearning (lib/substrate/memory, FORCE RLS) and CompanyKnowledge.
//   - Admins: everything in the workspace, per store.
//   - A person: what came from their own work — episodes whose actor is
//     them or whose refs.userId is them (lib/agents/learning/capture.ts
//     records it), and facts / lessons / knowledge distilled from those
//     episodes.
// Forgetting DELETES the row inside the workspace's RLS scope. The embedding
// (pgvector) and the full-text vector live IN the row, so recall can never
// return it again (lib/substrate/memory/recall.ts reads only these tables);
// rows that cite a forgotten episode keep existing with the citation cleared
// (onDelete: SetNull). Every forget writes an audit row that names the kind
// and id — never the forgotten text.

import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { auditEvent } from "@/lib/auditlog";
import { NotFoundError, BadRequestError } from "@/lib/api/errors";

export const MEMORY_STORES = ["episode", "fact", "learning", "knowledge"] as const;
export type MemoryStore = (typeof MEMORY_STORES)[number];

export function isMemoryStore(v: unknown): v is MemoryStore {
  return typeof v === "string" && (MEMORY_STORES as readonly string[]).includes(v);
}

export interface MemoryItem {
  id: string;
  store: MemoryStore;
  title: string;
  detail: string | null;
  at: string;
  /** Who / what it came from (agent id, origin, source). */
  from: string | null;
}

type Tx = Prisma.TransactionClient;

function clip(s: unknown, n = 240): string | null {
  if (typeof s !== "string") return s == null ? null : clip(JSON.stringify(s), n);
  const t = s.replace(/\s+/g, " ").trim();
  return t ? (t.length > n ? `${t.slice(0, n - 1)}…` : t) : null;
}

/** Episodes that belong to this person (actor, or refs.userId). */
function personEpisodes(userId: string): Prisma.MemoryEpisodeWhereInput {
  return { OR: [{ actor: userId }, { refs: { path: ["userId"], equals: userId } }] };
}

export interface MemoryQuery {
  workspaceId: string;
  store: MemoryStore;
  /** Only memories from this person's own work. */
  forUserId?: string | null;
  before?: Date | null;
  limit?: number;
}

export async function listMemory(q: MemoryQuery): Promise<MemoryItem[]> {
  const take = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const ws = q.workspaceId;
  const mine = q.forUserId ? personEpisodes(q.forUserId) : null;
  return withWorkspaceScope(ws, async (tx: Tx) => {
    switch (q.store) {
      case "episode": {
        const rows = await tx.memoryEpisode.findMany({
          where: { workspaceId: ws, ...(mine ?? {}), ...(q.before ? { startedAt: { lt: q.before } } : {}) },
          orderBy: [{ startedAt: "desc" }, { id: "desc" }],
          take,
          select: { id: true, summary: true, actor: true, episodeType: true, startedAt: true },
        });
        return rows.map((r) => ({ id: r.id, store: "episode" as const, title: clip(r.summary, 160) ?? "—", detail: String(r.episodeType).replace(/_/g, " "), at: r.startedAt.toISOString(), from: r.actor }));
      }
      case "fact": {
        const rows = await tx.memoryFact.findMany({
          where: { workspaceId: ws, ...(mine ? { sourceEpisode: mine } : {}), ...(q.before ? { createdAt: { lt: q.before } } : {}) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take,
          select: { id: true, predicate: true, object: true, origin: true, createdAt: true },
        });
        return rows.map((r) => ({ id: r.id, store: "fact" as const, title: `${r.predicate.replace(/_/g, " ")}: ${clip(r.object, 140) ?? ""}`, detail: null, at: r.createdAt.toISOString(), from: r.origin.replace(/_/g, " ") }));
      }
      case "learning": {
        const rows = await tx.memoryLearning.findMany({
          where: { workspaceId: ws, ...(mine ? { sourceEpisode: mine } : {}), ...(q.before ? { observedAt: { lt: q.before } } : {}) },
          orderBy: [{ observedAt: "desc" }, { id: "desc" }],
          take,
          select: { id: true, hypothesis: true, action: true, result: true, source: true, observedAt: true },
        });
        return rows.map((r) => ({ id: r.id, store: "learning" as const, title: clip(r.hypothesis, 160) ?? "—", detail: clip(`${r.action} → ${String(r.result)}`, 200), at: r.observedAt.toISOString(), from: String(r.source).replace(/_/g, " ") }));
      }
      case "knowledge": {
        const rows = await tx.companyKnowledge.findMany({
          where: { workspaceId: ws, ...(mine ? { sourceEpisode: mine } : {}), ...(q.before ? { createdAt: { lt: q.before } } : {}) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take,
          select: { id: true, title: true, kind: true, body: true, createdAt: true },
        });
        return rows.map((r) => ({ id: r.id, store: "knowledge" as const, title: r.title, detail: clip(r.body, 200), at: r.createdAt.toISOString(), from: String(r.kind).replace(/_/g, " ") }));
      }
    }
  });
}

/**
 * Forget one memory (real delete, under RLS). With `forUserId`, only a
 * memory from that person's own work can be forgotten (a member can't
 * delete the workspace's shared memory; admins use the workspace view).
 */
export async function forgetMemory(input: {
  workspaceId: string;
  store: MemoryStore;
  id: string;
  actorUserId: string;
  forUserId?: string | null;
}): Promise<void> {
  if (!isMemoryStore(input.store)) throw new BadRequestError("Unknown memory kind.");
  const ws = input.workspaceId;
  const mine = input.forUserId ? personEpisodes(input.forUserId) : null;
  const deleted = await withWorkspaceScope(ws, async (tx: Tx) => {
    switch (input.store) {
      case "episode":
        return (await tx.memoryEpisode.deleteMany({ where: { id: input.id, workspaceId: ws, ...(mine ?? {}) } })).count;
      case "fact":
        return (await tx.memoryFact.deleteMany({ where: { id: input.id, workspaceId: ws, ...(mine ? { sourceEpisode: mine } : {}) } })).count;
      case "learning":
        return (await tx.memoryLearning.deleteMany({ where: { id: input.id, workspaceId: ws, ...(mine ? { sourceEpisode: mine } : {}) } })).count;
      case "knowledge":
        return (await tx.companyKnowledge.deleteMany({ where: { id: input.id, workspaceId: ws, ...(mine ? { sourceEpisode: mine } : {}) } })).count;
    }
  });
  if (!deleted) throw new NotFoundError("That memory isn't there (it may already be forgotten).");
  await auditEvent({
    projectId: null,
    workspaceId: ws,
    action: "memory_forgotten",
    actorUserId: input.actorUserId,
    summary: `Forgot a ${input.store === "knowledge" ? "company knowledge entry" : input.store} (${input.id})${input.forUserId ? " from their own work" : ""}`,
  });
}
