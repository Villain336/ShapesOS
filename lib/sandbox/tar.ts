// ShapesOS — Phase 8: the smallest tar we need (PURE, no dependency).
//
// Docker's archive API speaks tar: PUT /containers/{id}/archive extracts a
// tar into a directory, GET returns one. Writing a file into a read-only-root
// container goes through it (an exec argument tops out at 128 KiB), so we
// build a one-entry ustar archive (+ a PAX header for names over 100 bytes)
// and read the first regular file back out of a GET response.

const BLOCK = 512;

function octal(n: number, width: number): string {
  // width includes the trailing NUL
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name: string, size: number, typeflag: string, opts: { mode: number; uid: number; gid: number; mtime: number }): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name.slice(0, 100), 0, 100, "utf8");
  h.write(octal(opts.mode & 0o7777, 8), 100, 8, "ascii");
  h.write(octal(opts.uid, 8), 108, 8, "ascii");
  h.write(octal(opts.gid, 8), 116, 8, "ascii");
  h.write(octal(size, 12), 124, 12, "ascii");
  h.write(octal(Math.floor(opts.mtime), 12), 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii"); // checksum placeholder (spaces)
  h.write(typeflag, 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return h;
}

function pad(n: number): Buffer {
  const r = n % BLOCK;
  return Buffer.alloc(r === 0 ? 0 : BLOCK - r, 0);
}

function paxRecord(key: string, value: string): string {
  // "<len> <key>=<value>\n" where len counts itself.
  const body = ` ${key}=${value}\n`;
  const base = Buffer.byteLength(body);
  let len = base + String(base).length;
  if (String(len).length !== String(base).length) len = base + String(len).length;
  return `${len}${body}`;
}

/** A tar holding one regular file `name` (a basename, no slashes needed). */
export function tarSingleFile(
  name: string,
  data: Buffer,
  opts: { mode?: number; uid?: number; gid?: number; mtime?: number } = {},
): Buffer {
  const o = { mode: opts.mode ?? 0o644, uid: opts.uid ?? 1000, gid: opts.gid ?? 1000, mtime: opts.mtime ?? Date.now() / 1000 };
  const parts: Buffer[] = [];
  if (Buffer.byteLength(name) > 100) {
    const pax = Buffer.from(paxRecord("path", name), "utf8");
    parts.push(header("PaxHeader", pax.length, "x", o), pax, pad(pax.length));
  }
  parts.push(header(name, data.length, "0", o), data, pad(data.length), Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

function readNum(buf: Buffer): number {
  // GNU base-256 for large sizes
  if (buf[0]! & 0x80) {
    let n = 0;
    for (let i = 1; i < buf.length; i++) n = n * 256 + buf[i]!;
    return n;
  }
  const s = buf.toString("ascii").split("\0")[0]!.trim();
  return s ? parseInt(s, 8) : 0;
}

function cstr(buf: Buffer): string {
  const i = buf.indexOf(0);
  return buf.subarray(0, i === -1 ? buf.length : i).toString("utf8");
}

export interface TarEntry {
  name: string;
  type: "file" | "dir" | "other";
  size: number;
  data?: Buffer;
}

/** Walk a tar archive's entries (PAX / GNU long names applied). */
export function readTar(tar: Buffer, opts: { maxEntries?: number } = {}): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  let longName: string | null = null;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const size = readNum(h.subarray(124, 136));
    const type = String.fromCharCode(h[156] || 48);
    const body = tar.subarray(off + BLOCK, off + BLOCK + size);
    off += BLOCK + size + ((BLOCK - (size % BLOCK)) % BLOCK);
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      if (m) longName = m[1]!;
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = cstr(body);
      continue;
    }
    const prefix = cstr(h.subarray(345, 500));
    const name = longName ?? (prefix ? `${prefix}/${cstr(h.subarray(0, 100))}` : cstr(h.subarray(0, 100)));
    longName = null;
    const kind = type === "0" || type === "\0" || type === "7" ? "file" : type === "5" ? "dir" : "other";
    out.push({ name, type: kind, size, data: kind === "file" ? Buffer.from(body) : undefined });
    if (opts.maxEntries && out.length >= opts.maxEntries) break;
  }
  return out;
}

/** The first regular file in a tar (what GET archive returns for a file path). */
export function firstFileInTar(tar: Buffer): Buffer | null {
  const e = readTar(tar).find((x) => x.type === "file");
  return e?.data ?? null;
}
