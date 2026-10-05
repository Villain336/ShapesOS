// ShapesOS — mobile push device registration (Phase 4b).
//
// GET    /api/mobile/push-devices                       → { devices, pushEnabled, kinds }
// POST   /api/mobile/push-devices { token, platform, deviceName? }  → 201 { device }
// PATCH  /api/mobile/push-devices { token, enabled?, mutedKinds? }  → { device }
// DELETE /api/mobile/push-devices { token }             → { removed }
//
// Any member (viewer+) of the active workspace manages their OWN devices
// only: every query is keyed on the session user, never on an id from the
// request. push_devices is FORCE RLS (withWorkspaceScope). The mobile app
// calls POST after sign-in and DELETE on sign-out.

import type { NextRequest } from "next/server";
import { errorResponse, UnauthorizedError, ForbiddenError } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { listDevices, PUSH_KINDS, registerDevice, removeDevice, updateDevice } from "@/lib/push/devices";
import { pushProvider } from "@/lib/push/expo";

export const dynamic = "force-dynamic";

async function guard(): Promise<{ userId: string; workspaceId: string }> {
  const user = await requireUser();
  if (!user?.id) throw new UnauthorizedError();
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) throw new ForbiddenError();
  return { userId: user.id, workspaceId: workspace.id };
}

const tokenField = z.string().trim().min(1).max(240);

const RegisterSchema = z.object({
  token: tokenField,
  platform: z.enum(["ios", "android"]),
  deviceName: z.string().trim().max(80).optional(),
});

const UpdateSchema = z.object({
  token: tokenField,
  enabled: z.boolean().optional(),
  mutedKinds: z.array(z.enum(PUSH_KINDS)).max(PUSH_KINDS.length).optional(),
});

const RemoveSchema = z.object({ token: tokenField });

export async function GET() {
  try {
    const ctx = await guard();
    const devices = await withWorkspaceScope(ctx.workspaceId, (tx) => listDevices(tx, ctx));
    return Response.json({ devices, pushEnabled: pushProvider() === "expo", kinds: PUSH_KINDS });
  } catch (err) {
    return errorResponse(err, "GET /api/mobile/push-devices");
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await guard();
    const parsed = validateBody(RegisterSchema, await req.json());
    if (!parsed.ok) return parsed.error;
    const device = await withWorkspaceScope(ctx.workspaceId, (tx) =>
      registerDevice(tx, { ...ctx, ...parsed.data }),
    );
    return Response.json({ device, pushEnabled: pushProvider() === "expo" }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/mobile/push-devices");
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const ctx = await guard();
    const parsed = validateBody(UpdateSchema, await req.json());
    if (!parsed.ok) return parsed.error;
    const device = await withWorkspaceScope(ctx.workspaceId, (tx) =>
      updateDevice(tx, { ...ctx, ...parsed.data }),
    );
    return Response.json({ device });
  } catch (err) {
    return errorResponse(err, "PATCH /api/mobile/push-devices");
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const ctx = await guard();
    const parsed = validateBody(RemoveSchema, await req.json().catch(() => ({})));
    if (!parsed.ok) return parsed.error;
    const removed = await withWorkspaceScope(ctx.workspaceId, (tx) =>
      removeDevice(tx, { ...ctx, token: parsed.data.token }),
    );
    return Response.json({ removed });
  } catch (err) {
    return errorResponse(err, "DELETE /api/mobile/push-devices");
  }
}
