// ShapesOS — Phase 21B (WS=drive): which roots a PERSON may write to (PURE).
// (Agents are governed by lib/drive/grants.ts; apps by lib/drive/app-container.ts;
// mounts by their provider.) This is only the root policy: the person's role on
// the target folder (lib/drive/acl.ts) is checked on top.

import type { PathInfo } from "../filesystem/paths";

export function personMayWriteTo(info: PathInfo, userId: string): { ok: true } | { ok: false; reason: string } {
  switch (info.root) {
    case "/files":
    case "/memory":
    case "/shared":
    case "/agents":
      return { ok: true };
    case "/home":
      return info.ownerUserId === userId ? { ok: true } : { ok: false, reason: "That is someone else's private folder." };
    case "/skills":
    case "/artifacts":
      return { ok: false, reason: "This folder is managed by ShapesOS; files are added by the app that owns it." };
    case "/apps":
      return { ok: false, reason: "App folders are written by the app itself." };
    case "/mounts":
      return { ok: false, reason: "Mounted folders are changed in the source they come from." };
  }
}
