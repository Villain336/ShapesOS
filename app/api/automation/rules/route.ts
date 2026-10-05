// Marketr — GET/PUT /api/automation/rules (Phase 9 M6, docs/specs/SPEC-PHASE9.md §P9E).
//
// GET → { rules } (seeds the 3 sensible defaults on first read).
// PUT → { rules: [...] } full-replace CRUD: every rule is validated
//   (name, condition.kind, amount_above value, action) before anything is
//   written; the write is atomic.

import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import type { Prisma } from "@prisma/client";
import {
  getOrSeedEscalationRules,
  validateEscalationRule,
} from "@/lib/automation/escalation";
import { automationGuard, badRequest, readJson } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await automationGuard("viewer");
  if (access instanceof Response) return access;

  const rules = await getOrSeedEscalationRules(access.workspaceId);
  return Response.json({ rules });
}

export async function PUT(req: Request) {
  const access = await automationGuard("editor");
  if (access instanceof Response) return access;

  const body = await readJson(req);
  if (!Array.isArray(body.rules)) {
    return badRequest("Body must be { rules: [...] }.");
  }
  if (body.rules.length > 50) {
    return badRequest("At most 50 escalation rules per workspace.");
  }

  const validated: Array<{
    name: string;
    condition: { kind: string; value?: number };
    action: string;
    enabled: boolean;
  }> = [];
  for (let i = 0; i < body.rules.length; i++) {
    const result = validateEscalationRule(body.rules[i]);
    if (!result.ok) return badRequest(`rules[${i}]: ${result.error}`);
    validated.push(result.rule);
  }

  const saved = await withWorkspaceScope(access.workspaceId, async (tx) => {
    // Full replace, atomic: validate-everything-first above, then swap.
    await tx.escalationRule.deleteMany({ where: { workspaceId: access.workspaceId } });
    return Promise.all(
      validated.map((r, i) =>
        tx.escalationRule.create({
          data: {
            workspaceId: access.workspaceId,
            name: r.name,
            // Validated above: { kind, value? } is always JSON-serializable.
            conditionJson: r.condition as unknown as Prisma.InputJsonValue,
            action: r.action,
            enabled: r.enabled,
            position: i,
          },
          select: { id: true, name: true, conditionJson: true, action: true, enabled: true, position: true },
        }),
      ),
    );
  });

  return Response.json({ rules: saved });
}
