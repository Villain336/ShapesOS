// Marketr — newsletter API: list subscribers (milestone 19).
// GET /api/newsletter/lists/[id]/subscribers?projectId=&status=&q=&take=&cursor=

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { ownedProject } from "../../../_lib";
import { intQuery, parseQuery, z } from "@/lib/api/validate";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const sp = new URL(req.url).searchParams;
  const project = await ownedProject(user.id, sp.get("projectId"));
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });
  const list = await prisma.newsletterList.findFirst({ where: { id, projectId: project.id } });
  if (!list) return Response.json({ error: "List not found" }, { status: 404 });

  const status = sp.get("status");
  const q = (sp.get("q") ?? "").trim();
  const takeQuery = parseQuery(z.object({ take: intQuery(50, 1, 200) }), sp);
  if (!takeQuery.ok) return takeQuery.error;
  const take = takeQuery.data.take;
  const where: Record<string, unknown> = { listId: id };
  if (status && ["subscribed", "unsubscribed", "bounced", "complained"].includes(status)) where.status = status;
  if (q) where.OR = [{ email: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }];

  const [subscribers, total] = await Promise.all([
    prisma.subscriber.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, email: true, name: true, status: true, createdAt: true },
    }),
    prisma.subscriber.count({ where }),
  ]);
  return Response.json({
    subscribers: subscribers.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() })),
    total,
  });
}
