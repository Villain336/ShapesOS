// ShapesOS — Phase 21B (WS=drive): an IN-MEMORY FileProvider. A FAKE: it exists so
// the provider contract suite has a second implementation to prove the contract is
// not just "whatever the native store does", and so other code can be tested
// without a database. It is never wired into the product.

import { collisionKey } from "../../filesystem/paths";
import { type ChangesPage, type FileProvider, type ListPage, type ProviderChange, type ProviderEntry, type WriteOptions, ProviderError, toBuffer } from "./types";
import { joinPath, nameOf, parentOf, parseProviderPath } from "./path";

interface Node {
  id: string;
  path: string;
  kind: "file" | "folder";
  bytes: Buffer | null;
  mimeType: string | null;
  modifiedAt: Date;
}

export class InMemoryFakeProvider implements FileProvider {
  readonly id = "fake";
  private nodes = new Map<string, Node>(); // key: collisionKey(path)
  private journal: Array<{ seq: number; change: ProviderChange }> = [];
  private seq = 0;
  private nextId = 1;
  constructor(private readonly limitBytes: number | null = null) {}

  private entry(n: Node): ProviderEntry {
    return { id: n.id, path: n.path, name: nameOf(n.path), kind: n.kind, sizeBytes: n.kind === "file" ? n.bytes!.length : null, mimeType: n.mimeType, modifiedAt: n.modifiedAt.toISOString() };
  }
  private find(path: string): Node | undefined {
    return this.nodes.get(collisionKey(path));
  }
  private record(type: ProviderChange["type"], n: Node, prevPath: string | null = null) {
    this.journal.push({ seq: ++this.seq, change: { type, entry: this.entry(n), prevPath } });
  }
  private requireParent(path: string) {
    const parent = parentOf(path);
    if (parent !== "/" && this.find(parent)?.kind !== "folder") throw new ProviderError("not_found", `The folder ${parent} does not exist.`);
  }

  async list(path: string, opts?: { pageToken?: string | null; limit?: number }): Promise<ListPage> {
    const p = parseProviderPath(path).path;
    if (p !== "/" && this.find(p)?.kind !== "folder") throw new ProviderError("not_found", `The folder ${p} does not exist.`);
    const all = [...this.nodes.values()].filter((n) => parentOf(n.path) === p).sort((a, b) => nameOf(a.path).toLowerCase().localeCompare(nameOf(b.path).toLowerCase()));
    const start = opts?.pageToken ? Number(opts.pageToken) : 0;
    const limit = opts?.limit ?? 100;
    const page = all.slice(start, start + limit);
    return { entries: page.map((n) => this.entry(n)), nextPageToken: start + limit < all.length ? String(start + limit) : null };
  }

  async stat(path: string): Promise<ProviderEntry | null> {
    const p = parseProviderPath(path).path;
    if (p === "/") return { id: "root", path: "/", name: "", kind: "folder", sizeBytes: null, mimeType: null, modifiedAt: null };
    const n = this.find(p);
    return n ? this.entry(n) : null;
  }

  async *read(path: string, range?: { start: number; end: number }): AsyncGenerator<Buffer> {
    const n = this.find(parseProviderPath(path).path);
    if (!n || n.kind !== "file") throw new ProviderError("not_found", "No such file.");
    const b = range ? n.bytes!.subarray(range.start, range.end + 1) : n.bytes!;
    for (let i = 0; i < b.length; i += 64 * 1024) yield b.subarray(i, Math.min(i + 64 * 1024, b.length));
  }

  async write(path: string, data: Buffer | AsyncIterable<Buffer>, opts: WriteOptions = {}): Promise<ProviderEntry> {
    const p = parseProviderPath(path).path;
    if (p === "/") throw new ProviderError("invalid_path", "That is the root.");
    this.requireParent(p);
    const bytes = await toBuffer(data);
    const existing = this.find(p);
    if (existing?.kind === "folder") throw new ProviderError("conflict", "A folder has that name.");
    if (existing && !opts.overwrite) throw new ProviderError("conflict", `A file already exists at ${existing.path}.`);
    const used = [...this.nodes.values()].reduce((n, x) => n + (x.bytes?.length ?? 0), 0) - (existing?.bytes?.length ?? 0);
    if (this.limitBytes !== null && used + bytes.length > this.limitBytes) throw new ProviderError("quota_exceeded", "Storage is full.");
    if (existing) {
      existing.bytes = bytes;
      existing.mimeType = opts.mimeType ?? existing.mimeType;
      existing.modifiedAt = new Date();
      this.record("update", existing);
      return this.entry(existing);
    }
    const n: Node = { id: `f${this.nextId++}`, path: p, kind: "file", bytes, mimeType: opts.mimeType ?? "application/octet-stream", modifiedAt: new Date() };
    this.nodes.set(collisionKey(p), n);
    this.record("create", n);
    return this.entry(n);
  }

  async mkdir(path: string): Promise<ProviderEntry> {
    const p = parseProviderPath(path).path;
    if (p === "/") throw new ProviderError("conflict", "The root exists.");
    this.requireParent(p);
    if (this.find(p)) throw new ProviderError("conflict", `Something already exists at ${p}.`);
    const n: Node = { id: `d${this.nextId++}`, path: p, kind: "folder", bytes: null, mimeType: null, modifiedAt: new Date() };
    this.nodes.set(collisionKey(p), n);
    this.record("create", n);
    return this.entry(n);
  }

  async move(from: string, to: string): Promise<ProviderEntry> {
    const a = parseProviderPath(from).path;
    const b = parseProviderPath(to).path;
    const n = this.find(a);
    if (!n) throw new ProviderError("not_found", "No such file or folder.");
    this.requireParent(b);
    const clash = this.find(b);
    if (clash && clash !== n) throw new ProviderError("conflict", `Something already exists at ${b}.`);
    if (n.kind === "folder" && collisionKey(b).startsWith(`${collisionKey(a)}/`)) throw new ProviderError("invalid_path", "A folder cannot move into itself.");
    // Re-key the node and (for a folder) everything beneath it.
    const moved: Node[] = [n, ...[...this.nodes.values()].filter((x) => collisionKey(x.path).startsWith(`${collisionKey(a)}/`))];
    for (const m of moved) this.nodes.delete(collisionKey(m.path));
    for (const m of moved) {
      m.path = b + m.path.slice(a.length);
      this.nodes.set(collisionKey(m.path), m);
    }
    this.record("move", n, a);
    return this.entry(n);
  }

  async remove(path: string): Promise<void> {
    const p = parseProviderPath(path).path;
    const n = this.find(p);
    if (!n) throw new ProviderError("not_found", "No such file or folder.");
    const gone = [n, ...[...this.nodes.values()].filter((x) => collisionKey(x.path).startsWith(`${collisionKey(p)}/`))];
    for (const g of gone) this.nodes.delete(collisionKey(g.path));
    this.record("trash", n);
  }

  async changes(cursor: string | null, limit = 100): Promise<ChangesPage> {
    if (cursor === null) return { changes: [], cursor: String(this.seq), hasMore: false };
    const from = Number(cursor);
    if (!Number.isInteger(from) || from < 0 || from > this.seq) throw new ProviderError("invalid_path", "Unknown cursor.");
    const rest = this.journal.filter((j) => j.seq > from);
    const page = rest.slice(0, limit);
    return { changes: page.map((j) => j.change), cursor: String(page.length ? page[page.length - 1]!.seq : from), hasMore: rest.length > page.length };
  }

  async quota() {
    return { usedBytes: [...this.nodes.values()].reduce((n, x) => n + (x.bytes?.length ?? 0), 0), limitBytes: this.limitBytes };
  }
}

export { joinPath };
