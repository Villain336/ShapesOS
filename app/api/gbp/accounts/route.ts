// Marketr — GBP accounts API (milestone 16, flagged scaffold).
// GET  /api/gbp/accounts → accounts for the workspace (viewer+).
// POST /api/gbp/accounts { name } → create (admin+).

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { gbpGate } from "../_gate";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = gbpGate();
  if (gate) return gate;
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) return forbidden();

  const accounts = await prisma.gbpAccount.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { posts: true } } },
  });
  return Response.json({ accounts });
}

export async function POST(req: NextRequest) {
  const gate = gbpGate();
  if (gate) return gate;
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) return forbidden();

  let body: { name?: string };
  try {
    body = (await req.json()) as { name?: string };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });

  const account = await prisma.gbpAccount.create({
    data: { workspaceId: workspace.id, name },
  });
  return Response.json({ account }, { status: 201 });
}
