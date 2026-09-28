// Marketr — Phase 13B: style rules CRUD.
// GET  /api/intelligence/style-rules?workspaceId=…[&kind=ban][&active=true]
// POST /api/intelligence/style-rules { workspaceId, kind, pattern, … }
//
// Rules created here default active=true (user-authored). Learner-proposed
// rules (worker 6) arrive active=false per the data-model contract.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import {
  workspaceIdFrom,
  requireWorkspaceAccess,
  badRequest,
  notFound,
} from "@/lib/route-utils";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { compilePattern } from "@/lib/intelligence/company/style-check";
import { StyleRuleKind, StyleRuleSeverity } from "@prisma/client";

const KINDS = Object.values(StyleRuleKind) as string[];
const SEVERITIES = Object.values(StyleRuleSeverity) as string[];

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const access = await requireWorkspaceAccess(
    user.id,
    workspaceIdFrom(req),
    "viewer",
  );
  if ("error" in access) return access.error;

  const qp = req.nextUrl.searchParams;
  const kind = qp.get("kind");
  const activeParam = qp.get("active");
  if (kind && !KINDS.includes(kind)) {
    return badRequest(`kind must be one of: ${KINDS.join(", ")}`);
  }

  const rules = await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.styleRule.findMany({
      where: {
        workspaceId: access.workspaceId,
        ...(kind ? { kind: kind as StyleRuleKind } : {}),
        ...(activeParam === "true" ? { active: true } : {}),
        ...(activeParam === "false" ? { active: false } : {}),
      },
      orderBy: { createdAt: "asc" },
    }),
  );
  return Response.json({ rules });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  let body: {
    workspaceId?: string;
    kind?: string;
    pattern?: string;
    replacement?: string;
    severity?: string;
    pinned?: boolean;
    active?: boolean;
    source?: string;
  };
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const access = await requireWorkspaceAccess(
    user.id,
    workspaceIdFrom(req, body),
    "editor",
  );
  if ("error" in access) return access.error;

  if (!body.kind || !KINDS.includes(body.kind)) {
    return badRequest(`kind is required, one of: ${KINDS.join(", ")}`);
  }
  if (!body.pattern?.trim()) return badRequest("pattern is required");
  if (!body.severity || !SEVERITIES.includes(body.severity)) {
    return badRequest(`severity is required, one of: ${SEVERITIES.join(", ")}`);
  }
  // Fail fast on broken regexes — a rule that can't compile can never fire.
  try {
    compilePattern(body.pattern);
  } catch {
    return badRequest("pattern is not a valid regular expression");
  }

  const rule = await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.styleRule.create({
      data: {
        workspaceId: access.workspaceId,
        kind: body.kind as StyleRuleKind,
        pattern: body.pattern!,
        replacement: body.replacement ?? null,
        severity: body.severity as StyleRuleSeverity,
        pinned: body.pinned === true,
        active: body.active !== false,
        source: body.source?.trim() || "user",
      },
    }),
  );
  return Response.json({ rule }, { status: 201 });
}

export async function DELETE() {
  return notFound("Use /api/intelligence/style-rules/[id] to delete a rule.");
}
