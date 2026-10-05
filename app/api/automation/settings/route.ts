// Marketr — GET/PUT /api/automation/settings (Phase 9 M6, docs/specs/SPEC-PHASE9.md §P9E).
//
// GET  → { settings, defaults, thresholdCents }
//   settings: the workspace's automation_setting rows (workspace × action)
//   defaults: code defaults (per-action default behavior + Tier-1 kinds)
//   thresholdCents: effective workspace default small-action threshold
// PUT  → { action, behavior, thresholdCents?, agentKey? } upsert.
//   Rejects behavior=auto for Tier 3 kinds with 400 (un-overridable).
//   Phase 5: agentKey ("*" = every agent, default) makes a per-agent rule
//   ("Let Writer post to your own channels without asking").

import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { isAgentKey } from "@/lib/agents/grants";
import {
  ALL_AGENTS,
  DEFAULT_SMALL_ACTION_THRESHOLD_CENTS,
  KNOWN_ACTIONS,
  TIER1_KINDS,
  WORKSPACE_DEFAULT_ACTION,
  listAutomationRows,
  resolveAutomationFromRows,
  validateBehaviorForAction,
} from "@/lib/automation/policy";
import { automationGuard, badRequest, readJson } from "../_lib";
import { V1_TOOLKIT_SLUGS, listWorkspaceToolkits } from "@/lib/integrations/actions/toolkits";
import { autoAllowedFor, lockReasonFor } from "@/lib/automation/policy";

/**
 * Phase 14: the workspace's enabled Composio toolkits, each a switchable
 * "composio:<toolkit>" rule (medium-risk writes only; money toolkits locked).
 */
async function composioToolkitRows(workspaceId: string) {
  const rows = await listWorkspaceToolkits(workspaceId).catch(() => []);
  const explicit = new Map(rows.map((r) => [r.toolkitSlug, r.enabled]));
  const enabled = new Set<string>([
    ...V1_TOOLKIT_SLUGS.filter((s) => explicit.get(s) !== false),
    ...rows.filter((r) => r.enabled).map((r) => r.toolkitSlug),
  ]);
  return [...enabled].sort().map((slug) => {
    const action = `composio:${slug}`;
    const allowed = autoAllowedFor(action);
    return {
      action,
      label: `${slug.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())} via Composio`,
      description: "Medium-risk writes (send, create, update). Destructive ones always ask.",
      tier: 2 as const,
      group: "connectors" as const,
      autoAllowed: allowed,
      ...(allowed ? {} : { lockReason: lockReasonFor(action) }),
      defaultBehavior: "ask" as const,
    };
  });
}

export const dynamic = "force-dynamic";

function defaultsPayload() {
  return {
    // Phase 14: the code default per action (ask; never for Tier 3; the
    // explicit DEFAULT_BEHAVIORS such as slack_reply = auto).
    behaviors: Object.fromEntries(KNOWN_ACTIONS.map((a) => [a.action, a.defaultBehavior])),
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
      agentKey: r.agentKey ?? ALL_AGENTS,
      action: r.action,
      behavior: r.behavior,
      thresholdCents: r.thresholdCents,
    })),
    defaults: defaultsPayload(),
    thresholdCents,
    // Phase 14: Composio toolkit rules (shown in the Connectors section).
    composioToolkits: await composioToolkitRows(access.workspaceId),
  });
}

export async function PUT(req: Request) {
  const access = await automationGuard("editor");
  if (access instanceof Response) return access;

  const body = await readJson(req);
  const { action, behavior, thresholdCents } = body;
  const agentKey = body.agentKey === undefined || body.agentKey === null ? ALL_AGENTS : body.agentKey;
  if (agentKey !== ALL_AGENTS && !isAgentKey(agentKey)) {
    return badRequest('agentKey must be "*" or an agent key (lead, researcher, planner, drafter, analyst, scheduler, actor).');
  }

  const validationError = validateBehaviorForAction(action, behavior, thresholdCents);
  if (validationError) return badRequest(validationError);
  if (agentKey !== ALL_AGENTS && action === WORKSPACE_DEFAULT_ACTION) {
    return badRequest("The workspace threshold row is not per agent; use agentKey \"*\".");
  }

  const ag = agentKey as string;
  const a = action as string;
  const b = behavior as "auto" | "ask" | "never";
  const t = typeof thresholdCents === "number" ? thresholdCents : null;

  const saved = await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.automationSetting.upsert({
      where: {
        workspaceId_agentKey_action: { workspaceId: access.workspaceId, agentKey: ag, action: a },
      },
      create: {
        workspaceId: access.workspaceId,
        agentKey: ag,
        action: a,
        behavior: b,
        thresholdCents: t,
        updatedBy: access.userId,
      },
      update: { behavior: b, thresholdCents: t, updatedBy: access.userId },
      select: { agentKey: true, action: true, behavior: true, thresholdCents: true },
    }),
  );

  const resolved = resolveAutomationFromRows(
    await listAutomationRows(access.workspaceId),
    a,
    ag,
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
