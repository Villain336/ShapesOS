// Marketr — newsletter API: sending domains (milestone 19).
// GET /api/newsletter/domains?workspaceId= → domains with DNS records
// POST /api/newsletter/domains { workspaceId, domain } → create in Resend, return records

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { addDomain } from "@/lib/newsletter/service";
import { requireWorkspaceEditor, readJson, workspacePort } from "../_lib";

async function workspaceOf(userId: string, workspaceId: unknown) {
  if (typeof workspaceId !== "string" || !workspaceId) return null;
  return prisma.workspace.findFirst({
    where: { id: workspaceId, members: { some: { userId } } },
    select: { id: true },
  });
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const ws = await workspaceOf(user.id, new URL(req.url).searchParams.get("workspaceId"));
  if (!ws) return Response.json({ error: "Workspace not found" }, { status: 404 });
  const denied = await requireWorkspaceEditor(user.id, ws.id);
  if (denied) return denied;
  const domains = await prisma.newsletterDomain.findMany({
    where: { workspaceId: ws.id },
    orderBy: { createdAt: "asc" },
  });
  return Response.json({ domains });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readJson(req);
  const ws = await workspaceOf(user.id, body.workspaceId);
  if (!ws) return Response.json({ error: "Workspace not found" }, { status: 404 });
  const denied = await requireWorkspaceEditor(user.id, ws.id);
  if (denied) return denied;
  const portResult = await workspacePort(ws.id);
  if ("response" in portResult) return portResult.response;
  try {
    const row = await addDomain(prisma, ws.id, String(body.domain ?? ""), portResult.port);
    return Response.json({ id: row.id, dnsRecords: row.dnsRecords }, { status: 201 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to add domain." }, { status: 400 });
  }
}
