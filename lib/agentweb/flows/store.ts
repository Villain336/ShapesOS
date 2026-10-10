// ShapesOS — Phase 21A round 2 (WS=agentweb): taught flows at rest (agentweb_flows, FORCE RLS).
//
// A flow is made from a finished or live session's recorded steps (spec.ts), starts as a DRAFT and
// is only ever run once a person has published it with a click (the route requires a same-origin
// ui_click). Typed text is never in a recording (the tools record only a step's locator), so there
// is nothing secret to store; a sensitive parameter is a label only.

import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { buildFlow, validateFlow, FlowError, type FlowSpec } from "./spec";

type Tx = Prisma.TransactionClient;

export type FlowStatus = "draft" | "published";

export interface FlowView {
  id: string;
  name: string;
  status: FlowStatus;
  origin: string;
  steps: number;
  params: Array<{ key: string; label: string; sensitive: boolean }>;
  truncated: string | null;
  sourceRunId: string | null;
  createdBy: string;
  publishedBy: string | null;
  publishedAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  createdAt: string;
}

type Row = {
  id: string;
  name: string;
  status: string;
  spec: unknown;
  sourceRunId: string | null;
  createdBy: string;
  publishedBy: string | null;
  publishedAt: Date | null;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  createdAt: Date;
};

function viewOf(r: Row): FlowView {
  const spec = r.spec as FlowSpec;
  return {
    id: r.id,
    name: r.name,
    status: r.status === "published" ? "published" : "draft",
    origin: spec.origin,
    steps: spec.steps.length,
    params: spec.params,
    truncated: spec.truncated ?? null,
    sourceRunId: r.sourceRunId,
    createdBy: r.createdBy,
    publishedBy: r.publishedBy,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    lastRunStatus: r.lastRunStatus,
    createdAt: r.createdAt.toISOString(),
  };
}

export class FlowStoreError extends Error {
  constructor(
    readonly code: "not_found" | "bad_state" | "nothing_to_teach",
    message: string,
  ) {
    super(message);
    this.name = "FlowStoreError";
  }
}

/** Teach once: the steps recorded on a run become a draft flow. */
export async function createFlowFromRun(workspaceId: string, userId: string, runId: string, name?: string): Promise<FlowView> {
  const events = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentRunEvent.findMany({ where: { workspaceId, runId, type: "browser" }, orderBy: { seq: "asc" }, take: 1000, select: { type: true, payload: true } }));
  if (events.length === 0) throw new FlowStoreError("not_found", "That session was not found, or it has no browsing steps.");
  let spec: FlowSpec;
  try {
    spec = buildFlow(events, { name: name?.trim() || "Web flow" });
    if (!name?.trim()) spec = { ...spec, name: `Flow on ${new URL(spec.origin).hostname}` };
  } catch (e) {
    if (e instanceof FlowError) throw new FlowStoreError("nothing_to_teach", e.message);
    throw e;
  }
  const id = `flow_${randomBytes(9).toString("hex")}`;
  const row = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebFlow.create({ data: { id, workspaceId, name: spec.name, sourceRunId: runId, spec: spec as unknown as Prisma.InputJsonValue, createdBy: userId } }));
  return viewOf(row);
}

export async function listFlows(workspaceId: string, limit = 100): Promise<FlowView[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebFlow.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: Math.min(limit, 200) }));
  return rows.map(viewOf);
}

export async function getFlow(workspaceId: string, id: string): Promise<(FlowView & { spec: FlowSpec }) | null> {
  const row = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebFlow.findFirst({ where: { id, workspaceId } }));
  if (!row) return null;
  return { ...viewOf(row), spec: validateFlow(row.spec) };
}

/** Publishing is a person's decision (the route demands a click); a flow that is not valid cannot be published. */
export async function publishFlow(workspaceId: string, id: string, userId: string): Promise<FlowView> {
  const f = await getFlow(workspaceId, id);
  if (!f) throw new FlowStoreError("not_found", "That flow was not found.");
  if (f.status === "published") return f;
  const row = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebFlow.update({ where: { id }, data: { status: "published", publishedBy: userId, publishedAt: new Date() } }));
  return viewOf(row);
}

/** Back to a draft: it can no longer be run until published again. */
export async function unpublishFlow(workspaceId: string, id: string): Promise<FlowView> {
  const f = await getFlow(workspaceId, id);
  if (!f) throw new FlowStoreError("not_found", "That flow was not found.");
  const row = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebFlow.update({ where: { id }, data: { status: "draft", publishedBy: null, publishedAt: null } }));
  return viewOf(row);
}

export async function renameFlow(workspaceId: string, id: string, name: string): Promise<FlowView> {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!clean) throw new FlowStoreError("bad_state", "A flow needs a name.");
  const f = await getFlow(workspaceId, id);
  if (!f) throw new FlowStoreError("not_found", "That flow was not found.");
  const spec: FlowSpec = { ...f.spec, name: clean };
  const row = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebFlow.update({ where: { id }, data: { name: clean, spec: spec as unknown as Prisma.InputJsonValue } }));
  return viewOf(row);
}

export async function recordFlowRun(workspaceId: string, id: string, status: "done" | "stopped"): Promise<void> {
  await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebFlow.updateMany({ where: { id, workspaceId }, data: { lastRunAt: new Date(), lastRunStatus: status } }));
}
