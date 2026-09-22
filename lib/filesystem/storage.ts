// Marketr — workspace filesystem: storage adapters (Phase B, W3).
//
// Storage is a dumb byte store keyed by opaque UUIDs. The adapter never sees
// user filenames or workspace IDs in keys — the registry is the only mapping.
// Every operation re-validates the key shape so a compromised caller cannot
// smuggle a path through.

import { createHmac, createHash } from "node:crypto";
import { mkdir, rename, unlink, readFile as fsRead, stat, writeFile as fsWrite } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export interface StorageAdapter {
  readonly name: string;
  put(key: string, bytes: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/** UUIDv4 keys only — anything else is refused before it touches the path. */
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertKeyShape(key: string): void {
  if (!KEY_RE.test(key)) {
    throw new Error("Invalid storage key.");
  }
}

export class LocalDiskAdapter implements StorageAdapter {
  readonly name = "local";
  private readonly root: string;

  constructor(rootDir?: string) {
    this.root = resolve(rootDir ?? join(process.cwd(), ".data", "workspace-files"));
  }

  private pathFor(key: string): string {
    assertKeyShape(key);
    const resolved = resolve(join(this.root, key));
    // Defense in depth: even with UUID-only keys, never leave the root.
    if (resolved !== join(this.root, key) || !resolved.startsWith(this.root + sep)) {
      throw new Error("Storage key escapes the storage root.");
    }
    return resolved;
  }

  async put(key: string, bytes: Buffer, _mimeType?: string): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(this.root, { recursive: true });
    // Atomic write: temp UUID name inside the root, then rename. An attacker
    // cannot pre-place a symlink at the target because the temp name is
    // random and the final rename is a single syscall.
    const tmp = join(this.root, `tmp-${randomUUID()}`);
    await fsWrite(tmp, bytes, { flag: "wx" });
    try {
      await rename(tmp, target);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const target = this.pathFor(key);
    try {
      return await fsRead(target);
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.pathFor(key);
    await unlink(target).catch(() => {});
  }

  async exists(key: string): Promise<boolean> {
    const target = this.pathFor(key);
    try {
      const s = await stat(target);
      return s.isFile();
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// S3-compatible adapter (MinIO-compatible). Config-driven; refuses to
// instantiate when credentials are missing (fail closed).
//
// SigV4 is hand-rolled on purpose: dependency-free, works against any
// S3-compatible endpoint, and keeps the "no new supply-chain surface" rule
// from the upload-safety work. PUT/GET/DELETE/HEAD only — the full extent of
// what the registry needs.
// ---------------------------------------------------------------------------

export interface S3Config {
  endpoint: string; // e.g. http://minio:9000
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle?: boolean; // true for MinIO
}

export function s3ConfigFromEnv(): S3Config | null {
  const endpoint = process.env.MARKETR_S3_ENDPOINT?.trim();
  const bucket = process.env.MARKETR_S3_BUCKET?.trim();
  const accessKey = process.env.MARKETR_S3_ACCESS_KEY?.trim();
  const secretKey = process.env.MARKETR_S3_SECRET_KEY?.trim();
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    region: process.env.MARKETR_S3_REGION?.trim() || "us-east-1",
    bucket,
    accessKey,
    secretKey,
    forcePathStyle: (process.env.MARKETR_S3_FORCE_PATH_STYLE ?? "true") !== "false",
  };
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}
function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
function amzDate(d: Date): { short: string; long: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  const short = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const long = `${short}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return { short, long };
}

export class S3CompatibleAdapter implements StorageAdapter {
  readonly name = "s3";
  private readonly cfg: S3Config;
  private readonly host: string;
  private readonly scheme: string;

  constructor(cfg?: S3Config | null) {
    const resolved = cfg ?? s3ConfigFromEnv();
    if (!resolved) {
      throw new Error(
        "S3 storage is not configured (MARKETR_S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY).",
      );
    }
    this.cfg = resolved;
    const u = new URL(resolved.endpoint);
    this.scheme = u.protocol;
    this.host = u.host;
  }

  private objectUrl(key: string): string {
    assertKeyShape(key);
    const { bucket, forcePathStyle } = this.cfg;
    const enc = encodeURIComponent(key);
    return forcePathStyle
      ? `${this.scheme}//${this.host}/${bucket}/${enc}`
      : `${this.scheme}//${bucket}.${this.host}/${enc}`;
  }

  private sign(
    method: string,
    key: string,
    body: Buffer | null,
    contentType?: string,
  ): { url: string; headers: Record<string, string> } {
    const { region, accessKey, secretKey } = this.cfg;
    const url = this.objectUrl(key);
    const u = new URL(url);
    const now = new Date();
    const { short, long } = amzDate(now);
    const payloadHash = sha256Hex(body ?? "");
    const headers: Record<string, string> = {
      host: u.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": long,
    };
    if (contentType) headers["content-type"] = contentType;
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((h) => `${h}:${headers[h].trim()}\n`)
      .join("");
    const canonicalRequest = [
      method,
      u.pathname,
      u.search ? u.search.slice(1) : "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${short}/${region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      long,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const kDate = hmac(`AWS4${secretKey}`, short);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = hmac(kSigning, stringToSign).toString("hex");
    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return { url, headers };
  }

  async put(key: string, bytes: Buffer, mimeType: string): Promise<void> {
    const { url, headers } = this.sign("PUT", key, bytes, mimeType || "application/octet-stream");
    const res = await fetch(url, { method: "PUT", headers, body: new Uint8Array(bytes) });
    if (!res.ok) {
      throw new Error(`S3 PUT failed (${res.status}).`);
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const { url, headers } = this.sign("GET", key, null);
    const res = await fetch(url, { method: "GET", headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 GET failed (${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const { url, headers } = this.sign("DELETE", key, null);
    const res = await fetch(url, { method: "DELETE", headers });
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 DELETE failed (${res.status}).`);
    }
  }

  async exists(key: string): Promise<boolean> {
    const { url, headers } = this.sign("HEAD", key, null);
    const res = await fetch(url, { method: "HEAD", headers });
    return res.ok;
  }
}

// ---------------------------------------------------------------------------
// Adapter selection. MARKETR_STORAGE=local (default) | s3.
// Multi-instance deployments MUST use s3; local disk is single-box only.
// ---------------------------------------------------------------------------

let cached: StorageAdapter | null = null;

/** For tests: drop the cached adapter so env changes take effect. */
export function resetStorageAdapterForTests(): void {
  cached = null;
}

export function getStorageAdapter(): StorageAdapter {
  if (cached) return cached;
  const mode = (process.env.MARKETR_STORAGE ?? "local").trim().toLowerCase();
  if (mode === "s3") {
    cached = new S3CompatibleAdapter();
  } else if (mode === "local") {
    cached = new LocalDiskAdapter(process.env.MARKETR_STORAGE_DIR);
  } else {
    throw new Error(`Unknown MARKETR_STORAGE mode: ${mode}`);
  }
  return cached;
}
