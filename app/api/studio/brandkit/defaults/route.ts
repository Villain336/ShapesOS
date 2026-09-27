// Marketr — studio API: workspace brand-kit defaults for the GrapesJS page
// editor (Phase 12, Worker 1). GET /api/studio/brandkit/defaults → the
// default kit's colors/fonts, or { defaults: null } when none exists.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getStudioAutofillDefaults } from "@/lib/studio/service";
import { guardWorkspace, httpErrorResponse } from "../../designs/_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const defaults = await getStudioAutofillDefaults(prisma, workspace.id);
    return NextResponse.json({ defaults });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
