// ShapesOS — Phase 15.1: run a route handler inside the signed-in user's
// workspace sidecar scope (lib/integrations/sidecar-tenancy.ts).
//
//   async function getHandler(req: Request) { … }   // its own auth checks
//   export const GET = sidecarScoped(getHandler);
//
// The wrapper only decides WHICH sidecar instance the handler talks to (the
// workspace's own, or env when self-hosted); it authorises nothing — the
// handler keeps its own guard. Without a session the handler runs unscoped
// (on hosted: every shared instance refused) and returns its own 401.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { withWorkspaceSidecars } from "./sidecar-tenancy";

export function sidecarScoped<A extends unknown[], R>(handler: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    let workspaceId: string | null = null;
    try {
      const user = await requireUser();
      if (user) workspaceId = (await getOrCreateWorkspace(user.id, user.email)).id;
    } catch {
      workspaceId = null;
    }
    return workspaceId ? withWorkspaceSidecars(workspaceId, () => handler(...args)) : handler(...args);
  };
}
