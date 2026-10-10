// ShapesOS — Phase 21B (WS=drive): the agent's Drive tools. An agent reads and
// writes the SAME tree as people, under its grant: the run's own workspace
// (/agents/<runId>) plus the folders the person attached to the run
// (lib/drive/grants.ts). Every call is checked twice: against the grant (is the
// path inside what the run was given?) AND against what the person the agent
// works for may do there (folder ACLs, private homes) — an agent never has
// more than its person.
//
// Tier by EFFECT (the platform sets it from the action each tool stands for;
// nothing declares its own):
//   list_drive_folder · read_drive_file   safe · Tier 0 · read_agent_file
//   save_drive_file                       publish · Tier 1 · save_agent_file — NEW files only
//   replace_drive_file                    publish · Tier 2, always asks, never auto — an existing file
//   move_drive_file                       publish · Tier 2, always asks, never auto
//   trash_drive_file                      publish · Tier 2, always asks, never auto — one file, to the Trash
//   trash_many_drive_files                publish · Tier 3 (delete_many_agent_files), never auto — 5+ files
// Every change keeps the old bytes as a version or in the Trash, and reports
// what it touched so "Undo this agent run" can put it back (lib/timemachine/undo.ts).
// Descriptions avoid every Tier-3 word except the bulk tool's own.

import type { ToolDef, ToolResult } from "@/lib/chat/tools";
import { getStorageAdapter } from "../filesystem/storage";
import { FsError, DEFAULT_MAX_FILE_BYTES } from "../filesystem/core";
import { displayPath, normalizeFolderPath, normalizeLogicalPath, dirnameOf, basenameOf } from "../filesystem/paths";
import { BULK_TRASH_MIN, checkAgentFileOp, type AgentFileOp, type AgentGrant } from "./grants";
import { loadGrant, runKey } from "./run-folders";
import type { DriveActor } from "./access";
import { findLiveFileByPath, moveItemAs, trashItemAs, writeFileAs } from "./ops";
import { listChildren } from "./tree";
import { requireFileAction } from "../files/access";

const MAX_READ_BYTES = 100_000;

function actorOf(ctx: { workspaceId: string; userId: string; role: DriveActor["role"] }): DriveActor {
  return { workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role };
}

function canonical(path: unknown): string | null {
  if (typeof path !== "string" || !path.trim()) return null;
  const f = normalizeLogicalPath(path.trim());
  if (f.ok) return f.path;
  const d = normalizeFolderPath(path.trim());
  return d.ok ? d.path : null;
}

function refuse(reason: string): ToolResult {
  return { summary: reason, details: { refused: true } };
}

async function checked(ctx: Parameters<ToolDef["execute"]>[0], op: AgentFileOp): Promise<{ ok: true; grant: AgentGrant } | { ok: false; res: ToolResult }> {
  const grant = await loadGrant(ctx.workspaceId, ctx.runId, ctx.userId);
  const v = checkAgentFileOp(grant, op);
  if (!v.allowed) return { ok: false, res: refuse(`${v.reason} This run can use: ${[`/agents/${grant.runId}`, ...grant.folders].map(displayPath).join(", ")}.`) };
  return { ok: true, grant };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const list_drive_folder: ToolDef = {
  name: "list_drive_folder",
  description: "List the files and folders in a Drive folder this run can use (its own workspace folder by default, or a folder the person attached to the run).",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: { path: { type: "string", description: "Folder path, e.g. /shared/Reports. Default: this run's own workspace." } } },
  async execute(ctx, args): Promise<ToolResult> {
    const path = canonical(args.path) ?? `/agents/${runKey(ctx.runId, ctx.userId)}`;
    const c = await checked(ctx, { kind: "read", path });
    if (!c.ok) return c.res;
    try {
      const l = await listChildren({ actor: actorOf(ctx), path, limit: 100 });
      const lines = l.items.map((i) => `${i.kind === "folder" ? "[folder]" : "        "} ${i.path}${i.sizeBytes != null ? ` (${i.sizeBytes} bytes)` : ""}`);
      return { summary: `${l.path}: ${l.total} item${l.total === 1 ? "" : "s"}${l.total > l.items.length ? ` (first ${l.items.length})` : ""}\n${lines.join("\n") || "(empty)"}`, details: { path: l.path, total: l.total } };
    } catch (err) {
      return refuse(`Can't list that folder: ${errText(err)}`);
    }
  },
};

export const read_drive_file: ToolDef = {
  name: "read_drive_file",
  description: "Read a text file from a Drive folder this run can use (up to 100 KB of text; for other files you get the type and size).",
  kind: "safe",
  minRole: "viewer",
  argsSchema: { type: "object", properties: { path: { type: "string", description: "File path, e.g. /shared/Reports/q3.md" } }, required: ["path"] },
  async execute(ctx, args): Promise<ToolResult> {
    const path = canonical(args.path);
    if (!path) return refuse("path must be a Drive file path.");
    const c = await checked(ctx, { kind: "read", path });
    if (!c.ok) return c.res;
    const file = await findLiveFileByPath(ctx.workspaceId, path);
    if (!file) return refuse(`No file at ${displayPath(path)}.`);
    try {
      await requireFileAction(actorOf(ctx), file.id, "view");
    } catch {
      return refuse(`No file at ${displayPath(path)}.`);
    }
    const isText = file.mimeType.startsWith("text/") || file.mimeType === "application/json";
    if (!isText) return { summary: `${displayPath(file.logicalPath)} is a ${file.mimeType} file of ${file.sizeBytes} bytes; only text files can be read here.`, details: { fileId: file.id, mimeType: file.mimeType, sizeBytes: file.sizeBytes } };
    const bytes = await getStorageAdapter().getRange(file.storageKey, 0, Math.min(file.sizeBytes, MAX_READ_BYTES) - 1);
    const text = (bytes ?? Buffer.alloc(0)).toString("utf8");
    return { summary: `${displayPath(file.logicalPath)} (version ${file.version}${file.sizeBytes > MAX_READ_BYTES ? `, first ${MAX_READ_BYTES} bytes` : ""}):\n${text}`, details: { fileId: file.id, version: file.version, truncated: file.sizeBytes > MAX_READ_BYTES } };
  },
};

function splitPath(path: string): { dir: string; name: string } {
  return { dir: dirnameOf(path), name: basenameOf(path) };
}

export const save_drive_file: ToolDef = {
  name: "save_drive_file",
  description: "Save a NEW text file in a Drive folder this run can use (its own workspace folder, or one the person attached). It never changes a file that already exists: if the name is taken it says so.",
  kind: "publish",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Full path of the new file, e.g. /agents/<run>/summary.md or /shared/Reports/q3.md" },
      content: { type: "string", description: "The file's text (up to 25 MB)." },
    },
    required: ["path", "content"],
  },
  async execute(ctx, args): Promise<ToolResult> {
    const path = canonical(args.path);
    if (!path) return refuse("path must be a Drive file path.");
    const content = typeof args.content === "string" ? args.content : "";
    if (!content) return refuse("A file needs some content.");
    const c = await checked(ctx, { kind: "create", path });
    if (!c.ok) return c.res;
    const { dir, name } = splitPath(path);
    try {
      const { file } = await writeFileAs(actorOf(ctx), { dir, filename: name, bytes: Buffer.from(content, "utf8"), mimeType: /\.md$/i.test(name) ? "text/markdown" : /\.csv$/i.test(name) ? "text/csv" : "text/plain", overwrite: false, maxBytes: DEFAULT_MAX_FILE_BYTES });
      return {
        summary: `Saved ${displayPath(file.logicalPath)} (${file.sizeBytes} bytes).`,
        details: { fileId: file.id, path: displayPath(file.logicalPath), version: 1 },
        touched: [{ kind: "drive_file", id: file.id, op: "create", before: { version: 1, path: file.logicalPath } }],
      };
    } catch (err) {
      if (err instanceof FsError && err.code === "conflict") return refuse(`${displayPath(path)} already exists. Use replace_drive_file to change it (that asks first).`);
      return refuse(`Couldn't save the file: ${errText(err)}`);
    }
  },
};

export const replace_drive_file: ToolDef = {
  name: "replace_drive_file",
  description: "Put new text in a file that ALREADY exists in a Drive folder this run can use. The previous content is kept as an earlier version. Always asks the person first.",
  kind: "publish",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Path of the existing file." }, content: { type: "string", description: "The new text." } },
    required: ["path", "content"],
  },
  async execute(ctx, args): Promise<ToolResult> {
    const path = canonical(args.path);
    if (!path) return refuse("path must be a Drive file path.");
    const content = typeof args.content === "string" ? args.content : "";
    if (!content) return refuse("A file needs some content.");
    const c = await checked(ctx, { kind: "overwrite", path });
    if (!c.ok) return c.res;
    const existing = await findLiveFileByPath(ctx.workspaceId, path);
    if (!existing) return refuse(`No file at ${displayPath(path)}. Use save_drive_file to make a new one.`);
    const { dir, name } = splitPath(existing.logicalPath);
    try {
      const { file, version } = await writeFileAs(actorOf(ctx), { dir, filename: name, bytes: Buffer.from(content, "utf8"), mimeType: existing.mimeType, overwrite: true, maxBytes: DEFAULT_MAX_FILE_BYTES });
      return {
        summary: `Replaced ${displayPath(file.logicalPath)} (now version ${version}; the earlier content is kept).`,
        details: { fileId: file.id, version },
        touched: [{ kind: "drive_file", id: file.id, op: "update", before: { version: version - 1, path: file.logicalPath, writtenVersion: version } }],
      };
    } catch (err) {
      return refuse(`Couldn't replace the file: ${errText(err)}`);
    }
  },
};

export const move_drive_file: ToolDef = {
  name: "move_drive_file",
  description: "Move or rename a file inside the Drive folders this run can use. Always asks the person first.",
  kind: "publish",
  minRole: "editor",
  argsSchema: {
    type: "object",
    properties: { from: { type: "string", description: "Current path." }, to: { type: "string", description: "New full path (the destination folder must be one this run can use)." } },
    required: ["from", "to"],
  },
  async execute(ctx, args): Promise<ToolResult> {
    const from = canonical(args.from);
    const to = canonical(args.to);
    if (!from || !to) return refuse("from and to must be Drive file paths.");
    const c = await checked(ctx, { kind: "move", path: from, to });
    if (!c.ok) return c.res;
    const file = await findLiveFileByPath(ctx.workspaceId, from);
    if (!file) return refuse(`No file at ${displayPath(from)}.`);
    try {
      const moved = await moveItemAs(actorOf(ctx), { kind: "file", id: file.id, to });
      return {
        summary: `Moved ${displayPath(file.logicalPath)} to ${displayPath((moved as { logicalPath: string }).logicalPath)}.`,
        details: { fileId: file.id },
        touched: [{ kind: "drive_file", id: file.id, op: "move", before: { path: file.logicalPath, movedTo: (moved as { logicalPath: string }).logicalPath } }],
      };
    } catch (err) {
      return refuse(`Couldn't move the file: ${errText(err)}`);
    }
  },
};

export const trash_drive_file: ToolDef = {
  name: "trash_drive_file",
  description: "Move ONE file to the Trash (the person can put it back for 30 days). Always asks the person first.",
  kind: "publish",
  minRole: "editor",
  argsSchema: { type: "object", properties: { path: { type: "string", description: "Path of the file." } }, required: ["path"] },
  async execute(ctx, args): Promise<ToolResult> {
    const path = canonical(args.path);
    if (!path) return refuse("path must be a Drive file path.");
    const c = await checked(ctx, { kind: "trash", path, count: 1 });
    if (!c.ok) return c.res;
    const file = await findLiveFileByPath(ctx.workspaceId, path);
    if (!file) return refuse(`No file at ${displayPath(path)}.`);
    try {
      await trashItemAs(actorOf(ctx), { kind: "file", id: file.id });
      return {
        summary: `Moved ${displayPath(file.logicalPath)} to the Trash.`,
        details: { fileId: file.id },
        touched: [{ kind: "drive_file", id: file.id, op: "trash", before: { path: file.logicalPath } }],
      };
    } catch (err) {
      return refuse(`Couldn't move it to the Trash: ${errText(err)}`);
    }
  },
};

export const trash_many_drive_files: ToolDef = {
  name: "trash_many_drive_files",
  description: `Delete many files at once (${BULK_TRASH_MIN} to 50 paths): they go to the Trash, but removing this many is never automatic. A person must confirm.`,
  kind: "publish",
  minRole: "editor",
  argsSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, description: `${BULK_TRASH_MIN} to 50 file paths.` } }, required: ["paths"] },
  async execute(ctx, args): Promise<ToolResult> {
    const paths = (Array.isArray(args.paths) ? args.paths : []).map(canonical).filter((p): p is string => !!p);
    if (paths.length < BULK_TRASH_MIN || paths.length > 50) return refuse(`Give ${BULK_TRASH_MIN} to 50 file paths (use trash_drive_file for fewer).`);
    for (const p of paths) {
      const c = await checked(ctx, { kind: "trash", path: p, count: paths.length });
      if (!c.ok) return c.res;
    }
    const done: string[] = [];
    const touched: NonNullable<ToolResult["touched"]> = [];
    const failed: string[] = [];
    for (const p of paths) {
      const file = await findLiveFileByPath(ctx.workspaceId, p);
      if (!file) {
        failed.push(`${displayPath(p)} (not found)`);
        continue;
      }
      try {
        await trashItemAs(actorOf(ctx), { kind: "file", id: file.id });
        done.push(displayPath(file.logicalPath));
        touched.push({ kind: "drive_file", id: file.id, op: "trash", before: { path: file.logicalPath } });
      } catch (err) {
        failed.push(`${displayPath(p)} (${errText(err)})`);
      }
    }
    return { summary: `Moved ${done.length} file${done.length === 1 ? "" : "s"} to the Trash.${failed.length ? ` Not done: ${failed.join("; ")}.` : ""}`, details: { done, failed }, touched };
  },
};

export const DRIVE_TOOLS: readonly ToolDef[] = [list_drive_folder, read_drive_file, save_drive_file, replace_drive_file, move_drive_file, trash_drive_file, trash_many_drive_files];

/** Each tool's group (lib/agents/grants.ts TOOL_GROUPS). */
export const DRIVE_TOOL_GROUP = {
  list_drive_folder: "workspace",
  read_drive_file: "workspace",
  save_drive_file: "content",
  replace_drive_file: "content",
  move_drive_file: "content",
  trash_drive_file: "content",
  trash_many_drive_files: "content",
} as const;

/** The automation action each non-safe tool stands for (what the platform tiers). */
export const DRIVE_TOOL_ACTION: Readonly<Record<string, string>> = {
  list_drive_folder: "read_agent_file",
  read_drive_file: "read_agent_file",
  save_drive_file: "save_agent_file",
  replace_drive_file: "replace_agent_file",
  move_drive_file: "move_agent_file",
  trash_drive_file: "trash_agent_file",
  trash_many_drive_files: "delete_many_agent_files",
};
