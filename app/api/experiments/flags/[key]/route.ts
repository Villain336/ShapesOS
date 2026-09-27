// Marketr — PUT / DELETE /api/experiments/flags/[key]
//
// The admin toggle for a tenant. PUT writes a per-workspace override — it
// does NOT mutate GrowthBook's global default, so one tenant's experiment
// never leaks into another's. DELETE clears the override (falls back to
// the GrowthBook default / Marketr built-in default).
// Admin+ only. Body: { defaultValue: unknown }.

import { z } from "zod";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { readJson, httpErrorResponse } from "@/lib/enrichment/guard";
import {
  clearWorkspaceFlagOverride,
  setWorkspaceFlagOverride,
} from "@/lib/integrations/growthbook-overrides";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  defaultValue: z.unknown(),
});

async function authorize() {
  const user = await requireUser();
  if (!user) return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) return { error: Response.json({ error: "Forbidden" }, { status: 403 }) };
  return { workspace };
}

export async function PUT(req: Request, ctx: { params: Promise<{ key: string }> }) {
  try {
    const { key } = await ctx.params;
    const auth = await authorize();
    if ("error" in auth) return auth.error;

    const parsed = BodySchema.safeParse(await readJson(req).catch(() => ({})));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input" }, { status: 400 });
    }
    const flagKey = decodeURIComponent(key);
    await setWorkspaceFlagOverride(auth.workspace.id, flagKey, parsed.data.defaultValue);
    return Response.json({ ok: true, key: flagKey, scope: "workspace" });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ key: string }> }) {
  try {
    const { key } = await ctx.params;
    const auth = await authorize();
    if ("error" in auth) return auth.error;

    const flagKey = decodeURIComponent(key);
    await clearWorkspaceFlagOverride(auth.workspace.id, flagKey);
    return Response.json({ ok: true, key: flagKey, scope: "workspace" });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
