// Marketr — GET/PUT /api/automation/settings (Phase 9 M6, SPEC-PHASE9.md §P9E).
//
// GET  → { settings, defaults, thresholdCents }
//   settings: the workspace's automation_setting rows (workspace × action)
//   defaults: code defaults (per-action default behavior + Tier-1 kinds)
//   thresholdCents: effective workspace default small-action threshold
// PUT  → { action, behavior, thresholdCents? } upsert.
//   Rejects behavior=auto for Tier 3 kinds with 400 (un-overridable).

import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import {
  DEFAULT_SMALL_ACTION_THRESHOLD_CENTS,
  KNOWN_ACTIONS,
  TIER1_KINDS,
  WORKSPACE_DEFAULT_ACTION,
  listAutomationRows,
  resolveAutomationFromRows,
  validateBehaviorForAction,
} from "@/lib/automation/policy";
import { automationGuard, badRequest, readJson } from "../_lib";

export const dynamic = "force-dynamic";

function defaultsPayload() {
  return {
    behaviors: Object.fromEntries(
      KNOWN_ACTIONS.map((a) => [a.action, a.tier === 3 ? "never" : "ask"]),
    ),
    tier1Kinds: [...TIER1_KINDS],
    thresholdCents: DEFAULT_SMALL_ACTION_THRESHOLD_CENTS,
    knownActions: KNOWN_ACTIONS,
  };
}

export async function GET() {
  const access = await automationGuard("viewer");
  if (access instanceof Response) return access;

  const rows = await listAutomationRows(access.workspaceId);
  const thresholdCents = resolveAutomationFromRows(rows, WORKSPACE_DEFAULT_ACTION).thresholdCents;

  return Response.json({
    settings: rows.map((r) => ({
      action: r.action,
      behavior: r.behavior,
      thresholdCents: r.thresholdCents,
    })),
    defaults: defaultsPayload(),
    thresholdCents,
  });
}

export async function PUT(req: Request) {
  const access = await automationGuard("editor");
  if (access instanceof Response) return access;

  const body = await readJson(req);
  const { action, behavior, thresholdCents } = body;

  const validationError = validateBehaviorForAction(action, behavior, thresholdCents);
  if (validationError) return badRequest(validationError);

  const a = action as string;
  const b = behavior as "auto" | "ask" | "never";
  const t = typeof thresholdCents === "number" ? thresholdCents : null;

  const saved = await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.automationSetting.upsert({
      where: {
        workspaceId_action: { workspaceId: access.workspaceId, action: a },
      },
      create: {
        workspaceId: access.workspaceId,
        action: a,
        behavior: b,
        thresholdCents: t,
        updatedBy: access.userId,
      },
      update: { behavior: b, thresholdCents: t, updatedBy: access.userId },
      select: { action: true, behavior: true, thresholdCents: true },
    }),
  );

  const resolved = resolveAutomationFromRows(
    await listAutomationRows(access.workspaceId),
    a,
  );

  return Response.json({
    setting: saved,
    resolved: {
      action: resolved.action,
      behavior: resolved.behavior,
      thresholdCents: resolved.thresholdCents,
      source: resolved.source,
    },
  });
}
