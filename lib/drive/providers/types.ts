// ShapesOS — Phase 21B (WS=drive): the FileProvider interface.
//
// One contract for every place files can live: the native store (S3-compatible,
// the reference implementation), Google Drive (the existing connector upgraded
// from read-only), and an in-memory fake the contract suite runs against too.
// Third-party mounts beyond Google Drive (OneDrive/SharePoint, Dropbox/Box) are
// NOT approved and have no implementation here.
//
// Paths are relative to the provider's root ("/" is the root) and follow the
// Drive name rules (lib/filesystem/paths.ts: NFC, no ".." or Windows-reserved
// names, case-insensitive collisions). Behaviour every provider must show is
// pinned by the contract suite (lib/drive/providers/__tests__/contract-suite.ts).
//
// Honesty: an implementation that is not the real thing says so in its name
// (the in-memory one is `fake`); only `native` is proven against real storage
// here, and `google-drive` is UNVERIFIED-LIVE.

export type ProviderErrorCode = "not_found" | "conflict" | "invalid_path" | "forbidden" | "quota_exceeded" | "unsupported" | "unavailable";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

export interface ProviderEntry {
  /** Stable provider-specific id (survives rename and move). */
  id: string;
  /** Path relative to the provider root. */
  path: string;
  name: string;
  kind: "file" | "folder";
  sizeBytes: number | null;
  mimeType: string | null;
  /** ISO time of the last change, if known. */
  modifiedAt: string | null;
}

export type ProviderChangeType = "create" | "update" | "move" | "trash" | "delete";

export interface ProviderChange {
  type: ProviderChangeType;
  entry: ProviderEntry;
  /** Where it was, for a move. */
  prevPath: string | null;
}

export interface ListPage {
  entries: ProviderEntry[];
  nextPageToken: string | null;
}

export interface ChangesPage {
  changes: ProviderChange[];
  /** Pass back to continue; equals the input when nothing is new. */
  cursor: string;
  hasMore: boolean;
}

export interface WriteOptions {
  mimeType?: string;
  /** Replace the file if it exists (default: refuse with `conflict`). */
  overwrite?: boolean;
}

export interface FileProvider {
  /** "native" | "google-drive" | "fake" */
  readonly id: string;
  /** Direct children of a folder. `not_found` if the folder does not exist. */
  list(path: string, opts?: { pageToken?: string | null; limit?: number }): Promise<ListPage>;
  /** The entry at a path, or null. */
  stat(path: string): Promise<ProviderEntry | null>;
  /** The bytes, as a stream of chunks (optionally a byte range, inclusive). `not_found` if absent. */
  read(path: string, range?: { start: number; end: number }): AsyncIterable<Buffer>;
  /** Create a file (and nothing else: parents must exist). `conflict` if it exists and overwrite is not set. */
  write(path: string, data: Buffer | AsyncIterable<Buffer>, opts?: WriteOptions): Promise<ProviderEntry>;
  /** Create a folder. `conflict` if it exists. */
  mkdir(path: string): Promise<ProviderEntry>;
  /** Move or rename a file or folder. `conflict` if the target exists. */
  move(from: string, to: string): Promise<ProviderEntry>;
  /** Remove (to the provider's trash where it has one). `not_found` if absent. Reversible removals are the default. */
  remove(path: string): Promise<void>;
  /**
   * The change feed. `changes(null)` returns the START cursor and no changes;
   * `changes(cursor)` returns what happened after it, oldest first.
   */
  changes(cursor: string | null, limit?: number): Promise<ChangesPage>;
  /** Bytes used and the limit, if the provider has one. */
  quota(): Promise<{ usedBytes: number; limitBytes: number | null }>;
}

export async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(c);
  return Buffer.concat(parts);
}

export async function toBuffer(data: Buffer | AsyncIterable<Buffer>): Promise<Buffer> {
  return Buffer.isBuffer(data) ? data : collect(data);
}
