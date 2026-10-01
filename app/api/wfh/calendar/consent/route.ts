// Marketr — Wave 2 WFH mode slice 3: auto-decline consent gate API.
// POST /api/wfh/calendar/consent — record the one-time consent:
// "the OS may decline meetings on my behalf during hard-protected focus blocks."
// Body: { provider: "google" | "microsoft" }.
// This records consent only. The calendar itself stays disconnected until the
// parked calendar integration lands — hard protection still fails closed with
// NO_CALENDAR until then, by design.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const connections = await prisma.wfhCalendarConnection.findMany({
    where: { workspaceId: workspace.id, userId: user.id },
  });
  return NextResponse.json({ connections });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { provider?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const provider = body.provider === "microsoft" ? "microsoft" : "google";

  const connection = await prisma.wfhCalendarConnection.upsert({
    where: {
      workspaceId_userId_provider: { workspaceId: workspace.id, userId: user.id, provider },
    },
    create: {
      workspaceId: workspace.id,
      userId: user.id,
      provider,
      status: "disconnected",
      autoDeclineConsentAt: new Date(),
    },
    update: { autoDeclineConsentAt: new Date() },
  });

  return NextResponse.json({
    connection,
    note: "Consent recorded. The calendar itself stays disconnected until the calendar integration lands — hard protection will fail closed with NO_CALENDAR until then.",
  });
}
