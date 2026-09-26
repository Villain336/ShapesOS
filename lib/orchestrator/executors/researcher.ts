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

export interface ResearcherInput {
  workspaceId: string;
  missionId?: string | null;
  /** Task-scoped query — the ONLY context the worker sees. */
  query: string;
  topK?: number;
  graphLimit?: number;
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
}

export interface ResearcherResult {
  executor: "researcher";
  summary: string;
  citations: Citation[];
  /** Counts only — the packet itself is not forwarded upstream in full. */
  packetStats: { graphNodes: number; graphEdges: number; memories: number };
  costCents: number;
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

  const topNodes = packet.graph.nodes.slice(0, 5).map((n) => `- ${n.displayName} (${n.entityType}, freshness: ${n.freshness})`);
  const topMemories = packet.memories.slice(0, 5).map((m) => `- ${m.title} [${m.store}, ${m.freshness}]`);
  const summary =
    `Research findings for "${packet.query}": ` +
    `${packet.graph.nodes.length} graph node(s), ${packet.graph.edges.length} edge(s), ${packet.memories.length} memor(ies) recalled.\n` +
    (topNodes.length ? `Top entities:\n${topNodes.join("\n")}\n` : "No matching graph entities.\n") +
    (topMemories.length ? `Recalled memory:\n${topMemories.join("\n")}` : "No recalled memory.") +
    timelineNote;

  return {
    executor: "researcher",
    summary,
    citations: toCitations(packet),
    packetStats: {
      graphNodes: packet.graph.nodes.length,
      graphEdges: packet.graph.edges.length,
      memories: packet.memories.length,
    },
    costCents: estimateCostCents(input.query.length, summary.length),
  };
}
