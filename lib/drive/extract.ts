// ShapesOS — Phase 21B (WS=drive): safe zip extraction (PURE: bytes in, files out).
//
// "Extract here" turns an archive into files in Drive, and an archive is attacker-
// controlled. So extraction is a PLAN first and an inflate second, and every refusal
// is listed with its reason (nothing is dropped silently):
//   - names go through the Drive name rules (NFC; no "..", absolute, backslash or
//     drive-letter paths; no Windows-reserved names or trailing dots); two entries
//     that differ only by case/Unicode form would overwrite each other on a Mac or PC,
//     so the second is refused;
//   - symbolic links, devices and other special files are NEVER created;
//   - zip bombs: the declared size is checked BEFORE inflating (per entry and against a
//     running total), an extreme compression ratio is refused, and the inflate itself is
//     capped at the declared size + 1, so a header that lies about the size fails instead
//     of filling memory; the entry count is capped; encrypted and zip64 archives are refused.
// The files it returns are then written through the normal gate (upload-safety sniff,
// malware scan, quota, versions) by lib/drive/ops.ts — extraction adds no trust.

import { inflateRawSync, crc32 } from "node:zlib";
import { collisionKey, normalizeLogicalPath } from "../filesystem/paths";

export interface ExtractLimits {
  maxEntries: number;
  /** Sum of all extracted bytes. */
  maxTotalBytes: number;
  /** One entry. */
  maxEntryBytes: number;
  /** Uncompressed / compressed, for entries of at least ratioFloorBytes. */
  maxRatio: number;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxEntries: 5000,
  maxTotalBytes: 200 * 1024 * 1024,
  maxEntryBytes: 25 * 1024 * 1024,
  maxRatio: 100,
};
const RATIO_FLOOR_BYTES = 64 * 1024;

export interface ExtractedFile {
  /** Canonical relative path (NFC, forward slashes). */
  path: string;
  bytes: Buffer;
}
export interface SkippedEntry {
  name: string;
  reason: string;
}
export interface ExtractResult {
  files: ExtractedFile[];
  skipped: SkippedEntry[];
}

const PROBE = "/apps/extract/probe/";

/** The relative path an entry name would have in Drive, or the reason it cannot. */
export function safeEntryPath(name: string): { ok: true; path: string } | { ok: false; reason: string } {
  if (name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    return { ok: false, reason: "unsafe path (absolute, backslash or drive letter)" };
  }
  const r = normalizeLogicalPath(`${PROBE}${name}`);
  if (!r.ok) return { ok: false, reason: `unsafe path: ${r.reason}` };
  return { ok: true, path: r.path.slice(PROBE.length) };
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) return i;
  return -1;
}

export function extractZip(buf: Buffer, limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS): ExtractResult {
  if (buf.length < 22) throw new Error("This is not a zip archive.");
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("This is not a zip archive.");
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("zip64 archives are not supported.");
  if (cdOffset + cdSize > eocd) throw new Error("This is not a valid zip archive.");
  if (total > limits.maxEntries) return { files: [], skipped: [{ name: "(archive)", reason: `too many entries (${total}; the limit is ${limits.maxEntries})` }] };

  const files: ExtractedFile[] = [];
  const skipped: SkippedEntry[] = [];
  const seen = new Map<string, string>();
  let running = 0;
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("This is not a valid zip archive.");
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    const skip = (reason: string) => void skipped.push({ name, reason });

    if (name.endsWith("/")) continue; // folders are implied by the files in them
    const mode = madeBy >> 8 === 3 ? attrs >>> 16 : 0;
    const type = mode & 0o170000;
    if (type === 0o120000) {
      skip("symbolic links are not extracted");
      continue;
    }
    if (type !== 0 && type !== 0o100000 && type !== 0o040000) {
      skip("special files are not extracted");
      continue;
    }
    if (type === 0o040000) continue;
    const safe = safeEntryPath(name);
    if (!safe.ok) {
      skip(safe.reason);
      continue;
    }
    if (flags & 1) {
      skip("encrypted entries are not supported");
      continue;
    }
    if (method !== 0 && method !== 8) {
      skip("unsupported compression method");
      continue;
    }
    const key = collisionKey(safe.path);
    const clash = seen.get(key);
    if (clash) {
      skip(`name differs only by case or Unicode form from "${clash}" (it would overwrite it)`);
      continue;
    }
    if (size > limits.maxEntryBytes) {
      skip(`over the single-file limit of ${Math.floor(limits.maxEntryBytes / 1024 / 1024)} MB`);
      continue;
    }
    if (size >= RATIO_FLOOR_BYTES && compSize > 0 && size / compSize > limits.maxRatio) {
      skip(`compression ratio too high (${Math.round(size / compSize)}:1, the limit is ${limits.maxRatio}:1)`);
      continue;
    }
    if (running + size > limits.maxTotalBytes) {
      skip(`would pass the total size limit of ${Math.floor(limits.maxTotalBytes / 1024 / 1024)} MB (too large)`);
      continue;
    }
    // Local header: the data starts after ITS name and extra field.
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      skip("damaged entry");
      continue;
    }
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (data.length !== compSize) {
      skip("damaged entry (truncated)");
      continue;
    }
    let out: Buffer;
    try {
      out = method === 0 ? data : inflateRawSync(data, { maxOutputLength: size + 1 });
    } catch {
      skip("inflates to more than its declared size (rejected as a possible zip bomb) or is damaged");
      continue;
    }
    if (out.length !== size) {
      skip(`does not match its declared size (${out.length} vs ${size})`);
      continue;
    }
    if (crc32(out) >>> 0 !== crc) {
      skip("checksum mismatch");
      continue;
    }
    seen.set(key, safe.path);
    running += out.length;
    files.push({ path: safe.path, bytes: out });
  }
  return { files, skipped };
}
