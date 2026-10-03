// ShapesOS — Activepieces tenant binding (Phase 1, H6).
//
// The engine is ONE host-wide sidecar: listFlows / triggerFlow / getFlowRun
// see every tenant's flows. Every Marketr surface (REST routes, chat tools,
// MCP tools, mission automations) goes through this gate instead, so a flow
// can only be listed, triggered or polled from the workspace it is bound to,
// and a run is readable only when its flow is bound to the caller's
// workspace. Foreign and unbound ids are indistinguishable ("not found").
//
// Bindings live in automation_flow_bindings (flow_id unique → one owner) and
// are created by platform operators (lib/auth/platform-operator.ts).

import { prisma } from "@/lib/prisma";
import {
  getFlowRun,
  latestFlowRun,
  listFlows,
  triggerFlow,
  type FlowPage,
  type ListFlowsOptions,
} from "./client";
import type { ActivepiecesFlowRun, TriggerFlowResult } from "./types";

export class FlowNotBoundError extends Error {
  readonly status = 404;
  constructor(kind: "flow" | "run", id: string) {
    super(`${kind === "flow" ? "Flow" : "Run"} ${id} not found in this workspace.`);
    this.name = "FlowNotBoundError";
  }
}

export class FlowBindingConflictError extends Error {
  readonly status = 409;
  constructor(flowId: string) {
    super(`Flow ${flowId} is already bound to another workspace.`);
    this.name = "FlowBindingConflictError";
  }
}

export interface FlowBindingStore {
  isBound(workspaceId: string, flowId: string): Promise<boolean>;
  listFlowIds(workspaceId: string): Promise<string[]>;
  /** Owner of a flow, or null when unbound. */
  ownerOf(flowId: string): Promise<string | null>;
  bind(workspaceId: string, flowId: string, boundBy: string): Promise<void>;
  unbind(workspaceId: string, flowId: string): Promise<boolean>;
}

export interface FlowEngine {
  listFlows: typeof listFlows;
  triggerFlow: typeof triggerFlow;
  latestFlowRun: typeof latestFlowRun;
  getFlowRun: typeof getFlowRun;
}

export function prismaFlowBindingStore(): FlowBindingStore {
  return {
    async isBound(workspaceId, flowId) {
      const row = await prisma.automationFlowBinding.findFirst({
        where: { workspaceId, flowId },
        select: { id: true },
      });
      return row !== null;
    },
    async listFlowIds(workspaceId) {
      const rows = await prisma.automationFlowBinding.findMany({
        where: { workspaceId },
        select: { flowId: true },
      });
      return rows.map((r) => r.flowId);
    },
    async ownerOf(flowId) {
      const row = await prisma.automationFlowBinding.findUnique({
        where: { flowId },
        select: { workspaceId: true },
      });
      return row?.workspaceId ?? null;
    },
    async bind(workspaceId, flowId, boundBy) {
      await prisma.automationFlowBinding.create({ data: { workspaceId, flowId, boundBy } });
    },
    async unbind(workspaceId, flowId) {
      const { count } = await prisma.automationFlowBinding.deleteMany({ where: { workspaceId, flowId } });
      return count > 0;
    },
  };
}

const realEngine: FlowEngine = { listFlows, triggerFlow, latestFlowRun, getFlowRun };

export interface FlowGateDeps {
  store?: FlowBindingStore;
  engine?: FlowEngine;
}

/** Workspace-scoped view of the shared engine. */
export function workspaceFlows(workspaceId: string, deps: FlowGateDeps = {}) {
  if (!workspaceId) throw new Error("workspaceId is required");
  const store = deps.store ?? prismaFlowBindingStore();
  const engine = deps.engine ?? realEngine;

  async function assertBound(flowId: string): Promise<void> {
    if (!flowId || !(await store.isBound(workspaceId, flowId))) throw new FlowNotBoundError("flow", flowId);
  }

  return {
    assertBound,

    /** Engine flows filtered to the ones bound to this workspace. */
    async list(opts: ListFlowsOptions = {}): Promise<FlowPage> {
      const page = await engine.listFlows(opts);
      if (!page.configured) return page;
      const bound = new Set(await store.listFlowIds(workspaceId));
      return { ...page, flows: page.flows.filter((f) => bound.has(f.id)) };
    },

    async trigger(flowId: string, payload: Record<string, unknown> = {}): Promise<TriggerFlowResult> {
      await assertBound(flowId);
      return engine.triggerFlow(flowId, payload);
    },

    async latestRun(flowId: string): Promise<ActivepiecesFlowRun | null> {
      await assertBound(flowId);
      return engine.latestFlowRun(flowId);
    },

    /** A run is visible only when its flow is bound to this workspace. */
    async run(runId: string): Promise<ActivepiecesFlowRun> {
      const run = await engine.getFlowRun(runId);
      if (!run.flowId || !(await store.isBound(workspaceId, run.flowId))) {
        throw new FlowNotBoundError("run", runId);
      }
      return run;
    },
  };
}

/** Operator action: bind a flow to a workspace (idempotent for the same owner). */
export async function bindFlowToWorkspace(
  workspaceId: string,
  flowId: string,
  boundBy: string,
  store: FlowBindingStore = prismaFlowBindingStore(),
): Promise<void> {
  const owner = await store.ownerOf(flowId);
  if (owner === workspaceId) return;
  if (owner) throw new FlowBindingConflictError(flowId);
  try {
    await store.bind(workspaceId, flowId, boundBy);
  } catch (e) {
    // Lost a race to another binder (flow_id is unique).
    if ((e as { code?: string }).code === "P2002") throw new FlowBindingConflictError(flowId);
    throw e;
  }
}
