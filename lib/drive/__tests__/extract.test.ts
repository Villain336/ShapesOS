// ShapesOS — Phase 21B (WS=drive): safe archive extraction — zip bombs, symlinks,
// traversal, case collisions (unit). Archives are built by hand in the test so the
// malicious cases are real bytes, not mocks.
// Run: npx tsx --test lib/drive/__tests__/extract.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { crc32 } from "node:zlib";
import { extractZip, DEFAULT_EXTRACT_LIMITS } from "../extract";

interface Spec {
  name: string;
  data?: Buffer;
  /** Store instead of deflate. */
  stored?: boolean;
  /** Unix mode for the external attributes (0o120777 = symlink). */
  mode?: number;
  /** Lie about the uncompressed size in the headers. */
  declaredSize?: number;
  dir?: boolean;
}

function zip(specs: Spec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const name = Buffer.from(s.name, "utf8");
    const data = s.data ?? Buffer.alloc(0);
    const comp = s.stored ? data : deflateRawSync(data);
    const method = s.stored ? 0 : 8;
    const crc = crc32(data) >>> 0;
    const declared = s.declaredSize ?? data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(declared, 22);
    lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, comp]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4); // made by unix
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(declared, 24);
    ch.writeUInt16LE(name.length, 28);
    const mode = s.mode ?? (s.dir ? 0o40755 : 0o100644);
    ch.writeUInt32LE((mode << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const txt = (s: string) => Buffer.from(s, "utf8");

describe("extractZip: the ordinary case", () => {
  it("returns every regular file with its path and bytes, folders implied", () => {
    const r = extractZip(zip([{ name: "docs/", dir: true }, { name: "docs/a.txt", data: txt("alpha") }, { name: "b.txt", data: txt("bravo"), stored: true }]));
    assert.deepEqual(r.files.map((f) => [f.path, f.bytes.toString()]), [["docs/a.txt", "alpha"], ["b.txt", "bravo"]]);
    assert.deepEqual(r.skipped, []);
  });
});

describe("extractZip: hostile names", () => {
  it("skips traversal, absolute paths, backslashes and drive letters; nothing escapes", () => {
    const r = extractZip(zip([
      { name: "../evil.txt", data: txt("x") },
      { name: "a/../../evil2.txt", data: txt("x") },
      { name: "/etc/passwd", data: txt("x") },
      { name: "..\\win.txt", data: txt("x") },
      { name: "C:\\boot.ini", data: txt("x") },
      { name: "ok.txt", data: txt("fine") },
    ]));
    assert.deepEqual(r.files.map((f) => f.path), ["ok.txt"]);
    assert.deepEqual(r.skipped.map((s) => s.name).sort(), ["../evil.txt", "/etc/passwd", "C:\\boot.ini", "..\\win.txt", "a/../../evil2.txt"].sort());
    for (const s of r.skipped) assert.match(s.reason, /path|name/i);
  });
  it("skips Windows-reserved names and trailing dots, keeps Unicode names in NFC", () => {
    const r = extractZip(zip([{ name: "CON.txt", data: txt("x") }, { name: "dots.", data: txt("x") }, { name: "Cafe\u0301.txt", data: txt("c") }]));
    assert.deepEqual(r.files.map((f) => f.path), ["Caf\u00E9.txt"]);
    assert.equal(r.skipped.length, 2);
  });
  it("skips a second entry whose name differs only by case (it would overwrite the first on a Mac or PC)", () => {
    const r = extractZip(zip([{ name: "Readme.txt", data: txt("one") }, { name: "README.TXT", data: txt("two") }]));
    assert.deepEqual(r.files.map((f) => f.path), ["Readme.txt"]);
    assert.match(r.skipped[0]!.reason, /case/i);
  });
});

describe("extractZip: symlinks", () => {
  it("never creates a symbolic link, whatever it points at", () => {
    const r = extractZip(zip([{ name: "link", data: txt("/etc/passwd"), mode: 0o120777 }, { name: "real.txt", data: txt("real") }]));
    assert.deepEqual(r.files.map((f) => f.path), ["real.txt"]);
    assert.deepEqual(r.skipped, [{ name: "link", reason: "symbolic links are not extracted" }]);
  });
  it("skips device files and other special modes too", () => {
    const r = extractZip(zip([{ name: "dev", data: txt(""), mode: 0o020644 }]));
    assert.deepEqual(r.files, []);
    assert.equal(r.skipped.length, 1);
  });
});

describe("extractZip: zip bombs", () => {
  it("refuses an archive whose declared total size is over the limit, without inflating anything", () => {
    const small = Buffer.alloc(2000, 0);
    const z = zip([{ name: "big.txt", data: small, declaredSize: 5_000_000 }]);
    const r = extractZip(z, { ...DEFAULT_EXTRACT_LIMITS, maxTotalBytes: 1_000_000 });
    assert.deepEqual(r.files, []);
    assert.match(r.skipped[0]!.reason, /too large|limit/i);
  });
  it("refuses an entry that inflates to more than it declared (a lying header)", () => {
    const real = Buffer.alloc(100_000, 0x41);
    const r = extractZip(zip([{ name: "lie.txt", data: real, declaredSize: 10 }]));
    assert.deepEqual(r.files, []);
    assert.match(r.skipped[0]!.reason, /size|bomb|declared/i);
  });
  it("refuses an extreme compression ratio even when the sizes are honest", () => {
    const bomb = Buffer.alloc(20_000_000, 0); // 20 MB of zeros deflates to ~20 KB
    const r = extractZip(zip([{ name: "zeros.txt", data: bomb }]), { ...DEFAULT_EXTRACT_LIMITS, maxRatio: 100 });
    assert.deepEqual(r.files, []);
    assert.match(r.skipped[0]!.reason, /ratio/i);
  });
  it("stops at the entry-count limit", () => {
    const specs: Spec[] = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.txt`, data: txt(String(i)) }));
    const r = extractZip(zip(specs), { ...DEFAULT_EXTRACT_LIMITS, maxEntries: 10 });
    assert.equal(r.files.length, 0);
    assert.match(r.skipped[0]!.reason, /entries/i);
  });
  it("stops once the running total would pass the limit and says which entries were left", () => {
    const r = extractZip(zip([{ name: "a.txt", data: Buffer.alloc(600, 0x61) }, { name: "b.txt", data: Buffer.alloc(600, 0x62) }]), { ...DEFAULT_EXTRACT_LIMITS, maxTotalBytes: 1000, maxRatio: 10_000 });
    assert.deepEqual(r.files.map((f) => f.path), ["a.txt"]);
    assert.equal(r.skipped[0]!.name, "b.txt");
  });
});

describe("extractZip: not a zip", () => {
  it("rejects bytes that are not a zip archive, and zip64 archives it does not read", () => {
    assert.throws(() => extractZip(Buffer.from("not a zip at all")), /zip/i);
  });
});
