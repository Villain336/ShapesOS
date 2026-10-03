// Marketr — Phase 10 M2: GSC delta port.
//
// Codes to M1's contract WITHOUT hard-depending on M1's implementation:
//   import { computeDeltas } from "@/lib/intelligence/gsc"
//   computeDeltas(workspaceId, projectId, pre: {start,end}, post: {start,end})
//     : Promise<PageQueryDelta[]>
//
// M1 is being built in parallel; the port resolves computeDeltas by dynamic
// import and degrades to an explicit UNAVAILABLE state when it isn't there
// yet — the cron then records the event as correlation-pending instead of
// writing fake impacts. Also exposes GSC-connected projects (M1's
// "google-search-console" connector binding, ProjectDataSource).

import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import type { DateWindow, PageQueryDelta } from "./types";

export type ComputeDeltasFn = (
  workspaceId: string,
  projectId: string,
  pre: DateWindow,
  post: DateWindow,
) => Promise<PageQueryDelta[]>;

export interface GscPort {
  /** "live" when M1's computeDeltas resolved; "unavailable" otherwise. */
  status: "live" | "unavailable";
  reason: string | null;
  computeDeltas: ComputeDeltasFn;
}

let cached: GscPort | null = null;

/** Resolve M1's delta engine by dynamic import. Cached per process. */
export async function resolveGscPort(): Promise<GscPort> {
  if (cached) return cached;
  try {
    // tsx/next resolve this to lib/intelligence/gsc/index.ts when M1 lands it.
    const mod = (await import("@/lib/intelligence/gsc")) as {
      computeDeltas?: ComputeDeltasFn;
    };
    if (typeof mod.computeDeltas === "function") {
      cached = { status: "live", reason: null, computeDeltas: mod.computeDeltas };
      return cached;
    }
    cached = {
      status: "unavailable",
      reason: "@/lib/intelligence/gsc does not export computeDeltas yet (M1 in progress)",
      computeDeltas: async () => [],
    };
  } catch (err) {
    cached = {
      status: "unavailable",
      reason: `@/lib/intelligence/gsc not importable yet (M1 in progress): ${err instanceof Error ? err.message : String(err)}`,
      computeDeltas: async () => [],
    };
  }
  return cached;
}

/** Test hook: inject a fake port (unit tests never touch the network/DB). */
export function __setGscPortForTests(port: GscPort | null): void {
  cached = port;
}

export interface GscProject {
  projectId: string;
  domain: string;
  property: string | null;
}

/**
 * Projects in this workspace bound to a live google-search-console connector
 * (M1's binding model: ProjectDataSource.connectorKey = "google-search-console").
 */
export async function listGscProjects(workspaceId: string): Promise<GscProject[]> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const bindings = await tx.projectDataSource.findMany({
      where: {
        connectorKey: "google-search-console",
        connection: { workspaceId, status: "active" },
      },
      include: { project: { select: { id: true, domain: true } } },
    });
    return bindings.map((b) => ({
      projectId: b.project.id,
      domain: b.project.domain,
      property:
        (b.projectConfig as { property?: string } | null)?.property ?? null,
    }));
  });
}

/** All workspace projects (fallback when no GSC bindings exist yet). */
export async function listWorkspaceProjects(workspaceId: string): Promise<GscProject[]> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const projects = await tx.project.findMany({
      where: { workspaceId },
      select: { id: true, domain: true },
      orderBy: { createdAt: "asc" },
    });
    return projects.map((p) => ({ projectId: p.id, domain: p.domain, property: null }));
  });
}
