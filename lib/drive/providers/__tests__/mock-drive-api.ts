// ShapesOS — Phase 21B (WS=drive): a MOCK of the Google Drive v3 API (the subset the
// Drive provider uses), as a `fetch` replacement. It is a mock written from the public
// API reference, NOT Google: where it differs from the real service the provider is
// UNVERIFIED-LIVE. It does reproduce the behaviours the provider has to cope with:
// duplicate names are allowed, changes.list coalesces to the latest state per file,
// folders trash with their children, simple uploads are limited to 5 MB.

import { randomUUID } from "node:crypto";

interface Item {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  bytes: Buffer | null;
  trashed: boolean;
  modifiedTime: string;
  changeSeq: number;
}

export class MockDriveApi {
  items = new Map<string, Item>();
  seq = 1;
  readonly calls: Array<{ method: string; path: string; query: URLSearchParams; auth: string | null }> = [];
  /** The scope the mocked token carries; "readonly" makes writes 403 like Google would. */
  scope: "full" | "readonly" = "full";
  limitBytes: number | null = 15 * 1024 ** 3;

  fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    this.calls.push({ method, path: url.pathname, query: url.searchParams, auth: headers.get("authorization") });
    const body = init?.body ? Buffer.from(init.body as Uint8Array | string) : Buffer.alloc(0);
    try {
      return this.route(method, url, headers, body);
    } catch (e) {
      if (e instanceof Response) return e;
      throw e;
    }
  };

  private json(status: number, data: unknown): Response {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  }
  private err(status: number, message: string): never {
    throw this.json(status, { error: { code: status, message } });
  }
  private view(i: Item) {
    return { id: i.id, name: i.name, mimeType: i.mimeType, size: i.bytes ? String(i.bytes.length) : undefined, modifiedTime: i.modifiedTime, parents: i.parents, trashed: i.trashed };
  }
  private touch(i: Item) {
    i.changeSeq = ++this.seq;
    i.modifiedTime = new Date().toISOString();
  }
  private get(id: string): Item {
    const i = this.items.get(id);
    if (!i) this.err(404, "File not found: " + id);
    return i;
  }
  private needWrite() {
    if (this.scope === "readonly") this.err(403, "Insufficient Permission: Request had insufficient authentication scopes.");
  }

  private route(method: string, url: URL, headers: Headers, body: Buffer): Response {
    const path = url.pathname;
    const q = url.searchParams;
    let m: RegExpExecArray | null;

    if (path === "/drive/v3/about") {
      const used = [...this.items.values()].reduce((n, i) => n + (i.bytes?.length ?? 0), 0);
      return this.json(200, { storageQuota: { usage: String(used), ...(this.limitBytes ? { limit: String(this.limitBytes) } : {}) } });
    }
    if (path === "/drive/v3/files" && method === "GET") {
      const parent = /^'([^']+)' in parents and trashed = false$/.exec(q.get("q") ?? "")?.[1];
      if (!parent) this.err(400, "unsupported query in mock: " + q.get("q"));
      const all = [...this.items.values()].filter((i) => i.parents.includes(parent) && !i.trashed);
      const start = Number(q.get("pageToken") ?? 0);
      const size = Number(q.get("pageSize") ?? 100);
      const page = all.slice(start, start + size);
      return this.json(200, { files: page.map((i) => this.view(i)), ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}) });
    }
    if (path === "/drive/v3/files" && method === "POST") {
      this.needWrite();
      const j = JSON.parse(body.toString("utf8")) as { name: string; mimeType: string; parents: string[] };
      const i = this.create(j.name, j.mimeType, j.parents, null);
      return this.json(200, this.view(i));
    }
    if (path === "/upload/drive/v3/files" && method === "POST") {
      this.needWrite();
      const ct = headers.get("content-type") ?? "";
      const boundary = /boundary=(.+)$/.exec(ct)?.[1];
      if (!boundary) this.err(400, "no boundary");
      const text = body.toString("latin1");
      const parts = text.split(`--${boundary}`).filter((p) => p.trim() && p.trim() !== "--");
      const meta = JSON.parse(parts[0]!.split("\r\n\r\n")[1]!.replace(/\r\n$/, "")) as { name: string; parents: string[]; mimeType: string };
      const mediaStart = body.indexOf(Buffer.from("\r\n\r\n", "latin1"), body.indexOf(Buffer.from(`--${boundary}\r\nContent-Type: ${meta.mimeType}`, "latin1"))) + 4;
      const mediaEnd = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`, "latin1"));
      const media = body.subarray(mediaStart, mediaEnd);
      if (media.length > 5 * 1024 * 1024) this.err(400, "simple upload limit is 5 MB");
      const i = this.create(meta.name, meta.mimeType, meta.parents, media);
      return this.json(200, this.view(i));
    }
    if ((m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(path)) && method === "PATCH") {
      this.needWrite();
      const i = this.get(m[1]!);
      i.bytes = body;
      this.touch(i);
      return this.json(200, this.view(i));
    }
    if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(path))) {
      const id = m[1]!;
      if (method === "GET" && q.get("alt") === "media") {
        const i = this.get(id);
        if (!i.bytes) this.err(403, "Only files with binary content can be downloaded.");
        const r = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
        if (r) return new Response(new Uint8Array(i.bytes.subarray(Number(r[1]), Number(r[2]) + 1)), { status: 206 });
        return new Response(new Uint8Array(i.bytes), { status: 200 });
      }
      if (method === "GET") {
        const i = id === "root" ? { id: "root", name: "My Drive", mimeType: "application/vnd.google-apps.folder", parents: [], bytes: null, trashed: false, modifiedTime: "", changeSeq: 0 } : this.get(id);
        return this.json(200, this.view(i));
      }
      if (method === "PATCH") {
        this.needWrite();
        const i = this.get(id);
        const j = body.length ? (JSON.parse(body.toString("utf8")) as { name?: string; trashed?: boolean }) : {};
        if (j.name !== undefined) i.name = j.name;
        if (j.trashed !== undefined) this.setTrashed(i, j.trashed);
        const rm = q.get("removeParents");
        const add = q.get("addParents");
        if (rm) i.parents = i.parents.filter((p) => p !== rm);
        if (add) i.parents.push(add);
        this.touch(i);
        return this.json(200, this.view(i));
      }
      if (method === "DELETE") {
        this.needWrite();
        const i = this.get(id);
        this.items.delete(i.id);
        this.removed.push({ id: i.id, seq: ++this.seq });
        return new Response(null, { status: 204 });
      }
    }
    if (path === "/drive/v3/changes/startPageToken") return this.json(200, { startPageToken: String(this.seq) });
    if (path === "/drive/v3/changes") {
      const from = Number(q.get("pageToken"));
      const size = Number(q.get("pageSize") ?? 100);
      // Latest state per file, oldest change first (what changes.list does).
      const rows = [
        ...[...this.items.values()].filter((i) => i.changeSeq > from).map((i) => ({ seq: i.changeSeq, change: { fileId: i.id, removed: false, file: this.view(i) } })),
        ...this.removed.filter((r) => r.seq > from).map((r) => ({ seq: r.seq, change: { fileId: r.id, removed: true } })),
      ].sort((a, b) => a.seq - b.seq);
      const page = rows.slice(0, size);
      const lastSeq = page.length ? page[page.length - 1]!.seq : from;
      return this.json(200, { changes: page.map((r) => r.change), ...(rows.length > size ? { nextPageToken: String(lastSeq) } : { newStartPageToken: String(Math.max(this.seq, lastSeq)) }) });
    }
    this.err(404, `mock Drive: no route for ${method} ${path}`);
  }

  removed: Array<{ id: string; seq: number }> = [];

  private setTrashed(i: Item, trashed: boolean) {
    i.trashed = trashed;
    if (i.mimeType === "application/vnd.google-apps.folder") for (const k of this.items.values()) if (k.parents.includes(i.id)) this.setTrashed(k, trashed);
    this.touch(i);
  }

  create(name: string, mimeType: string, parents: string[], bytes: Buffer | null): Item {
    const i: Item = { id: randomUUID().replace(/-/g, "").slice(0, 28), name, mimeType, parents: [...parents], bytes, trashed: false, modifiedTime: new Date().toISOString(), changeSeq: ++this.seq };
    this.items.set(i.id, i);
    return i;
  }
}
