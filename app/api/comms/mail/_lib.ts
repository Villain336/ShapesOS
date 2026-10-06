// ShapesOS — Phase 18.2 (WS=comms): /api/comms/mail shared bits (not a route).

import { commsGuard, type CommsContext } from "../_lib";
import type { MailCtx } from "@/lib/comms/mail/mailbox.server";

export async function mailGuard(min: "viewer" | "editor"): Promise<CommsContext & { mail: MailCtx }> {
  const ctx = await commsGuard(min);
  return { ...ctx, mail: { workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role } };
}

export function keyParam(url: URL): string {
  return (url.searchParams.get("key") ?? "").slice(0, 900);
}
