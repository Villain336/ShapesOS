// ShapesOS — Phase 18.2 (WS=content): the Files app's agent tools (listed in
// lib/chat/tools.ts TOOLS). Same gates as every tool; on top, the per-file
// access of the person the agent works for (lib/files/acl.ts).
//
//   list_file_versions  safe · Tier 0 · group "workspace" · viewer
//   share_file_link     publish · Tier 2 (TOOL_ACTION "share_file_externally":
//                       a file leaves the workspace — always asks unless a
//                       rule says Auto-run) · group "content" · editor
// Descriptions avoid every Tier-3 word (lib/orchestrator/authority.ts).

import type { ToolDef, ToolResult } from "@/lib/chat/tools";
import { listFileVersions } from "@/lib/filesystem/versions";
import { requireFileAction } from "./access";
import { createShareLink } from "./shares";
// Phase 21B (WS=drive): the agent's Drive tools (read / save / replace / move / trash under a run grant).
import { DRIVE_TOOLS } from "@/lib/drive/tools";

function fileIdOf(v: unknown): string | null {
  const raw = typeof v === "string" ? v.trim().replace(/^(file|file_content):/, "") : "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : null;
}

export const list_file_versions: ToolDef = {
  name: "list_file_versions",
  description: "List the versions of a workspace file (who uploaded each, when, its size), newest first. Find the file first with search_workspace (kind file).",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: { file: { type: "string", description: 'The file id, or "file:<id>".' } }, required: ["file"] },
  async execute(ctx, args): Promise<ToolResult> {
    const id = fileIdOf(args.file);
    if (!id) return { summary: 'file must be a file id (or "file:<id>").' };
    try {
      const { file } = await requireFileAction({ workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role }, id, "view");
      const versions = (await listFileVersions(ctx.workspaceId, id)) ?? [];
      const lines = versions.map((v) => `- v${v.version}${v.current ? " (current)" : ""}: ${v.createdAt.slice(0, 16).replace("T", " ")}, ${v.sizeBytes} bytes`);
      return { summary: `${file.filename} has ${versions.length} version${versions.length === 1 ? "" : "s"}:\n${lines.join("\n")}`, details: { file: { id: file.id, filename: file.filename }, versions } };
    } catch (err) {
      return { summary: `Can't list that file's versions: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const share_file_link: ToolDef = {
  name: "share_file_link",
  description:
    "Create a share link for a workspace file so someone outside the workspace can open it: view-only (default) or view and download, expiring after 1-90 days (default 7), optionally password-protected. Returns the link once.",
  kind: "publish",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      file: { type: "string", description: 'The file id, or "file:<id>".' },
      access: { type: "string", description: '"view" (default) or "download".' },
      days: { type: "number", description: "How many days the link works (1-90, default 7)." },
      password: { type: "string", description: "Optional password (6-128 characters) the person must enter." },
    },
    required: ["file"],
  },
  async execute(ctx, args): Promise<ToolResult> {
    const id = fileIdOf(args.file);
    if (!id) return { summary: 'file must be a file id (or "file:<id>").' };
    try {
      const res = await createShareLink({ workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role }, id, {
        access: args.access === "download" ? "download" : "view",
        expiresInDays: args.days === undefined ? undefined : Number(args.days),
        password: typeof args.password === "string" && args.password ? args.password : null,
      });
      const origin = (process.env.APP_URL ?? "").replace(/\/$/, "");
      return {
        summary: `Share link (${res.link.access === "download" ? "view and download" : "view only"}, until ${res.link.expiresAt?.slice(0, 10)}${res.link.hasPassword ? ", password-protected" : ""}): ${origin}${res.path}`,
        details: { link: res.link, url: `${origin}${res.path}` },
        // Phase 18.3 (WS=flow): for "Undo this agent run" (revokes the link).
        touched: [{ kind: "file_share", id: res.link.id, fileId: id, op: "share" }],
      };
    } catch (err) {
      return { summary: `Couldn't create the link: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const FILE_TOOLS: readonly ToolDef[] = [list_file_versions, share_file_link, ...DRIVE_TOOLS];
