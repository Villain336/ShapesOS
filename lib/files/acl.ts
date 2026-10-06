// ShapesOS — Phase 18.2 (WS=content): per-file access (PURE, client-safe).
//
// A file's access for a member is their WORKSPACE role, optionally narrowed
// (or, for an editor, raised to file owner) by a per-file override — never
// wider than the workspace allows:
//
//   workspace role │ default on a file            │ override may set   │ cap
//   ───────────────┼──────────────────────────────┼────────────────────┼──────
//   owner / admin  │ owner                        │ — (never narrowed) │ owner
//   editor         │ editor (owner if they made   │ viewer · editor ·  │ owner
//                  │ the file)                    │ owner              │
//   viewer         │ viewer                       │ viewer             │ viewer
//
// What each file role may do:
//   viewer  see, preview, download (when the workspace lets members download:
//           always — a share link's "view only" is for people outside)
//   editor  + rename, move, upload a new version, restore a version, trash,
//           annotate, create share links
//   owner   + change who can do what (the per-file overrides), revoke anyone's
//           share links
// Admins keep full control of every file so a file can't be locked away from
// the people who run the workspace.

export const FILE_ROLES = ["viewer", "editor", "owner"] as const;
export type FileRole = (typeof FILE_ROLES)[number];
export type WorkspaceRoleName = "viewer" | "editor" | "admin" | "owner";

const RANK: Record<FileRole, number> = { viewer: 1, editor: 2, owner: 3 };

export function isFileRole(v: unknown): v is FileRole {
  return typeof v === "string" && (FILE_ROLES as readonly string[]).includes(v);
}

function isWorkspaceAdmin(role: WorkspaceRoleName): boolean {
  return role === "owner" || role === "admin";
}

/** The widest file role this workspace role can ever hold. */
export function fileRoleCap(workspaceRole: WorkspaceRoleName): FileRole {
  return workspaceRole === "viewer" ? "viewer" : "owner";
}

/** The file role without an override. */
export function defaultFileRole(workspaceRole: WorkspaceRoleName, isCreator: boolean): FileRole {
  if (isWorkspaceAdmin(workspaceRole)) return "owner";
  if (workspaceRole === "editor") return isCreator ? "owner" : "editor";
  return "viewer";
}

export function minRole(a: FileRole, b: FileRole): FileRole {
  return RANK[a] <= RANK[b] ? a : b;
}

/** The member's effective role on one file. */
export function effectiveFileRole(input: { workspaceRole: WorkspaceRoleName; isCreator: boolean; override?: FileRole | null }): FileRole {
  if (isWorkspaceAdmin(input.workspaceRole)) return "owner";
  if (input.override) return minRole(input.override, fileRoleCap(input.workspaceRole));
  return defaultFileRole(input.workspaceRole, input.isCreator);
}

export type FileAction = "view" | "download" | "edit" | "version" | "trash" | "annotate" | "share" | "manageAccess";

const NEEDS: Record<FileAction, FileRole> = {
  view: "viewer",
  download: "viewer",
  edit: "editor",
  version: "editor",
  trash: "editor",
  annotate: "editor",
  share: "editor",
  manageAccess: "owner",
};

export function fileCan(role: FileRole, action: FileAction): boolean {
  return RANK[role] >= RANK[NEEDS[action]];
}

/**
 * May this override be stored for a member with this workspace role?
 * Refuses anything wider than the cap and any override on an admin/owner
 * (they are never narrowed, so it would be a lie in the list).
 */
export function checkOverride(targetWorkspaceRole: WorkspaceRoleName, role: FileRole): { ok: true } | { ok: false; reason: string } {
  if (isWorkspaceAdmin(targetWorkspaceRole)) return { ok: false, reason: "Admins and owners always have full access to every file." };
  if (RANK[role] > RANK[fileRoleCap(targetWorkspaceRole)]) {
    return { ok: false, reason: "A file can't give someone more access than their workspace role allows." };
  }
  return { ok: true };
}
