// ShapesOS — Phase 10 (finance): shared route plumbing for /api/ops/*
// finance routes — the same guard and error mapping as the generic
// /api/ops/[entity] route (viewer reads, editor writes, admin settings).

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { errorResponse } from "@/lib/api/errors";
import { OpsError, OpsGateError, type OpsActor } from "../doctype";
import { MoneyError } from "./money";
import type { GatedResult } from "./gated";

export type FinanceRole = "viewer" | "editor" | "admin";

export async function financeGuard(min: FinanceRole): Promise<OpsActor | Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (min !== "viewer" && !(await requireWorkspaceRole(user.id, workspace.id, min))) {
    return Response.json({ error: `Forbidden: ${min} role required` }, { status: 403 });
  }
  return { userId: user.id, workspaceId: workspace.id };
}

export function financeError(err: unknown): Response {
  if (err instanceof OpsError) return Response.json({ error: err.message }, { status: err.status });
  if (err instanceof MoneyError) return Response.json({ error: err.message }, { status: 400 });
  if (err instanceof OpsGateError) return Response.json({ error: err.message, code: err.code }, { status: 422 });
  return errorResponse(err);
}

export async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    const v = text.trim() ? (JSON.parse(text) as unknown) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 202 approval_required, or 200 with the result under `key`. */
export function gatedResponse<T>(r: GatedResult<T>, key: string): Response {
  if (r.outcome === "approval_required") {
    return Response.json({ approval_required: true, approval: r.approval }, { status: 202 });
  }
  return Response.json({ [key]: r.result });
}

export function optString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
