// Marketr — studio API: M12 brand-kit defaults for Canva autofill prefill (milestone 22).
// GET /api/studio/canva/brand-defaults?projectId= → defaults or { defaults: null } (viewer OK).

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { getStudioAutofillDefaults } from "@/lib/studio/service";
import { ownedProject } from "../../_lib";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  const project = await ownedProject(user.id, new URL(req.url).searchParams.get("projectId"));
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });

  const defaults = await getStudioAutofillDefaults(prisma, project.workspaceId);
  return NextResponse.json({ defaults });
}
