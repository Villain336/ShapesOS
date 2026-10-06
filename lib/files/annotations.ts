// ShapesOS — Phase 18.2 (WS=content): PDF highlights and comments.
//
// Stored per file VERSION (workspace_file_annotations, FORCE RLS) — never
// burned into the PDF, so the file's bytes stay exactly what was uploaded and
// every version keeps its own notes. Positions are page-relative fractions
// (0..1), so they hold at any zoom. Exportable as JSON.
// Who: anyone who can see the file reads them; editors (file role) add;
// the author edits/removes their own, the file's owner any.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/api/errors";
import { fileCan } from "./acl";
import { requireFileAction, type FileActor } from "./access";

export const ANNOTATION_KINDS = ["highlight", "comment"] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];
export const MAX_RECTS = 64;
export const MAX_BODY = 5_000;
export const MAX_QUOTE = 2_000;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnnotationOut {
  id: string;
  fileId: string;
  fileVersion: number;
  page: number;
  kind: AnnotationKind;
  rects: Rect[];
  quote: string | null;
  body: string | null;
  authorId: string;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
}

/** PURE: page-relative rectangles, each inside the page (0..1), at most MAX_RECTS. */
export function normalizeRects(v: unknown): Rect[] {
  if (!Array.isArray(v) || v.length === 0) throw new BadRequestError("An annotation needs at least one rectangle.");
  if (v.length > MAX_RECTS) throw new BadRequestError(`At most ${MAX_RECTS} rectangles.`);
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return v.map((r) => {
    const o = r as Record<string, unknown>;
    const [x, y, w, h] = [o?.x, o?.y, o?.w, o?.h].map((n) => Number(n));
    if (![x, y, w, h].every((n) => Number.isFinite(n))) throw new BadRequestError("Rectangles are { x, y, w, h } numbers.");
    if (w! <= 0 || h! <= 0) throw new BadRequestError("Rectangles need a width and a height.");
    const rx = clamp(x!);
    const ry = clamp(y!);
    return { x: rx, y: ry, w: Math.min(clamp(w!), 1 - rx), h: Math.min(clamp(h!), 1 - ry) };
  });
}

function toOut(r: { id: string; fileId: string; fileVersion: number; page: number; kind: string; rects: unknown; quote: string | null; body: string | null; authorId: string; createdAt: Date; updatedAt: Date }, canEdit: boolean): AnnotationOut {
  return {
    id: r.id,
    fileId: r.fileId,
    fileVersion: r.fileVersion,
    page: r.page,
    kind: r.kind === "comment" ? "comment" : "highlight",
    rects: Array.isArray(r.rects) ? (r.rects as Rect[]) : [],
    quote: r.quote,
    body: r.body,
    authorId: r.authorId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    canEdit,
  };
}

async function versionExists(actor: FileActor, fileId: string, current: number, version: number): Promise<boolean> {
  if (version === current) return true;
  const n = await withWorkspaceScope(actor.workspaceId, (tx) => tx.workspaceFileVersion.count({ where: { workspaceId: actor.workspaceId, fileId, version } }));
  return n > 0;
}

export async function listAnnotations(actor: FileActor, fileId: string, version?: number): Promise<AnnotationOut[]> {
  const { file, role } = await requireFileAction(actor, fileId, "view");
  const v = version ?? file.version;
  const rows = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.workspaceFileAnnotation.findMany({ where: { workspaceId: actor.workspaceId, fileId, fileVersion: v }, orderBy: [{ page: "asc" }, { createdAt: "asc" }], take: 2_000 }),
  );
  return rows.map((r) => toOut(r, r.authorId === actor.userId || fileCan(role, "manageAccess")));
}

export interface CreateAnnotationInput {
  version?: number;
  page: number;
  kind: AnnotationKind;
  rects: unknown;
  quote?: string | null;
  body?: string | null;
}

export async function createAnnotation(actor: FileActor, fileId: string, input: CreateAnnotationInput): Promise<AnnotationOut> {
  const { file } = await requireFileAction(actor, fileId, "annotate");
  if (file.mimeType !== "application/pdf") throw new BadRequestError("Highlights and comments are for PDFs.");
  const version = input.version ?? file.version;
  if (!(await versionExists(actor, fileId, file.version, version))) throw new NotFoundError("That version doesn't exist.");
  if (!Number.isInteger(input.page) || input.page < 1 || input.page > 10_000) throw new BadRequestError("page is a page number.");
  if (!(ANNOTATION_KINDS as readonly string[]).includes(input.kind)) throw new BadRequestError("kind is highlight or comment.");
  const rects = normalizeRects(input.rects);
  const body = input.body?.trim() ? input.body.trim().slice(0, MAX_BODY) : null;
  if (input.kind === "comment" && !body) throw new BadRequestError("A comment needs text.");
  const quote = input.quote?.trim() ? input.quote.trim().slice(0, MAX_QUOTE) : null;
  const row = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.workspaceFileAnnotation.create({ data: { workspaceId: actor.workspaceId, fileId, fileVersion: version, page: input.page, kind: input.kind, rects: rects as unknown as object, quote, body, authorId: actor.userId } }),
  );
  return toOut(row, true);
}

async function loadOwned(actor: FileActor, fileId: string, id: string) {
  const { role } = await requireFileAction(actor, fileId, "view");
  const row = await withWorkspaceScope(actor.workspaceId, (tx) => tx.workspaceFileAnnotation.findFirst({ where: { id, workspaceId: actor.workspaceId, fileId } }));
  if (!row) throw new NotFoundError("Annotation not found.");
  if (row.authorId !== actor.userId && !fileCan(role, "manageAccess")) throw new ForbiddenError("Only its author or the file's owner can change it.");
  return row;
}

export async function updateAnnotation(actor: FileActor, fileId: string, id: string, body: string | null): Promise<AnnotationOut> {
  const row = await loadOwned(actor, fileId, id);
  const clean = body?.trim() ? body.trim().slice(0, MAX_BODY) : null;
  if (row.kind === "comment" && !clean) throw new BadRequestError("A comment needs text.");
  const updated = await withWorkspaceScope(actor.workspaceId, (tx) => tx.workspaceFileAnnotation.update({ where: { id, workspaceId: actor.workspaceId }, data: { body: clean } }));
  return toOut(updated, true);
}

export async function removeAnnotation(actor: FileActor, fileId: string, id: string): Promise<void> {
  await loadOwned(actor, fileId, id);
  await withWorkspaceScope(actor.workspaceId, (tx) => tx.workspaceFileAnnotation.deleteMany({ where: { id, workspaceId: actor.workspaceId, fileId } }));
}

/** Every version's annotations as a portable JSON document. */
export async function exportAnnotations(actor: FileActor, fileId: string): Promise<{ file: { id: string; filename: string; currentVersion: number }; exportedAt: string; annotations: Array<Omit<AnnotationOut, "canEdit" | "fileId">> }> {
  const { file } = await requireFileAction(actor, fileId, "view");
  const rows = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.workspaceFileAnnotation.findMany({ where: { workspaceId: actor.workspaceId, fileId }, orderBy: [{ fileVersion: "asc" }, { page: "asc" }, { createdAt: "asc" }] }),
  );
  return {
    file: { id: file.id, filename: file.filename, currentVersion: file.version },
    exportedAt: new Date().toISOString(),
    annotations: rows.map((r) => {
      const { canEdit: _c, fileId: _f, ...rest } = toOut(r, false);
      return rest;
    }),
  };
}
