// Marketr — list the signed-in user's OAuth clients, Phase C W5.
//
// GET /api/mcp/oauth/clients → { clients: [{ clientId, clientName, workspaceId, createdAt }] }

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "authentication required" }, { status: 401 });
  const clients = await prisma.mcpOAuthClient.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { clientId: true, clientName: true, workspaceId: true, createdAt: true },
  });
  return Response.json({ clients });
}
