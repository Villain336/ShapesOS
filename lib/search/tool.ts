// ShapesOS — Phase 18.1 (WS=find): search_workspace, the agents' Spotlight.
//
// One index for people and agents: this tool calls the SAME spotlight()
// function ⌘K uses (lib/search/records.ts), as the person the agent works
// for — same role gates, same per-source visibility (their own chats only,
// no draft apps for a viewer), same ranking. Read-only (kind "safe", Tier 0:
// TOOL_ACTION "search_workspace"; the description avoids every Tier-3 word).
//
// With `record: "<kind>:<id>"` it reads one result: the text inside a file
// or Office doc (what "Ask about this" in ⌘K hands the agent), or a ticket's
// latest messages.

import type { ToolDef, ToolResult } from "@/lib/chat/tools";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { RECORD_KINDS, type RecordKind } from "./kinds";
import { RECORD_MIN_ROLE, spotlight } from "./records";
import { roleAtLeast } from "@/lib/authz";
import { storedText } from "./text-index";

const MAX_RESULTS = 25;

function parseKinds(v: unknown): RecordKind[] | undefined {
  const list = (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [])
    .map((s) => String(s).trim())
    .filter((s): s is RecordKind => (RECORD_KINDS as readonly string[]).includes(s));
  return list.length ? list : undefined;
}

/** "file:abc" → { kind, id } (only known kinds, safe ids). */
export function parseRecordRef(v: unknown): { kind: RecordKind; id: string } | null {
  if (typeof v !== "string") return null;
  const m = /^([a-z_]+):([A-Za-z0-9_-]{1,64})$/.exec(v.trim());
  if (!m || !(RECORD_KINDS as readonly string[]).includes(m[1]!)) return null;
  return { kind: m[1] as RecordKind, id: m[2]! };
}

async function readRecord(ctx: { workspaceId: string; userId?: string; role?: import("@prisma/client").WorkspaceRole }, ref: { kind: RecordKind; id: string }): Promise<ToolResult> {
  // Phase 18.2 (WS=content): a note, as the person the agent works for sees it.
  if (ref.kind === "note") {
    if (!ctx.userId || !ctx.role) return { summary: "Reading a note needs the person the agent works for." };
    const { read_note } = await import("@/lib/notes/tools");
    return read_note.execute(ctx as Parameters<typeof read_note.execute>[0], { note: ref.id });
  }
  if (ref.kind === "file" || ref.kind === "file_content" || ref.kind === "doc") {
    const isDoc = ref.kind === "doc";
    const meta = await withWorkspaceScope(ctx.workspaceId, async (tx) =>
      isDoc
        ? tx.univerDoc.findFirst({ where: { id: ref.id, workspaceId: ctx.workspaceId }, select: { title: true, kind: true } })
        : tx.workspaceFile.findFirst({ where: { id: ref.id, workspaceId: ctx.workspaceId, trashedAt: null }, select: { filename: true, logicalPath: true, mimeType: true } }),
    );
    // Content kinds can be either a file or a doc: fall back to the doc.
    if (!meta && ref.kind === "file_content") return readRecord(ctx, { kind: "doc", id: ref.id });
    if (!meta) return { summary: `No ${ref.kind} ${ref.id} in this workspace.` };
    const text = await storedText(ctx.workspaceId, isDoc ? { univerDocId: ref.id } : { fileId: ref.id });
    const name = "title" in meta ? meta.title : meta.filename;
    if (!text || !text.text) {
      return { summary: `${name}: no extracted text (${text?.status ?? "not indexed yet"}).`, details: { record: ref, meta } };
    }
    return {
      summary: `${name}${text.truncated ? " (first part)" : ""}:\n${text.text}`,
      details: { record: ref, meta, truncated: text.truncated },
    };
  }
  if (ref.kind === "ticket") {
    const t = await withWorkspaceScope(ctx.workspaceId, (tx) =>
      tx.opsTicket.findFirst({
        where: { id: ref.id, workspaceId: ctx.workspaceId },
        select: { number: true, subject: true, status: true, priority: true, requesterEmail: true, messages: { orderBy: { createdAt: "desc" }, take: 5, select: { direction: true, body: true, createdAt: true } } },
      }),
    );
    if (!t) return { summary: `No ticket ${ref.id} in this workspace.` };
    const thread = t.messages
      .reverse()
      .map((m) => `[${m.direction} ${m.createdAt.toISOString().slice(0, 16)}] ${m.body.slice(0, 1200)}`)
      .join("\n");
    return { summary: `Ticket #${t.number} ${t.subject} (${t.status}, ${t.priority}) from ${t.requesterEmail ?? "unknown"}:\n${thread}`, details: { record: ref } };
  }
  return { summary: `Use search_workspace with a query to find this ${ref.kind}; reading it by id is supported for files, docs, notes and tickets.` };
}

export const search_workspace: ToolDef = {
  name: "search_workspace",
  description:
    "Find anything in this workspace the way a person does with Cmd+K: records by name, the words inside uploaded files and Office docs, chats, conversations, contacts, companies, tickets, deals and more, also by meaning. Returns titles, links and snippets. Pass record \"<kind>:<id>\" to read one result's text.",
  kind: "safe",
  minRole: "viewer",
  argsSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: 'What to look for. Supports "exact phrases", -excluded words, and kind:file / in:tickets filters.' },
      kinds: { type: "string", description: `Optional comma list of kinds: ${RECORD_KINDS.join(", ")}.` },
      limit: { type: "number", description: `Results per kind (1-10, default 5); at most ${MAX_RESULTS} in total.` },
      record: { type: "string", description: 'Read one result instead, e.g. "file_content:<id>" or "ticket:<id>".' },
    },
  },
  async execute(ctx, args): Promise<ToolResult> {
    const ref = parseRecordRef(args.record);
    if (args.record !== undefined && args.record !== null && args.record !== "") {
      if (!ref) return { summary: `record must look like "<kind>:<id>" with a known kind.` };
      // Reading by id respects the same role gate as finding it.
      if (!roleAtLeast(ctx.role, RECORD_MIN_ROLE[ref.kind])) return { summary: `Your role can't read ${ref.kind} records.` };
      return readRecord(ctx, ref);
    }
    const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 5), 1), 10);
    const result = await spotlight(ctx.workspaceId, ctx.role, args.query, {
      perKind: limit,
      kinds: parseKinds(args.kinds),
      userId: ctx.userId,
      semantic: "wait",
    });
    if (!result.query) return { summary: "Give a query of at least 2 characters." };
    const hits = result.hits.slice(0, MAX_RESULTS);
    if (hits.length === 0) return { summary: `No matches for "${result.query.raw}".`, details: { results: [], semantic: result.semantic } };
    const lines = hits.map(
      (h) =>
        `- [${h.kind}] ${h.title}${h.subtitle ? ` — ${h.subtitle}` : ""} (${h.href}; record ${h.kind}:${h.id}; matched ${h.match.join("+")})${h.snippet ? `\n  “${h.snippet.replace(/[⟦⟧]/g, "")}”` : ""}`,
    );
    return {
      summary: `${hits.length} result${hits.length === 1 ? "" : "s"} for "${result.query.raw}":\n${lines.join("\n")}`,
      details: {
        semantic: result.semantic,
        results: hits.map((h) => ({ kind: h.kind, id: h.id, title: h.title, subtitle: h.subtitle, href: h.href, score: h.score, match: h.match, snippet: h.snippet })),
      },
    };
  },
};
