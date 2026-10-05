// Marketr — GBP posts API (milestone 16, flagged scaffold).
// GET  /api/gbp/posts?accountId=…[&locationId=…] → posts (viewer+; provider read-through: live with a GBP connection, mock otherwise).
// POST /api/gbp/posts { accountId, locationId, title, summary, callToAction?, actionUrl?, scheduledAt? }
//      → create a draft/scheduled post (editor+). Phase 4b: with a live GBP
//      connection, { publish: true } publishes on Google; otherwise a local draft.

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { gbpGate } from "../_gate";
import { gbpProviderForWorkspace } from "@/lib/local/gbp-live";

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
  // Provider read-through: live when the workspace connected GBP (Phase 4b),
  // the mock provider otherwise.
  const provider = await gbpProviderForWorkspace(workspace.id);
  let providerPosts: unknown[] = [];
  let providerError: string | null = null;
  if (locationId && provider.isConfigured()) {
    try {
      providerPosts = await provider.listPosts(locationId);
    } catch (err) {
      providerError = err instanceof Error ? err.message : "Provider read failed.";
    }
  }
  return Response.json({ posts: stored, providerPosts, providerError, provider: provider.name, live: provider.isLive });
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

  // Phase 4b: with a live GBP connection, posting publishes on Google, so it
  // needs an explicit publish: true from the editor; otherwise the post is
  // kept as a local draft and nothing is sent. Scheduled posts stay local.
  const provider = await gbpProviderForWorkspace(workspace.id);
  if (provider.isLive && (body.publish !== true || scheduledAt)) {
    const draft = await prisma.gbpPost.create({
      data: { gbpAccountId: account.id, locationId, title, summary, status: scheduledAt ? "scheduled" : "draft", scheduledAt, externalId: null },
    });
    return Response.json({ post: draft, published: false }, { status: 201 });
  }
  let created;
  try {
    created = await provider.createPost({
    locationId,
    title,
    summary,
    callToAction: typeof body.callToAction === "string" ? body.callToAction : null,
    actionUrl: typeof body.actionUrl === "string" ? body.actionUrl : null,
    scheduledAt,
  });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Publishing to Google failed." }, { status: 502 });
  }

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
