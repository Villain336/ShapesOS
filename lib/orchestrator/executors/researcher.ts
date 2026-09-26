// Marketr — Phase 9 M2: Researcher executor (SPEC §P9A).
//
// READ-ONLY. Tools: substrate.context, graph.search, audit.read.
// This module imports NO write paths — it cannot write anything, by
// construction. Workers receive CLEAN CONTEXT PACKETS: the entry point
// calls substrate.context({ query }) with a task-scoped query and works
// only from the returned slice, never from full mission history.

import { substrateContext, type SubstrateContext } from "../../substrate/context";
import {
  assertToolAllowed,
  checkKillSwitchesFirst,
  estimateCostCents,
  type Citation,
  type GuardDeps,
} from "./_guard";

/** Frozen allow-list: read tools only. Any write tool name throws. */
export const RESEARCHER_TOOLS = Object.freeze([
  "substrate.context",
  "graph.search",
  "audit.read",
]) as readonly string[];

/**
 * Phase 10 M9: feature flag for expert-corpus retrieval inside the
 * Researcher. Off by default (safe); enable with MARKETR_EXPERT_CORPUS=1
 * or the per-call `expertCorpus` dep override. The corpus is a
 * workspace-agnostic product asset — per-workspace usage is recorded in
 * the mission audit log / ask log (see below), never stored with tenant data.
 */
export function expertCorpusEnabled(): boolean {
  return process.env.MARKETR_EXPERT_CORPUS === "1";
}

export interface ExpertCorpusUsage {
  hits: number;
  sources: string[];
}

export interface ResearcherInput {
  workspaceId: string;
  missionId?: string | null;
  /** Task-scoped query — the ONLY context the worker sees. */
  query: string;
  topK?: number;
  graphLimit?: number;
}

/** Shape of hits returned by the expert corpus (matches ExpertHit). */
export interface ExpertCorpusHit {
  text: string;
  sourceTitle: string;
  author: string;
  license: string;
}

export interface ResearcherDeps extends GuardDeps {
  /** Clean-context-packet provider. Default: the real substrate.context. */
  contextPacket?: (
    workspaceId: string,
    query: string,
    opts?: { topK?: number; graphLimit?: number },
  ) => Promise<SubstrateContext>;
  /** Read-only mission timeline (for audit.read). */
  readMissionEvents?: (
    workspaceId: string,
    missionId: string,
    limit?: number,
  ) => Promise<Array<{ step: string | null; actor: string; tool: string | null }>>;
  /** Override the MARKETR_EXPERT_CORPUS flag for this call. */
  expertCorpus?: boolean;
  /** Injected expert retriever. Default: lazy import of retrieveExpertContext. */
  expertRetriever?: (query: string, opts?: { topK?: number }) => Promise<ExpertCorpusHit[]>;
}

export interface ResearcherResult {
  executor: "researcher";
  summary: string;
  citations: Citation[];
  /** Counts only — the packet itself is not forwarded upstream in full. */
  packetStats: { graphNodes: number; graphEdges: number; memories: number };
  costCents: number;
  /** Per-workspace expert-corpus usage (this workspace's retrieval, logged in audit trails). Null when disabled or empty. */
  expertCorpus: ExpertCorpusUsage | null;
}

function defaultDeps(): Required<Pick<ResearcherDeps, "contextPacket">> {
  return {
    contextPacket: (workspaceId, query, opts) =>
      substrateContext(workspaceId, {
        query,
        topK: opts?.topK,
        graphLimit: opts?.graphLimit,
      }),
  };
}

function toCitations(packet: SubstrateContext, cap = 20): Citation[] {
  const out: Citation[] = [];
  for (const n of packet.graph.nodes) {
    out.push({ type: "graph_node", id: n.id, label: `${n.entityType}: ${n.displayName}` });
    if (out.length >= cap) return out;
  }
  for (const m of packet.memories) {
    out.push({ type: "memory", id: m.refId, label: m.title });
    if (out.length >= cap) return out;
  }
  return out;
}

/**
 * runResearcher — gather facts from the Business Graph + Growth Memory.
 * Kill switches first; then exactly one bounded context packet; the
 * summary (not the packet) returns upstream. Never writes.
 *
 * Phase 10 M9: when the expert-corpus flag is on, additionally retrieves
 * from the workspace-agnostic Expert Corpus (marketing knowledge base)
 * and appends an explicitly labeled "Expert corpus context" section.
 * Retrieved passages are reference material, NOT workspace-owned facts.
 */
export async function runResearcher(
  input: ResearcherInput,
  deps: ResearcherDeps = {},
): Promise<ResearcherResult> {
  await checkKillSwitchesFirst(input, deps);
  assertToolAllowed("researcher", RESEARCHER_TOOLS, "substrate.context");
  if (!input.query?.trim()) throw new Error("researcher: query is required.");

  const contextPacket = deps.contextPacket ?? defaultDeps().contextPacket;
  const packet = await contextPacket(input.workspaceId, input.query.trim(), {
    topK: input.topK,
    graphLimit: input.graphLimit,
  });

  // Optional read-only timeline context (audit.read) — never writes.
  let timelineNote = "";
  if (input.missionId && deps.readMissionEvents) {
    assertToolAllowed("researcher", RESEARCHER_TOOLS, "audit.read");
    const events = await deps.readMissionEvents(input.workspaceId, input.missionId, 10);
    timelineNote = `\nRecent mission activity: ${events.length} event(s) in the timeline.`;
  }

  // Expert corpus (read-only; never imported at module load so the
  // heavy embedder only loads when the flag is on).
  const expertOn = deps.expertCorpus ?? expertCorpusEnabled();
  let expertHits: ExpertCorpusHit[] = [];
  let expertNote = "";
  let expertCitations: Citation[] = [];
  let expertUsage: ExpertCorpusUsage | null = null;
  if (expertOn) {
    try {
      const retriever =
        deps.expertRetriever ??
        (await import("../../intelligence/corpus/index")).retrieveExpertContext;
      expertHits = await retriever(input.query.trim(), { topK: 3 });
    } catch (err) {
      expertNote = `\nExpert corpus context: unavailable (${err instanceof Error ? err.message : "retrieval error"}).`;
    }
    if (expertHits.length > 0) {
      const sources = [...new Set(expertHits.map((h) => h.sourceTitle))];
      expertUsage = { hits: expertHits.length, sources };
      expertCitations = expertHits.map((h) => ({
        type: "expert_corpus",
        id: h.sourceTitle,
        label: `${h.sourceTitle} — ${h.author} (${h.license})`,
      }));
      const passages = expertHits
        .map(
          (h, i) =>
            `[${i + 1}] ${h.sourceTitle} — ${h.author} (${h.license})\n${h.text.slice(0, 400)}${h.text.length > 400 ? "…" : ""}`,
        )
        .join("\n\n");
      expertNote =
        `\n\nExpert corpus context (workspace-agnostic reference material — not workspace-owned facts; ` +
        `workspace "${input.workspaceId}" retrieved ${expertHits.length} passage(s) from ${sources.length} source(s)): ` +
        `${sources.join("; ")}.\n${passages}`;
    } else if (!expertNote) {
      expertNote = "\nExpert corpus context: no relevant passages found.";
    }
  }

  const topNodes = packet.graph.nodes.slice(0, 5).map((n) => `- ${n.displayName} (${n.entityType}, freshness: ${n.freshness})`);
  const topMemories = packet.memories.slice(0, 5).map((m) => `- ${m.title} [${m.store}, ${m.freshness}]`);
  const summary =
    `Research findings for "${packet.query}": ` +
    `${packet.graph.nodes.length} graph node(s), ${packet.graph.edges.length} edge(s), ${packet.memories.length} memor(ies) recalled.\n` +
    (topNodes.length ? `Top entities:\n${topNodes.join("\n")}\n` : "No matching graph entities.\n") +
    (topMemories.length ? `Recalled memory:\n${topMemories.join("\n")}` : "No recalled memory.") +
    timelineNote +
    expertNote;

  return {
    executor: "researcher",
    summary,
    citations: [...toCitations(packet), ...expertCitations],
    packetStats: {
      graphNodes: packet.graph.nodes.length,
      graphEdges: packet.graph.edges.length,
      memories: packet.memories.length,
    },
    costCents: estimateCostCents(input.query.length, summary.length),
    expertCorpus: expertUsage,
  };
}
