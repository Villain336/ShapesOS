// ShapesOS — Phase 21B (WS=drive): the Files app's row model and file-type helpers
// (PURE, client-safe). Every list the app shows — a folder, Recents, Shared with me, the
// Trash, favourites, a tag, a smart folder — becomes the same Row, so one table and one set
// of bulk actions serve all of them.

export type RowKind = "file" | "folder";

export interface Row {
  kind: RowKind;
  id: string;
  name: string;
  /** Display path (system folders live under /shared). */
  path: string;
  mimeType: string | null;
  sizeBytes: number | null;
  /** ISO time shown in the "Date modified" column (trashed-on in the Trash, shared-on in Shared with me). */
  modifiedAt: string | null;
  version: number | null;
  tags: string[];
  color: string | null;
  system: boolean;
  favorite: boolean;
  canEdit: boolean;
  /** A secondary fact for the list: who shared it, where it came from. */
  note?: string;
}

export type FileClass = "folder" | "image" | "pdf" | "text" | "sheet" | "document" | "slides" | "audio" | "video" | "archive" | "other";

const SHEET = /\.(xlsx|xls|csv|tsv)$/i;
const DOC = /\.(docx|doc|rtf|odt)$/i;
const SLIDES = /\.(pptx|ppt|key|odp)$/i;

export function fileClass(row: Pick<Row, "kind" | "mimeType" | "name">): FileClass {
  if (row.kind === "folder") return "folder";
  const m = (row.mimeType ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (m === "application/zip" || /\.(zip|tar|gz|7z)$/i.test(row.name)) return "archive";
  if (m.includes("spreadsheet") || m === "text/csv" || SHEET.test(row.name)) return "sheet";
  if (m.includes("presentation") || SLIDES.test(row.name)) return "slides";
  if (m.includes("wordprocessing") || DOC.test(row.name)) return "document";
  if (m.startsWith("text/") || m === "application/json") return "text";
  return "other";
}

export type SortKey = "name" | "kind" | "size" | "modified";

/** Sort rows the way the server does for a folder (folders first, then by the key; name breaks ties). */
export function sortRows(rows: Row[], key: SortKey, dir: "asc" | "desc"): Row[] {
  const sign = dir === "desc" ? -1 : 1;
  const byName = (a: Row, b: Row) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), undefined, { numeric: true });
  const cmp = (a: Row, b: Row): number => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1; // folders always lead
    switch (key) {
      case "size":
        return sign * ((a.sizeBytes ?? -1) - (b.sizeBytes ?? -1)) || byName(a, b);
      case "modified":
        return sign * ((a.modifiedAt ?? "").localeCompare(b.modifiedAt ?? "")) || byName(a, b);
      case "kind":
        return sign * fileClass(a).localeCompare(fileClass(b)) || byName(a, b);
      default:
        return sign * byName(a, b);
    }
  };
  return [...rows].sort(cmp);
}

/** Case-insensitive filter by name, path or tag. */
export function filterRows(rows: Row[], q: string): Row[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(needle) || r.tags.some((t) => t.toLowerCase().includes(needle)));
}

export interface ApiItem {
  kind: RowKind;
  id: string;
  name: string;
  path: string;
  mimeType: string | null;
  sizeBytes: number | null;
  version: number | null;
  updatedAt: string;
  tags: string[];
  color: string | null;
  system: boolean;
  favorite: boolean;
  canEdit: boolean;
}

export const rowFromItem = (i: ApiItem, note?: string): Row => ({
  kind: i.kind, id: i.id, name: i.name, path: i.path, mimeType: i.mimeType, sizeBytes: i.sizeBytes, modifiedAt: i.updatedAt,
  version: i.version, tags: i.tags, color: i.color, system: i.system, favorite: i.favorite, canEdit: i.canEdit, note,
});

export interface ApiTrashItem { kind: RowKind; id: string; name: string; path: string; sizeBytes: number | null; trashedAt: string }
export const rowFromTrash = (i: ApiTrashItem): Row => ({
  kind: i.kind, id: i.id, name: i.name, path: i.path, mimeType: null, sizeBytes: i.sizeBytes, modifiedAt: i.trashedAt,
  version: null, tags: [], color: null, system: false, favorite: false, canEdit: true,
});

export interface ApiSharedItem { kind: RowKind; id: string; name: string; path: string; role: string; sharedBy: string; sharedAt: string; inPrivateHome: boolean }
export const rowFromShared = (i: ApiSharedItem): Row => ({
  kind: i.kind, id: i.id, name: i.name, path: i.path, mimeType: null, sizeBytes: null, modifiedAt: i.sharedAt,
  version: null, tags: [], color: null, system: false, favorite: false, canEdit: i.role !== "viewer", note: i.role,
});

/** Where a folder row navigates to; a file row opens in its parent. */
export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

/** Human size, 1 decimal, binary units. */
export function fmtSize(n: number | null): string {
  if (n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
