// ShapesOS — Phase 21B (WS=drive): folder ACLs with inheritance and private
// homes (PURE, client-safe, no imports beyond the per-file arithmetic).
//
// One rule decides every item, file or folder: take the NEAREST explicit
// entry for the person among the item and the folders above it (a deeper
// entry overrides a shallower one — "a child inherits unless overridden"),
// then apply the workspace-role cap.
//
//   /shared, /files …   no entry → the workspace role's default (lib/files/acl.ts:
//                       admins own everything, editors edit, the creator owns)
//   /home/<owner>/…     no entry → the owner owns it; EVERYONE ELSE has no
//                       access at all — admins and workspace owners included.
//                       It opens only through an explicit share (an entry on
//                       the item or a folder above it), capped at editor (a
//                       share never hands over someone's home) and by the
//                       sharee's workspace role. There is deliberately no
//                       break-glass here: that is a decision for the owner.
//   /agents, /apps …    workspace-visible like /shared.

import { effectiveFileRole, fileRoleCap, minRole, type FileRole, type WorkspaceRoleName } from "../files/acl";

export interface AclEntry {
  /** The folder (or file) the entry is on, canonical stored path. */
  path: string;
  userId: string;
  role: FileRole;
}

/** The path itself and every folder above it, deepest first (stops before "/"). */
export function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  let p = path;
  while (p && p !== "/") {
    out.push(p);
    const i = p.lastIndexOf("/");
    p = i <= 0 ? "" : p.slice(0, i);
  }
  return out;
}

/** The nearest entry for `userId` on the item or above it, or null. */
export function nearestEntry(entries: readonly AclEntry[], path: string, userId: string): AclEntry | null {
  const mine = entries.filter((e) => e.userId === userId);
  if (mine.length === 0) return null;
  for (const p of ancestorsOf(path)) {
    const hit = mine.find((e) => e.path === p);
    if (hit) return hit;
  }
  return null;
}

/** False for the roots that are private to a person. */
export function visibleToAll(path: string): boolean {
  return !path.startsWith("/home/");
}

export interface ResolveInput {
  workspaceRole: WorkspaceRoleName;
  userId: string;
  /** The person whose home the item is in, or null. */
  ownerUserId: string | null;
  /** Who created the item (for the editor-who-made-it default). */
  createdBy: string | null;
  path: string;
  entries: readonly AclEntry[];
}

/** The person's role on the item, or null when they cannot see it at all. */
export function resolveDriveRole(input: ResolveInput): FileRole | null {
  const entry = nearestEntry(input.entries, input.path, input.userId);
  const cap = fileRoleCap(input.workspaceRole);
  if (input.ownerUserId) {
    if (input.ownerUserId === input.userId) return minRole("owner", cap);
    if (!entry) return null;
    return minRole(minRole(entry.role, "editor"), cap);
  }
  return effectiveFileRole({
    workspaceRole: input.workspaceRole,
    isCreator: !!input.createdBy && input.createdBy === input.userId,
    override: entry?.role ?? null,
  });
}
