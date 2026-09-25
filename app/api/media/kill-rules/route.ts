// Marketr — /api/media/kill-rules
// GET  → list sweeper rules (workspace-scoped)
// POST → create a rule (owner-only — every action traces to a human-set rule)

import type { NextRequest } from "next/server";
import { mediaGuard, badRequest, safetyError, requireMediaOwner } from "../_lib";
import { KillRuleSchema } from "../_schemas";
import { mediaStores, safetyTablesReady, logMediaAudit } from "@/lib/media/db";
import { defaultRulePack } from "@/lib/media/killswitch";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await mediaGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await safetyTablesReady())) {
    return Response.json({ rules: [], tablesReady: false });
  }
  const q = new URL(req.url).searchParams;
  const enabledOnly = q.get("enabled") === "true";
  const { killRules } = mediaStores();
  const rules = await killRules.list(gate.workspaceId, enabledOnly);
  return Response.json({ rules, tablesReady: true });
}

export async function POST(req: NextRequest) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  const ownerCheck = requireMediaOwner(gate.mediaRole);
  if (ownerCheck) return ownerCheck;
  if (!(await safetyTablesReady())) {
    return Response.json({ error: "Media safety tables not provisioned yet." }, { status: 503 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = KillRuleSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const { killRules, audit } = mediaStores();
    const rule = await killRules.create({
      workspaceId: gate.workspaceId,
      createdBy: gate.userId,
      clientId: parsed.data.clientId ?? null,
      name: parsed.data.name,
      scope: parsed.data.scope,
      condition: parsed.data.condition,
      window: parsed.data.window,
      action: parsed.data.action,
      cooldownMinutes: parsed.data.cooldownMinutes,
      enabled: true, // new rules ship enabled (SPEC-PHASE5.md §9.8)
    });
    await logMediaAudit(audit, {
      workspaceId: gate.workspaceId, actor: gate.userId,
      action: "kill_rule_created", subjectType: "kill_rule", subjectId: rule.id,
      detail: { name: rule.name, action: rule.action, enabled: rule.enabled },
    }).catch((e) => console.error("[media-audit] kill_rule_created write failed:", e));
    return Response.json({ rule }, { status: 201 });
  } catch (err) {
    return safetyError(err);
  }
}

/** Seed the default v1 rule pack (ships enabled per SPEC-PHASE5.md §9.8). */
export async function PUT(req: NextRequest) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  const ownerCheck = requireMediaOwner(gate.mediaRole);
  if (ownerCheck) return ownerCheck;
  if (!(await safetyTablesReady())) {
    return Response.json({ error: "Media safety tables not provisioned yet." }, { status: 503 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const clientId = (raw as { clientId?: string })?.clientId?.trim() || null;
  const { killRules, audit } = mediaStores();
  const created = await Promise.all(
    defaultRulePack(gate.workspaceId, clientId, gate.userId).map((r) => killRules.create(r)),
  );
  await logMediaAudit(audit, {
    workspaceId: gate.workspaceId, actor: gate.userId,
    action: "kill_rule_pack_seeded", subjectType: "workspace", subjectId: null,
    detail: { ruleCount: created.length, clientId, ruleNames: created.map((r) => r.name) },
  }).catch((e) => console.error("[media-audit] kill_rule_pack_seeded write failed:", e));
  return Response.json({ rules: created }, { status: 201 });
}
