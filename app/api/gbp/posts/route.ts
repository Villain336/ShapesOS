// Marketr — GBP posts API (milestone 16, flagged scaffold).
// GET  /api/gbp/posts?accountId=…[&locationId=…] → posts (viewer+; mock provider for live reads).
// POST /api/gbp/posts { accountId, locationId, title, summary, callToAction?, actionUrl?, scheduledAt? }
//      → create a draft/scheduled post (editor+).

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { gbpGate } from "../_gate";
import { getGbpProvider } from "@/lib/local/gbp";

export const dynamic = "force-dynamic";

async function ownedAccount(userId: string, workspaceId: string, accountId: unknown) {
  if (typeof accountId !== "string" || !accountId) return null;
  return prisma.gbpAccount.findFirst({
    where: { id: accountId, workspaceId },
  });
}

export async function GET(req: NextRequest) {
  const gate = gbpGate();
  if (gate) return gate;
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) return forbidden();

  const sp = req.nextUrl.searchParams;
  const account = await ownedAccount(user.id, workspace.id, sp.get("accountId"));
  if (!account) return Response.json({ error: "Account not found" }, { status: 404 });

  const locationId = sp.get("locationId");
  const stored = await prisma.gbpPost.findMany({
    where: { gbpAccountId: account.id, ...(locationId ? { locationId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  // Mock provider read-through for demo locations.
  const providerPosts =
    locationId && getGbpProvider().isConfigured()
      ? await getGbpProvider().listPosts(locationId)
      : [];
  return Response.json({ posts: stored, providerPosts, provider: getGbpProvider().name });
}

export async function POST(req: NextRequest) {
  const gate = gbpGate();
  if (gate) return gate;
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const account = await ownedAccount(user.id, workspace.id, body.accountId);
  if (!account) return Response.json({ error: "Account not found" }, { status: 404 });

  const locationId = typeof body.locationId === "string" ? body.locationId.trim().slice(0, 200) : "";
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  const summary = typeof body.summary === "string" ? body.summary.trim().slice(0, 1500) : "";
  if (!locationId || !title || !summary) {
    return Response.json({ error: "accountId, locationId, title, and summary are required" }, { status: 400 });
  }

  let scheduledAt: Date | null = null;
  if (body.scheduledAt) {
    const d = new Date(String(body.scheduledAt));
    if (Number.isNaN(d.getTime())) return Response.json({ error: "Invalid scheduledAt" }, { status: 400 });
    scheduledAt = d;
  }

  // Route through the (mock) provider so the shape matches the future live one.
  const created = await getGbpProvider().createPost({
    locationId,
    title,
    summary,
    callToAction: typeof body.callToAction === "string" ? body.callToAction : null,
    actionUrl: typeof body.actionUrl === "string" ? body.actionUrl : null,
    scheduledAt,
  });

  const post = await prisma.gbpPost.create({
    data: {
      gbpAccountId: account.id,
      locationId,
      title,
      summary,
      status: created.status,
      scheduledAt,
      externalId: created.id,
    },
  });
  return Response.json({ post }, { status: 201 });
}
