// ShapesOS — Phase 18.2 (WS=content): the Notes app's agent tools.
// Listed in lib/chat/tools.ts TOOLS (like OPS_TOOLS), same ToolDef contract
// and gates as every other tool (lib/chat/tool-exec.ts).
//
//   read_note    safe  · Tier 0 · group "workspace" · viewer
//                Reads one note the person the agent works for can see
//                (their private notes + shared ones). Agents FIND notes with
//                search_workspace (Spotlight kind "note").
//   create_note  publish · Tier 1 (TOOL_ACTION "write_internal_note",
//                TIER1_KINDS) · group "content" · viewer
//                Writes a note owned by that person (private unless they ask
//                to share it, which needs editor+). Internal, reversible, no
//                audience outside the workspace: an automation rule may let
//                it run; without one it asks first.
// Descriptions deliberately avoid every Tier-3 word (lib/orchestrator/authority.ts).

import type { ToolDef, ToolResult } from "@/lib/chat/tools";
import { roleAtLeast } from "@/lib/authz";
import { createNote, readNoteText } from "./service";

function linksFrom(v: unknown): Array<{ kind: string; id: string; label?: string }> {
  const list = Array.isArray(v) ? v : typeof v === "string" && v.trim() ? v.split(",") : [];
  const out: Array<{ kind: string; id: string; label?: string }> = [];
  for (const item of list) {
    if (typeof item === "string") {
      const m = /^\s*([a-z_]+):([A-Za-z0-9_-]{1,64})\s*$/.exec(item);
      if (m) out.push({ kind: m[1]!, id: m[2]! });
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      if (typeof o.kind === "string" && typeof o.id === "string") out.push({ kind: o.kind, id: o.id, ...(typeof o.label === "string" ? { label: o.label } : {}) });
    }
  }
  return out;
}

export const read_note: ToolDef = {
  name: "read_note",
  description:
    "Read one note from the Notes app: its title, text, folder, tags and the records it is linked to. Find notes first with search_workspace (kind note); pass the note id.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      note: { type: "string", description: 'The note id, or "note:<id>" as search_workspace returns it.' },
    },
    required: ["note"],
  },
  async execute(ctx, args): Promise<ToolResult> {
    const raw = typeof args.note === "string" ? args.note.trim().replace(/^note:/, "") : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return { summary: 'note must be a note id (or "note:<id>").' };
    const res = await readNoteText({ workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role }, raw);
    if (!res) return { summary: `No note ${raw} that you can read in this workspace.` };
    const links = res.note.links.map((l) => `${l.kind}:${l.id}${l.label ? ` (${l.label})` : ""}`).join(", ");
    const meta = [res.note.folder ? `folder ${res.note.folder}` : null, res.note.tags.length ? `tags ${res.note.tags.join(", ")}` : null, links ? `linked to ${links}` : null]
      .filter(Boolean)
      .join("; ");
    return {
      summary: `${res.title}${meta ? ` — ${meta}` : ""}${res.truncated ? " (first part)" : ""}:\n${res.text || "(empty note)"}`,
      details: { note: res.note, truncated: res.truncated },
    };
  },
};

export const create_note: ToolDef = {
  name: "create_note",
  description:
    "Write a new note in the Notes app for the person you work for (meeting notes, a summary, a to-do list). Body is plain text or light Markdown (# heading, - bullet, [ ] task). Optionally link it to records (\"deal:<id>\", \"lead:<id>\", …) so it shows on their pages. Private to that person unless share is \"workspace\".",
  kind: "publish",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short title (optional; the first line is used otherwise)." },
      body: { type: "string", description: "The note's text (plain text or light Markdown, up to 200,000 characters)." },
      links: { type: "array", description: 'Records to link, as "<kind>:<id>" strings (kinds as search_workspace returns them).', items: { type: "string" } },
      share: { type: "string", description: '"private" (default) or "workspace" (every member can read it; needs the editor role).' },
      folder: { type: "string", description: "Optional folder name." },
      tags: { type: "string", description: "Optional comma-separated tags." },
    },
    required: ["body"],
  },
  async execute(ctx, args): Promise<ToolResult> {
    const body = typeof args.body === "string" ? args.body : "";
    if (!body.trim()) return { summary: "A note needs a body." };
    const share = args.share === "workspace" ? "workspace" : "private";
    if (share === "workspace" && !roleAtLeast(ctx.role, "editor")) {
      return { summary: "Sharing a note with the workspace needs the editor role; write it as a private note instead." };
    }
    try {
      const note = await createNote({
        workspaceId: ctx.workspaceId,
        createdBy: ctx.userId,
        title: typeof args.title === "string" ? args.title : null,
        body,
        links: linksFrom(args.links),
        shareState: share,
        folder: typeof args.folder === "string" ? args.folder : null,
        tags: typeof args.tags === "string" ? args.tags : undefined,
        sourceRef: ctx.runId ? `agent:${ctx.runId}` : "agent",
        actor: "ai",
      });
      return {
        summary: `Saved the note "${note.title}"${note.links.length ? ` (linked to ${note.links.length} record${note.links.length === 1 ? "" : "s"})` : ""}: /dashboard/notes?note=${note.id}`,
        details: { note: { id: note.id, title: note.title, href: `/dashboard/notes?note=${note.id}`, shareState: note.shareState, links: note.links } },
      };
    } catch (err) {
      return { summary: `Could not save the note: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export const NOTE_TOOLS: readonly ToolDef[] = [read_note, create_note];
