// Marketr — MCP metering adapter (Phase C, W5).
//
// The metering track (sibling, W4) owns lib/metering/service and its
// migration. We consume its contract and FAIL CLOSED: if the module cannot
// be imported or meter() rejects/throws, the tool call is rejected and the
// handler never runs. Nothing executes unmetered (T9).

import { randomUUID } from "node:crypto";
import type { McpToolName } from "./scopes";
import { TOOL_CREDIT_PASSTHROUGH } from "./scopes";

export interface MeterOk {
  ok: true;
  charged: number;
  eventId: string;
}

export type MeterDeniedReason = "cap_exceeded" | "unknown_action" | "metering_unavailable";

export type MeterOutcome = MeterOk | { ok: false; reason: MeterDeniedReason; charged: 0 };

interface MeteringService {
  meter(args: {
    workspaceId: string;
    projectId?: string;
    actorId?: string;
    action: string;
    idempotencyKey: string;
    evidenceRef?: string;
    // G3: per-key attribution. Optional — the sibling track owns the field;
    // when absent (older sibling), usage simply isn't key-attributed.
    keyId?: string;
  }): Promise<{ ok: true; charged: number; eventId: string } | { ok: false; reason: string; charged: number }>;
  getUsageSummary(args: {
    workspaceId: string;
    projectId?: string;
    periodStart?: string;
    keyId?: string;
  }): Promise<{
    used: number;
    included: number;
    purchased: number;
    remaining: number;
    byAction: Record<string, number>;
    byProject: Record<string, number>;
    // G3: per-key credit usage, keyed on stable key ID. Optional — degrade
    // gracefully when the sibling hasn't shipped it yet.
    byKey?: Record<string, number>;
    periodStart: string;
  }>;
}

let cached: MeteringService | null | undefined;

// The test override lives on globalThis: under tsx a .mts script and the
// library can load this file as two module instances (ESM and CJS), and a
// module-level override set through one never reached the other — so
// verify-mcp's metering checks silently ran against the real service.
const OVERRIDE = Symbol.for("shapesos.mcp.meteringOverride");
type OverrideHolder = { [OVERRIDE]?: { svc: MeteringService | null } };

/** Test seam (scripts/verify-mcp.mts): override the loader result (undefined clears it). */
export function __setMeteringForTest(svc: MeteringService | null | undefined): void {
  const g = globalThis as OverrideHolder;
  if (svc === undefined) delete g[OVERRIDE];
  else g[OVERRIDE] = { svc };
}

async function loadMetering(): Promise<MeteringService | null> {
  const override = (globalThis as OverrideHolder)[OVERRIDE];
  if (override) return override.svc;
  if (cached !== undefined) return cached;
  try {
    const mod = (await import("@/lib/metering/service")) as Partial<MeteringService>;
    if (typeof mod.meter === "function" && typeof mod.getUsageSummary === "function") {
      cached = mod as MeteringService;
    } else {
      cached = null;
    }
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Meter one MCP tool call BEFORE it executes.
 * action is always "mcp_tool_call"; the underlying action's credits travel in
 * evidenceRef ("mcp:<tool>:<credits>") as the passthrough the credit table
 * documents. Returns ok:false (fail-closed) on any metering problem.
 */
export async function meterToolCall(args: {
  workspaceId: string;
  tool: McpToolName;
  projectId?: string;
  actorId?: string;
  callId?: string;
  // G3: the calling MCP API key's stable ID (undefined for OAuth tokens).
  // Passed through to the sibling's meter() for per-key attribution.
  keyId?: string;
}): Promise<MeterOutcome> {
  const svc = await loadMetering();
  if (!svc) return { ok: false, reason: "metering_unavailable", charged: 0 };
  const passthrough = TOOL_CREDIT_PASSTHROUGH[args.tool];
  try {
    // T17: charge the UNDERLYING action key (serp_analysis, keyword_research,
    // rank_check, ...) — the credit-table cost for that action is the charge.
    // "mcp_tool_call" is only the audit label; it costs zero and must never
    // be the ledger action.
    const res = await svc.meter({
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      actorId: args.actorId,
      action: passthrough.action,
      idempotencyKey: `mcp:${args.callId ?? randomUUID()}`,
      evidenceRef: `mcp:${args.tool}`,
      keyId: args.keyId,
    });
    if (!res.ok) {
      const reason = res.reason === "cap_exceeded" || res.reason === "unknown_action"
        ? res.reason
        : "metering_unavailable";
      return { ok: false, reason, charged: 0 };
    }
    return { ok: true, charged: res.charged, eventId: res.eventId };
  } catch {
    return { ok: false, reason: "metering_unavailable", charged: 0 };
  }
}

/** Read-only usage summary for the get_usage_summary tool. Fail-closed. */
export async function readUsageSummary(args: {
  workspaceId: string;
  projectId?: string;
  periodStart?: string;
  keyId?: string;
}): Promise<
  | { ok: true; summary: Awaited<ReturnType<MeteringService["getUsageSummary"]>> }
  | { ok: false; reason: MeterDeniedReason }
> {
  const svc = await loadMetering();
  if (!svc) return { ok: false, reason: "metering_unavailable" };
  try {
    const summary = await svc.getUsageSummary(args);
    return { ok: true, summary };
  } catch {
    return { ok: false, reason: "metering_unavailable" };
  }
}

/** Test seam: clear the cached module so tests can re-resolve. */
export function resetMeteringCache(): void {
  cached = undefined;
}
