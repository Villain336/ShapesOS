// ShapesOS — Phase 21B (WS=drive): the Google Drive FileProvider — the existing
// read-only connector upgraded to read AND write. UNVERIFIED-LIVE: it is proven
// here against a labelled mock of the Drive API (__tests__/mock-drive-api.ts),
// never against Google.
//
// How the path model maps onto Drive's id model:
//   - a path is resolved one segment at a time by listing the parent folder and
//     comparing names case/NFC-insensitively (the same rule as the native store);
//     Drive allows two items with one name in a folder, so an ambiguous name is
//     refused with `conflict` rather than guessed;
//   - writes create/replace content with the simple upload (up to 5 MB; larger
//     files are `unsupported` until the resumable upload is wired);
//   - remove = trash (Drive's trash keeps it for 30 days); permanent deletion of
//     a folder exists only as the Tier-3 connector tool delete_folder;
//   - the change feed (changes.list) reports only the LATEST state of each item,
//     so a create followed by a rename arrives as one change; whether a change is a
//     create, update or move is inferred from the paths this instance has seen.
// Google-native documents (Docs, Sheets …) are listed but cannot be read as bytes.
//
// Write calls need the `drive` OAuth scope: with drive.readonly they fail `forbidden`.

import { collisionKey } from "../../filesystem/paths";
import { ConnectorApiError, type LiveDeps, type TokenSource } from "@/lib/connectors/m21/live/http";
import {
  DRIVE_SIMPLE_UPLOAD_MAX,
  FOLDER_MIME,
  driveChangesList,
  driveChangesStartToken,
  driveCreateFile,
  driveCreateFolder,
  driveGetBytes,
  driveGetMeta,
  driveListChildren,
  driveReplaceContent,
  driveStorageQuota,
  driveUpdateMeta,
  type DriveFileFull,
} from "@/lib/connectors/m21/live/google-drive";
import { type ChangesPage, type FileProvider, type ListPage, type ProviderChange, type ProviderEntry, type WriteOptions, ProviderError, toBuffer } from "./types";
import { joinPath, nameOf, parentOf, parseProviderPath } from "./path";

function mapError(err: unknown): never {
  if (err instanceof ProviderError) throw err;
  if (err instanceof ConnectorApiError) {
    const code = err.code === "not_found" ? "not_found" : err.code === "forbidden" || err.code === "auth_rejected" ? "forbidden" : err.code === "bad_request" ? "unsupported" : err.code === "rate_limited" || err.code === "provider_unreachable" || err.code === "provider_error" ? "unavailable" : "invalid_path";
    throw new ProviderError(code, err.message);
  }
  throw err;
}

const isFolder = (f: DriveFileFull) => f.mimeType === FOLDER_MIME;
const isNativeDoc = (f: DriveFileFull) => (f.mimeType ?? "").startsWith("application/vnd.google-apps.") && !isFolder(f);

export class GoogleDriveProvider implements FileProvider {
  readonly id = "google-drive";
  private readonly known = new Map<string, string>(); // id -> path
  /** Items this instance created and has not yet reported through changes(): they are creates, not updates. */
  private readonly fresh = new Set<string>();

  constructor(
    private readonly auth: TokenSource,
    private readonly deps: LiveDeps = {},
    /** The Drive folder id that is this provider's root ("root" = My Drive). */
    private readonly rootId: string = "root",
  ) {}

  private entry(f: DriveFileFull, path: string): ProviderEntry {
    this.known.set(f.id ?? "", path);
    return { id: f.id ?? "", path, name: f.name ?? nameOf(path), kind: isFolder(f) ? "folder" : "file", sizeBytes: isFolder(f) ? null : f.size !== undefined ? Number(f.size) : null, mimeType: isFolder(f) ? null : (f.mimeType ?? null), modifiedAt: f.modifiedTime ?? null };
  }

  /** Resolve a path to the Drive item (null if absent). The root is a pseudo folder. */
  private async resolve(path: string): Promise<DriveFileFull | null> {
    const { segments } = parseProviderPath(path);
    let cur: DriveFileFull = { id: this.rootId, mimeType: FOLDER_MIME, name: "" };
    for (const seg of segments) {
      if (!isFolder(cur)) return null;
      const kids = await driveListChildren(this.auth, cur.id!, this.deps);
      const hits = kids.filter((k) => collisionKey(k.name ?? "") === collisionKey(seg));
      if (hits.length === 0) return null;
      if (hits.length > 1) throw new ProviderError("conflict", `Drive has more than one item called "${seg}" here; rename one in Drive first.`);
      cur = hits[0]!;
    }
    return cur;
  }

  private async requireFolder(path: string): Promise<DriveFileFull> {
    const f = await this.resolve(path).catch(mapError);
    if (!f || !isFolder(f)) throw new ProviderError("not_found", `The folder ${path} does not exist.`);
    return f;
  }

  async list(path: string, opts?: { pageToken?: string | null; limit?: number }): Promise<ListPage> {
    const p = parseProviderPath(path).path;
    const folder = await this.requireFolder(p);
    try {
      const kids = (await driveListChildren(this.auth, folder.id!, this.deps)).sort((a, b) => (a.name ?? "").toLowerCase().localeCompare((b.name ?? "").toLowerCase()));
      const start = opts?.pageToken ? Number(opts.pageToken) || 0 : 0;
      const limit = opts?.limit ?? 100;
      return { entries: kids.slice(start, start + limit).map((k) => this.entry(k, joinPath(p, k.name ?? ""))), nextPageToken: start + limit < kids.length ? String(start + limit) : null };
    } catch (e) {
      mapError(e);
    }
  }

  async stat(path: string): Promise<ProviderEntry | null> {
    const p = parseProviderPath(path).path;
    if (p === "/") return { id: this.rootId, path: "/", name: "", kind: "folder", sizeBytes: null, mimeType: null, modifiedAt: null };
    const f = await this.resolve(p).catch(mapError);
    return f ? this.entry(f, p) : null;
  }

  async *read(path: string, range?: { start: number; end: number }): AsyncGenerator<Buffer> {
    const p = parseProviderPath(path).path;
    const f = await this.resolve(p).catch(mapError);
    if (!f || isFolder(f)) throw new ProviderError("not_found", "No such file.");
    if (isNativeDoc(f)) throw new ProviderError("unsupported", "Google documents can't be read as files; export them in Drive first.");
    const bytes = await driveGetBytes(this.auth, f.id!, range, this.deps).catch(mapError);
    for (let i = 0; i < bytes.length; i += 1024 * 1024) yield bytes.subarray(i, Math.min(i + 1024 * 1024, bytes.length));
  }

  async write(path: string, data: Buffer | AsyncIterable<Buffer>, opts: WriteOptions = {}): Promise<ProviderEntry> {
    const p = parseProviderPath(path).path;
    if (p === "/") throw new ProviderError("invalid_path", "That is the root.");
    const parent = await this.requireFolder(parentOf(p));
    const bytes = await toBuffer(data);
    if (bytes.length > DRIVE_SIMPLE_UPLOAD_MAX) throw new ProviderError("unsupported", "Files over 5 MB aren't supported for Google Drive yet.");
    const mime = opts.mimeType ?? "application/octet-stream";
    try {
      const siblings = await driveListChildren(this.auth, parent.id!, this.deps);
      const same = siblings.filter((k) => collisionKey(k.name ?? "") === collisionKey(nameOf(p)));
      if (same.length > 1) throw new ProviderError("conflict", "Drive has more than one item with that name here.");
      const existing = same[0];
      if (existing && (isFolder(existing) || !opts.overwrite)) throw new ProviderError("conflict", `Something already exists at ${joinPath(parentOf(p), existing.name ?? "")}.`);
      const done = existing ? await driveReplaceContent(this.auth, existing.id!, mime, bytes, this.deps) : await driveCreateFile(this.auth, parent.id!, nameOf(p), mime, bytes, this.deps);
      if (!existing) this.fresh.add(done.id ?? "");
      return this.entry({ ...done, size: String(bytes.length) }, existing ? joinPath(parentOf(p), existing.name ?? nameOf(p)) : p);
    } catch (e) {
      mapError(e);
    }
  }

  async mkdir(path: string): Promise<ProviderEntry> {
    const p = parseProviderPath(path).path;
    if (p === "/") throw new ProviderError("conflict", "The root exists.");
    const parent = await this.requireFolder(parentOf(p));
    try {
      const kids = await driveListChildren(this.auth, parent.id!, this.deps);
      if (kids.some((k) => collisionKey(k.name ?? "") === collisionKey(nameOf(p)))) throw new ProviderError("conflict", `Something already exists at ${p}.`);
      const made = await driveCreateFolder(this.auth, parent.id!, nameOf(p), this.deps);
      this.fresh.add(made.id ?? "");
      return this.entry(made, p);
    } catch (e) {
      mapError(e);
    }
  }

  async move(from: string, to: string): Promise<ProviderEntry> {
    const a = parseProviderPath(from).path;
    const b = parseProviderPath(to).path;
    const src = await this.resolve(a).catch(mapError);
    if (!src) throw new ProviderError("not_found", "No such file or folder.");
    if (isFolder(src) && collisionKey(b).startsWith(`${collisionKey(a)}/`)) throw new ProviderError("invalid_path", "A folder cannot move into itself.");
    const dstParent = await this.requireFolder(parentOf(b));
    try {
      const kids = await driveListChildren(this.auth, dstParent.id!, this.deps);
      const clash = kids.find((k) => collisionKey(k.name ?? "") === collisionKey(nameOf(b)) && k.id !== src.id);
      if (clash) throw new ProviderError("conflict", `Something already exists at ${b}.`);
      const srcParent = src.parents?.[0] ?? (await driveGetMeta(this.auth, src.id!, this.deps)).parents?.[0];
      const moved = await driveUpdateMeta(
        this.auth,
        src.id!,
        { name: nameOf(b) !== (src.name ?? "") ? nameOf(b) : undefined, addParent: srcParent !== dstParent.id ? dstParent.id : undefined, removeParent: srcParent !== dstParent.id ? srcParent : undefined },
        this.deps,
      );
      // Everything beneath a moved folder has a new path.
      if (isFolder(src)) for (const [id, kp] of this.known) if (kp.startsWith(`${a}/`)) this.known.set(id, b + kp.slice(a.length));
      return this.entry({ ...src, ...moved }, b);
    } catch (e) {
      mapError(e);
    }
  }

  async remove(path: string): Promise<void> {
    const p = parseProviderPath(path).path;
    const f = await this.resolve(p).catch(mapError);
    if (!f) throw new ProviderError("not_found", "No such file or folder.");
    try {
      await driveUpdateMeta(this.auth, f.id!, { trashed: true }, this.deps);
    } catch (e) {
      mapError(e);
    }
  }

  /** Walk a file's parents up to this provider's root; null when it lies outside it. */
  private async pathOf(f: DriveFileFull, depth = 0): Promise<string | null> {
    const parentId = f.parents?.[0];
    if (!parentId || depth > 30) return null;
    if (parentId === this.rootId) return joinPath("/", f.name ?? "");
    const knownParent = this.known.get(parentId);
    if (knownParent !== undefined) return joinPath(knownParent, f.name ?? "");
    const parent = await driveGetMeta(this.auth, parentId, this.deps).catch(() => null);
    if (!parent) return null;
    const pp = await this.pathOf(parent, depth + 1);
    if (pp === null) return null;
    this.known.set(parentId, pp);
    return joinPath(pp, f.name ?? "");
  }

  async changes(cursor: string | null, limit = 100): Promise<ChangesPage> {
    try {
      if (cursor === null) return { changes: [], cursor: await driveChangesStartToken(this.auth, this.deps), hasMore: false };
      const res = await driveChangesList(this.auth, cursor, Math.min(limit, 1000), this.deps);
      const out: ProviderChange[] = [];
      for (const c of res.changes ?? []) {
        if (c.removed || !c.file) {
          const was = this.known.get(c.fileId);
          if (was) {
            this.known.delete(c.fileId);
            out.push({ type: "delete", entry: { id: c.fileId, path: was, name: nameOf(was), kind: "file", sizeBytes: null, mimeType: null, modifiedAt: null }, prevPath: null });
          }
          continue;
        }
        const path = await this.pathOf(c.file);
        if (path === null) continue; // outside this root
        const was = this.known.get(c.fileId);
        if (c.file.trashed) {
          this.known.delete(c.fileId);
          out.push({ type: "trash", entry: this.entry(c.file, path), prevPath: null });
          this.known.delete(c.fileId);
          continue;
        }
        const wasFresh = this.fresh.delete(c.fileId);
        const type: ProviderChange["type"] = was === undefined || wasFresh ? "create" : was !== path ? "move" : "update";
        out.push({ type, entry: this.entry(c.file, path), prevPath: type === "move" ? was! : null });
      }
      return { changes: out, cursor: res.nextPageToken ?? res.newStartPageToken ?? cursor, hasMore: !!res.nextPageToken };
    } catch (e) {
      mapError(e);
    }
  }

  async quota() {
    try {
      return await driveStorageQuota(this.auth, this.deps);
    } catch (e) {
      mapError(e);
    }
  }
}
