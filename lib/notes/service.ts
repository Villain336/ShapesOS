// ShapesOS — Phase 18.2 (WS=content): Notes (server only).
//
// THE DOC-STORE DECISION. A note is a UniverDoc row of kind "note" whose
// snapshot is the Tiptap block editor's JSON (lib/notes/content.ts). Office
// docs already live in univer_docs with a version counter, share state,
// provenance (source_ref), Spotlight text indexing (search_texts) and FORCE
// RLS; the block editor (components/block-editor) has no store of its own —
// its other users save into their own feature rows (newsletter templates,
// report templates). So notes reuse univer_docs instead of adding a third
// document store, and gain the same version history (lib/univer/versions.ts)
// and live collaboration (lib/collab) as docs. The Office functions in
// lib/univer/docs.ts only ever see the Office kinds (sheet | doc | slide).
//
// VISIBILITY. share_state "private" = the person who made it (and agents
// working for them) only; "workspace" = every member. Editing a shared note
// needs editor+; its maker can always edit it. Deleting: the maker or admin+.
//
// createNote() is THE server API other features write notes through — the
// Meet app's meeting summaries (WS=comms), the voice-note route, the agents'
// create_note tool:
//
//   await createNote({
//     workspaceId, createdBy: userId,
//     title: "Weekly sync — decisions",          // optional (derived from body)
//     body: "# Decisions\n- Ship Friday\n[ ] Ana: draft the post",  // text / light Markdown
//     links: [{ kind: "deal", id: dealId, label: "Acme renewal" }], // optional
//     shareState: "workspace",                    // optional, default "private"
//     sourceRef: "meet:<meetingId>",              // optional provenance
//   });
//
// It validates everything, writes under the tenant scope, indexes the text
// for Spotlight and audits "note_created". `content` (Tiptap JSON) may be
// passed instead of `body`.

import { isUnlinkableKind, UNLINKABLE_REASON } from "./linkable";
import type { Prisma, WorkspaceRole } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { roleAtLeast } from "@/lib/authz";
import { auditEvent } from "@/lib/auditlog";
import { RECORD_KINDS, type RecordKind } from "@/lib/search/kinds";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "@/lib/api/errors";
import {
  NOTE_KIND,
  NOTE_TITLE_MAX,
  deriveNoteTitle,
  emptyNoteDoc,
  normalizeFolder,
  normalizeTags,
  noteText,
  textToNoteDoc,
  validateNoteDoc,
  type NoteDoc,
} from "./content";
import { snapshotBeforeSave } from "@/lib/univer/versions";
// The light write hook: the indexer (and its embedder) loads only when the
// job runs, after the response — never in a route bundle (bundle-size rule).
import { scheduleUniverDocTextIndex as scheduleDocTextIndex } from "@/lib/search/text-index-schedule";

type Tx = Prisma.TransactionClient;

export const NOTE_SHARE_STATES = ["private", "workspace"] as const;
export type NoteShareState = (typeof NOTE_SHARE_STATES)[number];
export const NOTE_LINKS_MAX = 25;
const RECORD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Personal kinds a note never links to: lib/notes/linkable.ts (re-exported).
export { UNLINKABLE_KINDS } from "./linkable";

export interface NoteActor {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export interface NoteLinkInput {
  kind: string;
  id: string;
  label?: string | null;
}

export interface NoteLinkOut {
  kind: RecordKind;
  id: string;
  label: string | null;
}

export interface NoteSummary {
  id: string;
  title: string;
  preview: string;
  shareState: NoteShareState;
  pinned: boolean;
  folder: string | null;
  tags: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  sourceRef: string | null;
  links: NoteLinkOut[];
  canEdit: boolean;
  canDelete: boolean;
  /** May change who sees it (private ↔ workspace). */
  canShare: boolean;
}

export interface NoteDetail extends NoteSummary {
  content: NoteDoc;
}

type NoteRow = {
  id: string;
  workspaceId: string;
  title: string;
  snapshot: unknown;
  version: number;
  shareState: string;
  pinnedAt: Date | null;
  folder: string | null;
  tags: string[];
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  sourceRef: string | null;
  noteLinks?: Array<{ recordKind: string; recordId: string; label: string | null }>;
};

const NOTE_SELECT = {
  id: true,
  workspaceId: true,
  title: true,
  snapshot: true,
  version: true,
  shareState: true,
  pinnedAt: true,
  folder: true,
  tags: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  sourceRef: true,
  noteLinks: { select: { recordKind: true, recordId: true, label: true }, orderBy: { createdAt: "asc" as const } },
} as const;

function shareOf(v: string): NoteShareState {
  return v === "private" ? "private" : "workspace";
}

/** PURE: may this person read the note? */
export function canReadNote(note: { shareState: string; createdBy: string | null }, actor: Pick<NoteActor, "userId">): boolean {
  return note.shareState !== "private" || note.createdBy === actor.userId;
}

/** PURE: may this person change the note's content? */
export function canEditNote(note: { shareState: string; createdBy: string | null }, actor: Pick<NoteActor, "userId" | "role">): boolean {
  if (note.createdBy === actor.userId) return true;
  return note.shareState !== "private" && roleAtLeast(actor.role, "editor");
}

/** PURE: may this person delete the note? */
export function canDeleteNote(note: { shareState: string; createdBy: string | null }, actor: Pick<NoteActor, "userId" | "role">): boolean {
  if (note.createdBy === actor.userId) return true;
  return note.shareState !== "private" && roleAtLeast(actor.role, "admin");
}

/** PURE: may this person change who can see the note? (Sharing adds to the workspace: editor+.) */
export function canShareNote(note: { createdBy: string | null }, actor: Pick<NoteActor, "userId" | "role">): boolean {
  if (roleAtLeast(actor.role, "admin")) return true;
  return note.createdBy === actor.userId && roleAtLeast(actor.role, "editor");
}

/** The Prisma filter for "notes this person can see". */
function visibleWhere(actor: NoteActor): Prisma.UniverDocWhereInput {
  return {
    workspaceId: actor.workspaceId,
    kind: NOTE_KIND,
    OR: [{ shareState: { not: "private" } }, { createdBy: actor.userId }],
  };
}

function toSummary(row: NoteRow, actor: Pick<NoteActor, "userId" | "role">): NoteSummary {
  const text = noteText(row.snapshot, 600);
  return {
    id: row.id,
    title: row.title,
    preview: text.split("\n").filter((l) => l.trim()).slice(0, 3).join(" · ").slice(0, 200),
    shareState: shareOf(row.shareState),
    pinned: row.pinnedAt !== null,
    folder: row.folder,
    tags: row.tags,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    sourceRef: row.sourceRef,
    links: (row.noteLinks ?? [])
      .filter((l) => (RECORD_KINDS as readonly string[]).includes(l.recordKind))
      .map((l) => ({ kind: l.recordKind as RecordKind, id: l.recordId, label: l.label })),
    canEdit: canEditNote(row, actor),
    canDelete: canDeleteNote(row, actor),
    canShare: canShareNote(row, actor),
  };
}

function toDetail(row: NoteRow, actor: Pick<NoteActor, "userId" | "role">): NoteDetail {
  const v = validateNoteDoc(row.snapshot);
  return { ...toSummary(row, actor), content: v.ok ? v.doc : emptyNoteDoc() };
}

/** Validate + normalize record links (known kinds, safe ids, deduplicated, bounded). */
export function normalizeLinks(links: unknown): Array<{ kind: RecordKind; id: string; label: string | null }> {
  if (links === undefined || links === null) return [];
  if (!Array.isArray(links)) throw new BadRequestError("links must be a list.");
  const out: Array<{ kind: RecordKind; id: string; label: string | null }> = [];
  for (const l of links) {
    const kind = String((l as NoteLinkInput)?.kind ?? "");
    const id = String((l as NoteLinkInput)?.id ?? "");
    if (!(RECORD_KINDS as readonly string[]).includes(kind)) throw new BadRequestError(`Unknown record kind "${kind.slice(0, 40)}".`);
    if (isUnlinkableKind(kind)) throw new BadRequestError(UNLINKABLE_REASON[kind as RecordKind] ?? "That record is personal, so a note can't link to it.");
    if (!RECORD_ID_RE.test(id)) throw new BadRequestError("A record id is 1-64 letters, digits, - or _.");
    const rawLabel = (l as NoteLinkInput)?.label;
    const label = typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.replace(/\s+/g, " ").trim().slice(0, 200) : null;
    if (!out.some((o) => o.kind === kind && o.id === id)) out.push({ kind: kind as RecordKind, id, label });
  }
  if (out.length > NOTE_LINKS_MAX) throw new BadRequestError(`A note links at most ${NOTE_LINKS_MAX} records.`);
  return out;
}

function cleanTitle(title: string | null | undefined, content: NoteDoc): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  if (t.length > NOTE_TITLE_MAX) throw new BadRequestError(`A title is at most ${NOTE_TITLE_MAX} characters.`);
  return t || deriveNoteTitle(noteText(content, 2_000));
}

export interface CreateNoteInput {
  workspaceId: string;
  /** The person the note belongs to (an agent's note belongs to the person it works for). */
  createdBy: string;
  title?: string | null;
  /** Plain text / light Markdown (see textToNoteDoc). */
  body?: string | null;
  /** Tiptap JSON instead of body. */
  content?: unknown;
  links?: NoteLinkInput[];
  shareState?: NoteShareState;
  folder?: string | null;
  tags?: string[] | string;
  pinned?: boolean;
  /** Provenance, e.g. "meet:<id>", "voice", "agent:<runId>". */
  sourceRef?: string | null;
  /** Audit actor: "ai" when an agent wrote it. */
  actor?: "user" | "ai";
}

/** Create a note (THE server API; see the header). */
export async function createNote(input: CreateNoteInput): Promise<NoteDetail> {
  if (!input.workspaceId) throw new BadRequestError("workspaceId is required.");
  if (!input.createdBy) throw new BadRequestError("createdBy is required.");
  let content: NoteDoc;
  if (input.content !== undefined && input.content !== null) {
    const v = validateNoteDoc(input.content);
    if (!v.ok) throw new BadRequestError(`Invalid note: ${v.error}.`);
    content = v.doc;
  } else {
    const body = String(input.body ?? "");
    if (body.length > 200_000) throw new BadRequestError("A note body is at most 200,000 characters.");
    content = body.trim() ? textToNoteDoc(body) : emptyNoteDoc();
    const v = validateNoteDoc(content);
    if (!v.ok) throw new BadRequestError(`Invalid note: ${v.error}.`);
  }
  const title = cleanTitle(input.title, content);
  const links = normalizeLinks(input.links);
  const shareState: NoteShareState = input.shareState && (NOTE_SHARE_STATES as readonly string[]).includes(input.shareState) ? input.shareState : "private";
  const actor = { workspaceId: input.workspaceId, userId: input.createdBy, role: "owner" as WorkspaceRole };
  const row = await withWorkspaceScope(input.workspaceId, async (tx) => {
    const created = await tx.univerDoc.create({
      data: {
        workspaceId: input.workspaceId,
        kind: NOTE_KIND,
        title,
        snapshot: content as unknown as Prisma.InputJsonValue,
        shareState,
        createdBy: input.createdBy,
        sourceRef: input.sourceRef ? String(input.sourceRef).slice(0, 200) : null,
        folder: normalizeFolder(input.folder),
        tags: normalizeTags(input.tags),
        pinnedAt: input.pinned ? new Date() : null,
      },
      select: { id: true },
    });
    if (links.length) {
      await tx.noteLink.createMany({
        data: links.map((l) => ({ workspaceId: input.workspaceId, docId: created.id, recordKind: l.kind, recordId: l.id, label: l.label, createdBy: input.createdBy })),
        skipDuplicates: true,
      });
    }
    return tx.univerDoc.findFirstOrThrow({ where: { id: created.id, workspaceId: input.workspaceId }, select: NOTE_SELECT });
  });
  scheduleDocTextIndex(input.workspaceId, row.id);
  await auditEvent({
    workspaceId: input.workspaceId,
    projectId: null,
    action: "note_created",
    summary: `Note "${title.slice(0, 120)}" created${links.length ? ` (linked to ${links.length} record${links.length === 1 ? "" : "s"})` : ""}`,
    actorUserId: input.createdBy,
    actor: input.actor ?? "user",
  }).catch(() => undefined);
  // The maker sees their own note with full rights (the role only matters for others' notes).
  return toDetail(row as NoteRow, actor);
}

async function loadVisible(tx: Tx, actor: NoteActor, id: string): Promise<NoteRow | null> {
  const row = await tx.univerDoc.findFirst({ where: { workspaceId: actor.workspaceId, ...visibleWhere(actor), id }, select: NOTE_SELECT });
  return (row as NoteRow | null) ?? null;
}

/** One note, when this person can see it (null otherwise — never an oracle). */
export async function getNote(actor: NoteActor, id: string): Promise<NoteDetail | null> {
  const row = await withWorkspaceScope(actor.workspaceId, (tx) => loadVisible(tx, actor, id));
  return row ? toDetail(row, actor) : null;
}

/**
 * Phase 18.3 (WS=flow): the note this person already made from one offline
 * write carrying a client id (sourceRef "client:<clientId>"), so a replayed create returns it
 * instead of writing a second note (lib/offline/queue.ts).
 */
export async function findOwnNoteBySourceRef(actor: NoteActor, sourceRef: string): Promise<NoteDetail | null> {
  const row = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.univerDoc.findFirst({ where: { workspaceId: actor.workspaceId, kind: NOTE_KIND, createdBy: actor.userId, sourceRef }, select: NOTE_SELECT }),
  );
  return row ? toDetail(row as NoteRow, actor) : null;
}

export interface ListNotesOptions {
  q?: string | null;
  pinned?: boolean;
  folder?: string | null;
  tag?: string | null;
  /** Only the notes linked to this record. */
  record?: { kind: string; id: string } | null;
  /** "mine" = notes I made; "shared" = the workspace's shared notes; default both. */
  scope?: "mine" | "shared" | "all";
  limit?: number;
}

/** Pinned first, then most recently changed. */
export async function listNotes(actor: NoteActor, opts: ListNotesOptions = {}): Promise<NoteSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 300);
  const and: Prisma.UniverDocWhereInput[] = [visibleWhere(actor)];
  if (opts.scope === "mine") and.push({ createdBy: actor.userId });
  if (opts.scope === "shared") and.push({ shareState: { not: "private" } });
  if (opts.pinned) and.push({ pinnedAt: { not: null } });
  const folder = opts.folder ? normalizeFolder(opts.folder) : null;
  if (folder) and.push({ folder });
  const tag = opts.tag ? normalizeTags([opts.tag])[0] : undefined;
  if (tag) and.push({ tags: { has: tag } });
  if (opts.record) {
    const [link] = normalizeLinks([opts.record]);
    and.push({ noteLinks: { some: { workspaceId: actor.workspaceId, recordKind: link!.kind, recordId: link!.id } } });
  }
  const q = (opts.q ?? "").trim().slice(0, 200);
  if (q) and.push({ title: { contains: q, mode: "insensitive" } });
  const rows = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.univerDoc.findMany({
      where: { workspaceId: actor.workspaceId, AND: and },
      orderBy: [{ pinnedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
      take: limit,
      select: NOTE_SELECT,
    }),
  );
  return (rows as NoteRow[]).map((r) => toSummary(r, actor));
}

/** The folders and tags in use among the notes this person can see. */
export async function noteFacets(actor: NoteActor): Promise<{ folders: string[]; tags: string[] }> {
  const rows = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.univerDoc.findMany({ where: { workspaceId: actor.workspaceId, ...visibleWhere(actor) }, select: { folder: true, tags: true }, take: 2_000 }),
  );
  const folders = new Set<string>();
  const tags = new Set<string>();
  for (const r of rows) {
    if (r.folder) folders.add(r.folder);
    for (const t of r.tags) tags.add(t);
  }
  return { folders: [...folders].sort((a, b) => a.localeCompare(b)), tags: [...tags].sort() };
}

export interface UpdateNoteInput {
  title?: string | null;
  content?: unknown;
  /** Optimistic concurrency: the version the editor last saw (409 when stale). */
  expectedVersion?: number;
  pinned?: boolean;
  folder?: string | null;
  tags?: string[] | string;
  shareState?: NoteShareState;
}

export async function updateNote(actor: NoteActor, id: string, input: UpdateNoteInput): Promise<NoteDetail> {
  const row = await withWorkspaceScope(actor.workspaceId, async (tx) => {
    const note = await loadVisible(tx, actor, id);
    if (!note) throw new NotFoundError("Note not found.");
    const changesContent = input.content !== undefined || (input.title !== undefined && input.title !== null);
    const changesMeta = input.folder !== undefined || input.tags !== undefined || input.pinned !== undefined;
    if ((changesContent || changesMeta) && !canEditNote(note, actor)) throw new ForbiddenError("You can read this note but not change it.");
    if (input.shareState !== undefined && input.shareState !== shareOf(note.shareState) && !canShareNote(note, actor)) {
      throw new ForbiddenError("Only the note's maker (editor or above) or an admin can change who sees it.");
    }
    const data: Prisma.UniverDocUpdateInput = {};
    if (input.content !== undefined) {
      const v = validateNoteDoc(input.content);
      if (!v.ok) throw new BadRequestError(`Invalid note: ${v.error}.`);
      if (input.expectedVersion !== undefined && input.expectedVersion !== note.version) {
        throw new ConflictError(`This note changed since you opened it (version ${note.version}, you had ${input.expectedVersion}). Reload to see the latest.`);
      }
      await snapshotBeforeSave(tx, { ...note, snapshot: note.snapshot }, actor.userId);
      data.snapshot = v.doc as unknown as Prisma.InputJsonValue;
      data.version = { increment: 1 };
    }
    if (input.title !== undefined && input.title !== null) {
      const content = input.content !== undefined ? (input.content as NoteDoc) : ((validateNoteDoc(note.snapshot) as { doc?: NoteDoc }).doc ?? emptyNoteDoc());
      data.title = cleanTitle(input.title, content);
    }
    if (input.pinned !== undefined) data.pinnedAt = input.pinned ? (note.pinnedAt ?? new Date()) : null;
    if (input.folder !== undefined) data.folder = normalizeFolder(input.folder);
    if (input.tags !== undefined) data.tags = normalizeTags(input.tags);
    if (input.shareState !== undefined) {
      if (!(NOTE_SHARE_STATES as readonly string[]).includes(input.shareState)) throw new BadRequestError("shareState is private or workspace.");
      data.shareState = input.shareState;
    }
    if (Object.keys(data).length === 0) return note;
    await tx.univerDoc.update({ where: { id, workspaceId: actor.workspaceId }, data });
    return (await loadVisible(tx, actor, id))!;
  });
  if (input.content !== undefined || input.title !== undefined) scheduleDocTextIndex(actor.workspaceId, id);
  return toDetail(row, actor);
}

export async function deleteNote(actor: NoteActor, id: string): Promise<void> {
  await withWorkspaceScope(actor.workspaceId, async (tx) => {
    const note = await loadVisible(tx, actor, id);
    if (!note) throw new NotFoundError("Note not found.");
    if (!canDeleteNote(note, actor)) throw new ForbiddenError("Only the note's maker or an admin can delete it.");
    // Cascades: note_links, univer_doc_versions, collab state, search_texts.
    await tx.univerDoc.delete({ where: { id, workspaceId: actor.workspaceId } });
  });
}

/** Link a note to a record (idempotent). Linking changes the note: edit rights needed. */
export async function linkNote(actor: NoteActor, id: string, link: NoteLinkInput): Promise<NoteDetail> {
  const [l] = normalizeLinks([link]);
  const row = await withWorkspaceScope(actor.workspaceId, async (tx) => {
    const note = await loadVisible(tx, actor, id);
    if (!note) throw new NotFoundError("Note not found.");
    if (!canEditNote(note, actor)) throw new ForbiddenError("You can read this note but not change it.");
    const count = await tx.noteLink.count({ where: { workspaceId: actor.workspaceId, docId: id } });
    const exists = await tx.noteLink.findFirst({ where: { workspaceId: actor.workspaceId, docId: id, recordKind: l!.kind, recordId: l!.id }, select: { id: true } });
    if (!exists) {
      if (count >= NOTE_LINKS_MAX) throw new BadRequestError(`A note links at most ${NOTE_LINKS_MAX} records.`);
      await tx.noteLink.create({ data: { workspaceId: actor.workspaceId, docId: id, recordKind: l!.kind, recordId: l!.id, label: l!.label, createdBy: actor.userId } });
    }
    return (await loadVisible(tx, actor, id))!;
  });
  return toDetail(row, actor);
}

export async function unlinkNote(actor: NoteActor, id: string, kind: string, recordId: string): Promise<NoteDetail> {
  const row = await withWorkspaceScope(actor.workspaceId, async (tx) => {
    const note = await loadVisible(tx, actor, id);
    if (!note) throw new NotFoundError("Note not found.");
    if (!canEditNote(note, actor)) throw new ForbiddenError("You can read this note but not change it.");
    await tx.noteLink.deleteMany({ where: { workspaceId: actor.workspaceId, docId: id, recordKind: kind, recordId } });
    return (await loadVisible(tx, actor, id))!;
  });
  return toDetail(row, actor);
}

/** For a version-history or collab route: the note row's access, or null. */
export async function noteAccess(actor: NoteActor, id: string): Promise<{ canRead: true; canEdit: boolean; title: string; version: number } | null> {
  const row = await withWorkspaceScope(actor.workspaceId, (tx) => loadVisible(tx, actor, id));
  if (!row) return null;
  return { canRead: true, canEdit: canEditNote(row, actor), title: row.title, version: row.version };
}

/** The note's plain text for agents (read_note) — bounded. */
export async function readNoteText(actor: NoteActor, id: string, maxChars = 12_000): Promise<{ title: string; text: string; truncated: boolean; note: NoteSummary } | null> {
  const row = await withWorkspaceScope(actor.workspaceId, (tx) => loadVisible(tx, actor, id));
  if (!row) return null;
  const full = noteText(row.snapshot, maxChars + 1);
  return { title: row.title, text: full.slice(0, maxChars), truncated: full.length > maxChars, note: toSummary(row, actor) };
}
