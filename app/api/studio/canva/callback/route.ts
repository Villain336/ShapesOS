// Marketr — studio API: Canva OAuth callback (milestone 22).
// GET /api/studio/canva/callback?code=&state= → exchanges the code, then
// redirects back to the studio. The state binds the flow to the workspace that
// started it; the user must be signed in.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { createCanvaPort } from "@/lib/studio/canva";
import { handleCanvaCallback } from "@/lib/studio/service";
import { canvaClientConfig, canvaRedirectUri } from "../../_lib";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const error = url.searchParams.get("error");
  const fail = (msg: string) =>
    Response.redirect(`${url.origin}/dashboard?studioError=${encodeURIComponent(msg)}`, 302);

  const user = await requireUser();
  if (!user) return fail("Sign in to complete the Canva connection.");
  if (error) return fail(`Canva authorization failed: ${error}.`);
  if (!code || !state) return fail("Missing authorization code.");

  const client = canvaClientConfig();
  try {
    const { workspaceId } = await handleCanvaCallback(prisma, createCanvaPort(), {
      state,
      code,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUri: canvaRedirectUri(req),
      expectedUserId: user.id,
    });
    // workspaceId is bound to the state; resolve a project for the landing page.
    const project = await prisma.project.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    const dest = project
      ? `/dashboard/projects/${project.id}/studio?canva=connected`
      : `/dashboard?canva=connected`;
    return Response.redirect(`${url.origin}${dest}`, 302);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Canva connection failed.");
  }
}
