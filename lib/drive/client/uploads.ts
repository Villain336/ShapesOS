// ShapesOS — Phase 21B (WS=drive): upload planning on the client (PURE): turn a pick or a drop —
// files, or whole folders — into jobs with their relative folder paths, and split a big file into parts.
// The network side is components/drive/uploader.ts.

export interface UploadJob {
  file: File;
  /** "MyFolder/sub/a.txt" for a file inside a picked or dropped folder; null for a loose file. */
  relativePath: string | null;
}

/** Jobs from an <input type=file> (webkitdirectory gives webkitRelativePath) or any File list. */
export function jobsFromFiles(files: ArrayLike<File>): UploadJob[] {
  return Array.from(files).map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    return { file, relativePath: rel && rel.includes("/") ? rel : null };
  });
}

// The slice of the FileSystem Entries API we use (drag and drop of folders).
interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(cb: (f: File) => void, err: (e: unknown) => void): void;
  createReader?(): { readEntries(cb: (e: FsEntry[]) => void, err: (e: unknown) => void): void };
}

async function readAll(reader: { readEntries(cb: (e: FsEntry[]) => void, err: (e: unknown) => void): void }): Promise<FsEntry[]> {
  const out: FsEntry[] = [];
  for (;;) {
    const batch = await new Promise<FsEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (batch.length === 0) return out;
    out.push(...batch);
  }
}

/** `parent` is the folder path above this entry ("" at the top). A file in a folder gets "Folder/sub/name". */
async function walk(entry: FsEntry, parent: string, out: UploadJob[], budget: { left: number }): Promise<void> {
  if (budget.left <= 0) return;
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((res, rej) => entry.file!(res, rej));
    budget.left--;
    out.push({ file, relativePath: parent ? `${parent}/${entry.name}` : null });
    return;
  }
  if (entry.isDirectory && entry.createReader) {
    const here = parent ? `${parent}/${entry.name}` : entry.name;
    const kids = await readAll(entry.createReader());
    for (const k of kids) await walk(k, here, out, budget);
  }
}

/** Jobs from a drop: folders are walked (a folder's name becomes the first path segment). At most `max` files. */
export async function jobsFromDrop(dt: { items?: ArrayLike<{ kind: string; webkitGetAsEntry?: () => FsEntry | null }>; files?: ArrayLike<File> }, max = 2000): Promise<UploadJob[]> {
  const out: UploadJob[] = [];
  const budget = { left: max };
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = items.filter((i) => i.kind === "file").map((i) => i.webkitGetAsEntry?.() ?? null);
  if (entries.length && entries.every((e) => e)) {
    for (const e of entries as FsEntry[]) await walk(e, "", out, budget);
    return out;
  }
  return jobsFromFiles(dt.files ?? []).slice(0, max);
}

/** Byte ranges of the parts of a file ([start, end) pairs). */
export function partRanges(size: number, partSize: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let s = 0; s < size; s += partSize) out.push([s, Math.min(s + partSize, size)]);
  return out;
}

/** Files up to this size use the single-request upload; bigger ones the resumable one (when storage supports it). */
export const DIRECT_UPLOAD_MAX = 8 * 1024 * 1024;

export type UploadStatus = "queued" | "uploading" | "done" | "failed" | "skipped";

export interface UploadProgress {
  id: number;
  name: string;
  size: number;
  sent: number;
  status: UploadStatus;
  error?: string;
}

/** Overall percentage (0-100) of a batch. */
export function batchPercent(items: UploadProgress[]): number {
  const total = items.reduce((n, i) => n + i.size, 0);
  if (total === 0) return items.length ? 100 : 0;
  const sent = items.reduce((n, i) => n + (i.status === "done" ? i.size : Math.min(i.sent, i.size)), 0);
  return Math.min(100, Math.round((sent / total) * 100));
}
