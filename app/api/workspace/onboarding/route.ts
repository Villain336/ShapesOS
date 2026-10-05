// ShapesOS — first-run onboarding wizard API (Phase 3, workstream I).
// GET   /api/workspace/onboarding → { state, suggestions } (admin+)
// PATCH /api/workspace/onboarding { step?, name?, business?, action? } (admin+)
//   name      renames the workspace (audited, lib/workspace/lifecycle.ts)
//   business  { businessType, website, goals[], notes } → pinned Business
//             profile knowledge entry (+ first project from the website)
//   step      resume point (name | business | connect | report)
//   action    "complete" | "skip" — the wizard stops appearing on its own
// Rules and storage: lib/workspace/onboarding.ts.

import type { NextRequest } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { errorResponse, BadRequestError } from "@/lib/api/errors";
import { renameWorkspace } from "@/lib/workspace/lifecycle";
import {
  completeOnboarding,
  connectionSuggestions,
  isOnboardingStep,
  loadOnboardingState,
  parseBusinessProfile,
  saveBusinessProfile,
  setOnboardingStep,
} from "@/lib/workspace/onboarding";

export const dynamic = "force-dynamic";

async function gate() {
  const user = await requireUser();
  if (!user) return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const me = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!me) return { error: forbidden("Setting up the workspace needs the admin role.") } as const;
  return { user, workspace } as const;
}

export async function GET() {
  try {
    const g = await gate();
    if ("error" in g) return g.error;
    const state = await loadOnboardingState(g.workspace.id);
    return Response.json({ state, suggestions: connectionSuggestions(state.profile) });
  } catch (err) {
    return errorResponse(err, "GET /api/workspace/onboarding");
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const g = await gate();
    if ("error" in g) return g.error;
    const body = (await req.json().catch(() => null)) as {
      step?: unknown;
      name?: unknown;
      business?: unknown;
      action?: unknown;
    } | null;
    if (!body) throw new BadRequestError("Invalid JSON");
    if (body.step !== undefined && !isOnboardingStep(body.step)) throw new BadRequestError("Unknown step.");
    if (body.action !== undefined && body.action !== "complete" && body.action !== "skip") {
      throw new BadRequestError("Unknown action.");
    }
    // Validate everything before writing anything.
    const profile = body.business !== undefined ? parseBusinessProfile(body.business) : null;

    let projectCreated = false;
    if (body.name !== undefined) {
      await renameWorkspace({ userId: g.user.id, workspaceId: g.workspace.id, name: body.name });
    }
    if (profile) ({ projectCreated } = await saveBusinessProfile(g.workspace.id, profile));
    if (isOnboardingStep(body.step)) await setOnboardingStep(g.workspace.id, body.step);
    if (body.action === "complete" || body.action === "skip") await completeOnboarding(g.workspace.id);

    const state = await loadOnboardingState(g.workspace.id);
    return Response.json({ state, suggestions: connectionSuggestions(state.profile), projectCreated });
  } catch (err) {
    return errorResponse(err, "PATCH /api/workspace/onboarding");
  }
}
