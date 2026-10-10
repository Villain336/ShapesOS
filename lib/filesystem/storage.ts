// Marketr — workspace filesystem: storage adapters (Phase B, W3) and the
// shared blob layer (Deploy PR, WS=state).
//
// Two APIs over ONE storage backend choice (MARKETR_STORAGE=local|s3) and ONE
// hand-rolled S3 client:
//
//   1. The UUID API (StorageAdapter: put/get/delete/exists) — WorkspaceFile
//      bytes. Storage is a dumb byte store keyed by opaque UUIDs. The adapter
//      never sees user filenames or workspace IDs in keys — the registry is
//      the only mapping. Every operation re-validates the key shape so a
//      compromised caller cannot smuggle a path through. UNCHANGED by the
//      deploy PR.
//
//   2. The namespaced blob API (blobPut/blobGet/blobHead/blobDelete/blobList,
//      plus blob refs "blob:<namespace>/<path>") — every other file the app
//      persists (run recordings, report PDFs, briefs, logos, site working
//      copies, fix snapshots, sitemaps, the knowledge corpus …). Production
//      runs several web replicas plus a worker with NO shared disk, so
//      anything one instance writes must be readable by every other one:
//      with MARKETR_STORAGE=s3 these live in the bucket under
//      `blobs/<namespace>/<path>`; with MARKETR_STORAGE=local (dev and the
//      single-box self-host) each namespace maps onto the directory that
//      feature always used (.data/reports, .run-artifacts, …), so an existing
//      install keeps seeing its files. See lib/filesystem/STORAGE.md for the
//      writer inventory and the class (a)/(b)/(c) decisions.
//
// Blob paths are validated on every call: segments of [A-Za-z0-9._~-] only
// (RFC 3986 "unreserved" — no percent-encoding anywhere, no "..", no "/"
// prefix, no empty segments), at most 1024 characters. Namespaces are a
// closed list. Workspace data is keyed under the workspace id first.
//
// SigV4 is hand-rolled on purpose: dependency-free, works against any
// S3-compatible endpoint (R2, MinIO, AWS S3), and keeps the "no new
// supply-chain surface" rule from the upload-safety work. signV4() is pure
// and tested against the AWS documentation vectors.

import { createHmac, createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open as fsOpen,
  readdir,
  readFile as fsRead,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile as fsWrite,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

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
// SigV4 (pure). https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
// ---------------------------------------------------------------------------

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials (ECS task role, STS) carry a session token. */
  sessionToken?: string;
  /** Epoch ms the credentials stop working (refresh before). */
  expiresAt?: number;
}

/** RFC 3986 encoding as SigV4 wants it (encodeURIComponent leaves !'()* alone). */
export function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Canonical URI for S3: every path segment encoded once ("/" kept). */
export function s3CanonicalPath(path: string): string {
  return path
    .split("/")
    .map((seg) => rfc3986(seg))
    .join("/");
}

/** Canonical (and wire) query string: keys sorted, keys and values RFC 3986-encoded. */
export function s3CanonicalQuery(query: Record<string, string> | undefined): string {
  if (!query) return "";
  return Object.keys(query)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k] ?? "")}`)
    .join("&");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
export function amzDate(d: Date): { short: string; long: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  const short = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const long = `${short}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return { short, long };
}

export interface SignV4Input {
  method: string;
  /** Host header value (host[:port]). */
  host: string;
  /** Already-canonical URI path, e.g. "/bucket/blobs/x" or "/test%24file.text". */
  canonicalPath: string;
  /** Already-canonical query string (s3CanonicalQuery), "" for none. */
  canonicalQuery: string;
  /** Extra headers to sign (lower-cased names), e.g. range, content-type. */
  headers?: Record<string, string>;
  /** Hex sha256 of the body ("UNSIGNED-PAYLOAD" is not used here). */
  payloadHash: string;
  region: string;
  service?: string;
  credentials: S3Credentials;
  now: Date;
}

export interface SignedV4 {
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/**
 * Sign one request (AWS Signature Version 4, header-based). Pure: the clock
 * and credentials come in, the headers to send come out. Every header passed
 * in (plus host, x-amz-date, x-amz-content-sha256 and the session token) is
 * signed.
 */
export function signV4(input: SignV4Input): SignedV4 {
  const service = input.service ?? "s3";
  const { short, long } = amzDate(input.now);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v;
  headers.host = input.host;
  headers["x-amz-content-sha256"] = input.payloadHash;
  headers["x-amz-date"] = long;
  if (input.credentials.sessionToken) headers["x-amz-security-token"] = input.credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalHeaders = names.map((h) => `${h}:${String(headers[h]).trim().replace(/\s+/g, " ")}\n`).join("");
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.canonicalPath,
    input.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const credentialScope = `${short}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", long, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, short);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign, signature };
}

// ---------------------------------------------------------------------------
// S3-compatible adapter (R2 / MinIO / AWS S3). Config-driven; refuses to
// instantiate when the bucket or credentials are missing (fail closed).
// ---------------------------------------------------------------------------

export interface S3Config {
  endpoint: string; // e.g. http://minio:9000 · https://<account>.r2.cloudflarestorage.com
  region: string;
  bucket: string;
  /** Static keys (MARKETR_S3_ACCESS_KEY / _SECRET_KEY). Empty when `credentials` is used. */
  accessKey: string;
  secretKey: string;
  forcePathStyle?: boolean; // true for MinIO and R2
  /** AWS default chain (env keys or the ECS task role) when no static keys are set. */
  credentials?: () => Promise<S3Credentials>;
}

/**
 * The AWS-style credential chain, the part of it that is trivial without the
 * SDK: (1) AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN),
 * (2) the ECS / Fargate container endpoint (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
 * or _FULL_URI, optional AWS_CONTAINER_AUTHORIZATION_TOKEN), cached until
 * five minutes before expiry. EC2 instance metadata (IMDS) and SSO profiles
 * are NOT supported — the CDK app runs on Fargate. Null when neither is set.
 */
export function awsCredentialChain(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  clock: () => number = Date.now,
): (() => Promise<S3Credentials>) | null {
  const id = env.AWS_ACCESS_KEY_ID?.trim();
  const secret = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (id && secret) {
    const creds: S3Credentials = { accessKeyId: id, secretAccessKey: secret, sessionToken: env.AWS_SESSION_TOKEN?.trim() || undefined };
    return async () => creds;
  }
  const rel = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim();
  const full = env.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim();
  if (!rel && !full) return null;
  const url = rel ? `http://169.254.170.2${rel}` : full!;
  const token = env.AWS_CONTAINER_AUTHORIZATION_TOKEN?.trim();
  let cached: S3Credentials | null = null;
  let inflight: Promise<S3Credentials> | null = null;
  return async () => {
    if (cached && (cached.expiresAt ?? Infinity) - 5 * 60_000 > clock()) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
      const res = await fetchImpl(url, { headers: token ? { authorization: token } : {} });
      if (!res.ok) throw new Error(`ECS credential endpoint answered ${res.status}.`);
      const j = (await res.json()) as { AccessKeyId?: string; SecretAccessKey?: string; Token?: string; Expiration?: string };
      if (!j.AccessKeyId || !j.SecretAccessKey) throw new Error("ECS credential endpoint returned no keys.");
      cached = {
        accessKeyId: j.AccessKeyId,
        secretAccessKey: j.SecretAccessKey,
        sessionToken: j.Token || undefined,
        expiresAt: j.Expiration ? Date.parse(j.Expiration) : undefined,
      };
      return cached;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const endpoint = env.MARKETR_S3_ENDPOINT?.trim();
  const bucket = env.MARKETR_S3_BUCKET?.trim();
  const accessKey = env.MARKETR_S3_ACCESS_KEY?.trim() ?? "";
  const secretKey = env.MARKETR_S3_SECRET_KEY?.trim() ?? "";
  if (!endpoint || !bucket) return null;
  const base = {
    endpoint: endpoint.replace(/\/+$/, ""),
    region: env.MARKETR_S3_REGION?.trim() || "us-east-1",
    bucket,
    forcePathStyle: (env.MARKETR_S3_FORCE_PATH_STYLE ?? "true") !== "false",
  };
  if (accessKey && secretKey) return { ...base, accessKey, secretKey };
  const chain = awsCredentialChain(env);
  if (!chain) return null;
  return { ...base, accessKey: "", secretKey: "", credentials: chain };
}

export interface S3RequestOptions {
  query?: Record<string, string>;
  body?: Buffer | null;
  headers?: Record<string, string>;
}

export class S3CompatibleAdapter implements StorageAdapter {
  readonly name = "s3";
  private readonly cfg: S3Config;
  private readonly host: string;
  private readonly scheme: string;
  private readonly basePath: string;

  constructor(cfg?: S3Config | null) {
    const resolved = cfg ?? s3ConfigFromEnv();
    if (!resolved) {
      throw new Error(
        "S3 storage is not configured (MARKETR_S3_ENDPOINT/BUCKET plus MARKETR_S3_ACCESS_KEY/SECRET_KEY or AWS credentials).",
      );
    }
    this.cfg = resolved;
    const u = new URL(resolved.endpoint);
    this.scheme = u.protocol;
    this.host = u.host;
    // An endpoint may carry a path prefix (some gateways); keep it.
    this.basePath = u.pathname.replace(/\/+$/, "");
  }

  private async credentials(): Promise<S3Credentials> {
    if (this.cfg.accessKey && this.cfg.secretKey) {
      return { accessKeyId: this.cfg.accessKey, secretAccessKey: this.cfg.secretKey };
    }
    if (this.cfg.credentials) return this.cfg.credentials();
    throw new Error("S3 storage has no credentials.");
  }

  /** URL host + canonical path for an object key ("" = the bucket itself). */
  private target(objectKey: string): { host: string; path: string } {
    const { bucket, forcePathStyle } = this.cfg;
    const keyPath = objectKey ? `/${s3CanonicalPath(objectKey)}` : "/";
    if (forcePathStyle) {
      return { host: this.host, path: `${this.basePath}/${rfc3986(bucket)}${objectKey ? keyPath : ""}` || "/" };
    }
    return { host: `${bucket}.${this.host}`, path: `${this.basePath}${keyPath}` || "/" };
  }

  /** One signed request. `objectKey` is the full key inside the bucket. */
  async request(method: string, objectKey: string, opts: S3RequestOptions = {}): Promise<Response> {
    const { host, path } = this.target(objectKey);
    const query = s3CanonicalQuery(opts.query);
    const body = opts.body ?? null;
    const signed = signV4({
      method,
      host,
      canonicalPath: path,
      canonicalQuery: query,
      headers: opts.headers,
      payloadHash: sha256Hex(body ?? ""),
      region: this.cfg.region,
      credentials: await this.credentials(),
      now: new Date(),
    });
    const url = `${this.scheme}//${host}${path}${query ? `?${query}` : ""}`;
    return fetch(url, {
      method,
      headers: signed.headers,
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
  }

  async put(key: string, bytes: Buffer, mimeType: string): Promise<void> {
    assertKeyShape(key);
    const res = await this.request("PUT", key, {
      body: bytes,
      headers: { "content-type": mimeType || "application/octet-stream" },
    });
    if (!res.ok) {
      throw new Error(`S3 PUT failed (${res.status}).`);
    }
  }

  async get(key: string): Promise<Buffer | null> {
    assertKeyShape(key);
    const res = await this.request("GET", key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 GET failed (${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    assertKeyShape(key);
    const res = await this.request("DELETE", key);
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 DELETE failed (${res.status}).`);
    }
  }

  async exists(key: string): Promise<boolean> {
    assertKeyShape(key);
    const res = await this.request("HEAD", key);
    return res.ok;
  }
}

// ---------------------------------------------------------------------------
// Adapter selection. MARKETR_STORAGE=local (default) | s3.
// Multi-instance deployments MUST use s3; local disk is single-box only.
// ---------------------------------------------------------------------------

export type StorageMode = "local" | "s3";

export function storageMode(env: NodeJS.ProcessEnv = process.env): StorageMode {
  const mode = (env.MARKETR_STORAGE ?? "local").trim().toLowerCase();
  if (mode === "s3" || mode === "local") return mode;
  throw new Error(`Unknown MARKETR_STORAGE mode: ${mode}`);
}

/**
 * A configuration that cannot work on a hosted (multi-instance) install, or
 * null. Logged loudly at boot (instrumentation.ts): with local storage each
 * replica and the worker would see different files.
 */
export function storageDeploymentWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  const hosted = (env.DEPLOYMENT_MODE ?? "").trim().toLowerCase() === "hosted";
  let mode: StorageMode;
  try {
    mode = storageMode(env);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (hosted && mode === "local") {
    return "DEPLOYMENT_MODE=hosted with MARKETR_STORAGE=local: files written by one instance are invisible to the others. Set MARKETR_STORAGE=s3 and the MARKETR_S3_* settings.";
  }
  if (mode === "s3" && !s3ConfigFromEnv(env)) {
    return "MARKETR_STORAGE=s3 but the bucket settings are incomplete (MARKETR_S3_ENDPOINT, MARKETR_S3_BUCKET and keys or AWS credentials).";
  }
  return null;
}

let cached: StorageAdapter | null = null;
let cachedS3: S3CompatibleAdapter | null = null;
let cachedBlobs: BlobBackend | null = null;

/** For tests: drop the cached adapters so env changes take effect. */
export function resetStorageAdapterForTests(): void {
  cached = null;
  cachedS3 = null;
  cachedBlobs = null;
}

function sharedS3(): S3CompatibleAdapter {
  return (cachedS3 ??= new S3CompatibleAdapter());
}

export function getStorageAdapter(): StorageAdapter {
  if (cached) return cached;
  cached = storageMode() === "s3" ? sharedS3() : new LocalDiskAdapter(process.env.MARKETR_STORAGE_DIR);
  return cached;
}

// ===========================================================================
// Namespaced blob layer
// ===========================================================================

export class BlobKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobKeyError";
  }
}

const cwdJoin = (...p: string[]) => join(process.cwd(), ...p);
const envDir = (name: string): string | null => {
  const v = process.env[name]?.trim();
  return v ? resolve(v) : null;
};

/** The default local root for namespaces with no historic directory. */
export function localBlobRoot(): string {
  return envDir("MARKETR_BLOB_DIR") ?? cwdJoin(".data", "blobs");
}

/**
 * The closed list of namespaces. `localDir` is where the namespace lives with
 * MARKETR_STORAGE=local — the directory (and env override) the feature used
 * before the deploy PR, so a single-box install keeps every file it has.
 */
export const BLOB_NAMESPACES = {
  /** Agent run recordings: <workspaceId>/<runId>/{video.webm,trace.zip,step-*.png}. */
  "run-recordings": { localDir: () => cwdJoin(".run-artifacts"), workspaceScoped: true },
  /** Report PDFs (milestone 12, authority intelligence): <workspaceId>/<file>.pdf. */
  reports: { localDir: () => envDir("REPORT_STORAGE_DIR") ?? cwdJoin(".data", "reports"), workspaceScoped: true },
  /** Brand-kit and white-label logos: <workspaceId>/<file> (legacy rows: flat <file>). */
  logos: { localDir: () => join(envDir("REPORT_STORAGE_DIR") ?? cwdJoin(".data", "reports"), "logos"), workspaceScoped: true },
  /** Report-engine (WeasyPrint) PDFs: <workspaceId>/report-<stamp>.pdf. */
  "report-engine": { localDir: () => cwdJoin(".data", "reports", "report-engine"), workspaceScoped: true },
  /** EDDM handoff briefs: <workspaceId>/<orderId>.pdf (legacy: <orderId>.pdf). */
  "eddm-briefs": { localDir: () => envDir("EDDM_BRIEF_STORAGE_DIR") ?? cwdJoin(".data", "eddm-briefs"), workspaceScoped: true },
  /** Media insertion-order briefs: <workspaceId>/<briefId>.pdf (legacy: <briefId>.pdf). */
  "io-briefs": { localDir: () => envDir("IO_BRIEF_STORAGE_DIR") ?? cwdJoin(".data", "io-briefs"), workspaceScoped: true },
  /** DOOH launch packets: <workspaceId>/<planId>-v<n>.pdf (legacy: <planId>-v<n>.pdf). */
  "launch-packets": { localDir: () => envDir("LAUNCH_PACKET_STORAGE_DIR") ?? cwdJoin(".data", "launch-packets"), workspaceScoped: true },
  /** Audio buy briefs: <workspaceId>/<buyId>.pdf (legacy: <buyId>.pdf). */
  "audio-briefs": { localDir: () => envDir("AUDIO_BRIEF_STORAGE_DIR") ?? cwdJoin(".data", "audio-briefs"), workspaceScoped: true },
  /** Programmatic SEO sitemaps: <projectId>.xml. */
  sitemaps: { localDir: () => envDir("SITEMAP_STORAGE_DIR") ?? cwdJoin(".data", "sitemaps"), workspaceScoped: false },
  /** Site working copies: <siteId>/working/<encoded path…> (ownership is checked before a provider exists). */
  sites: { localDir: () => envDir("SITE_STORAGE_DIR") ?? cwdJoin(".data", "sites"), workspaceScoped: false },
  /** Fix-agent rollback snapshots: <fixRunId>.json. */
  "fix-snapshots": { localDir: () => envDir("FIX_SNAPSHOT_DIR") ?? cwdJoin(".data", "fix-snapshots"), workspaceScoped: false },
  /** Scheduler run outputs when the filesystem service is unavailable: <workspaceId>/<runId>/<file>. */
  "scheduler-runs": { localDir: () => cwdJoin(".data", "scheduler-runs"), workspaceScoped: true },
  /** The shared knowledge corpus (platform asset, not tenant data). */
  corpus: { localDir: () => envDir("CORPUS_DIR") ?? cwdJoin("data", "corpus"), workspaceScoped: false },
  /** Smoke tests and health probes. */
  system: { localDir: () => join(localBlobRoot(), "system"), workspaceScoped: false },
  /** Phase 18.3 (WS=flow): Time Machine workspace snapshots: <workspaceId>/<snapshotId>.json.gz. */
  snapshots: { localDir: () => envDir("SNAPSHOT_STORAGE_DIR") ?? join(localBlobRoot(), "snapshots"), workspaceScoped: true },
  /** Phase 21A (WS=agentweb): page captures and browser-step screenshots: <workspaceId>/<captureId>.{txt,png}. */
  "web-captures": { localDir: () => join(localBlobRoot(), "web-captures"), workspaceScoped: true },
} as const satisfies Record<string, { localDir: () => string; workspaceScoped: boolean }>;

export type BlobNamespace = keyof typeof BLOB_NAMESPACES;

export function isBlobNamespace(v: unknown): v is BlobNamespace {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(BLOB_NAMESPACES, v);
}

function assertNamespace(ns: string): asserts ns is BlobNamespace {
  if (!isBlobNamespace(ns)) throw new BlobKeyError(`Unknown blob namespace: ${ns}`);
}

/** Where a namespace lives on disk with MARKETR_STORAGE=local. */
export function localBlobDir(ns: BlobNamespace): string {
  assertNamespace(ns);
  return resolve(BLOB_NAMESPACES[ns].localDir());
}

const BLOB_SEGMENT_RE = /^[A-Za-z0-9._~-]{1,255}$/;
export const BLOB_PATH_MAX = 1024;
/** Local temp files live next to their target; listings never show them. */
const LOCAL_TMP_PREFIX = ".blobtmp-";

/** Validate one path segment (no "/", "", "." or ".."; unreserved charset). */
export function assertBlobSegment(seg: string): string {
  if (typeof seg !== "string" || !BLOB_SEGMENT_RE.test(seg) || seg === "." || seg === "..") {
    throw new BlobKeyError(`Invalid blob path segment: ${JSON.stringify(seg)}`);
  }
  if (seg.startsWith(LOCAL_TMP_PREFIX)) throw new BlobKeyError("Reserved blob path segment.");
  return seg;
}

/** Validate a blob path ("a/b/c.pdf"): relative, no dot segments, strict charset. */
export function assertBlobPath(path: string): string {
  if (typeof path !== "string" || !path || path.length > BLOB_PATH_MAX) {
    throw new BlobKeyError("Invalid blob path.");
  }
  if (path.startsWith("/") || path.endsWith("/") || path.includes("\\")) {
    throw new BlobKeyError(`Invalid blob path: ${JSON.stringify(path)}`);
  }
  for (const seg of path.split("/")) assertBlobSegment(seg);
  return path;
}

/** Validate a listing prefix: "" or directory-style "a/b/". */
export function assertBlobPrefix(prefix: string): string {
  if (prefix === "") return prefix;
  if (typeof prefix !== "string" || !prefix.endsWith("/") || prefix.length > BLOB_PATH_MAX) {
    throw new BlobKeyError(`Invalid blob prefix: ${JSON.stringify(prefix)}`);
  }
  assertBlobPath(prefix.slice(0, -1));
  return prefix;
}

/** Join validated segments into a blob path. */
export function blobPath(...segments: string[]): string {
  return assertBlobPath(segments.map(assertBlobSegment).join("/"));
}

/** "<workspaceId>/<file>" — the key shape for workspace-scoped files. */
export function workspaceBlobPath(workspaceId: string, ...rest: string[]): string {
  return blobPath(encodeBlobSegment(workspaceId), ...rest.map(encodeBlobSegment));
}

/**
 * Encode an arbitrary name (a site file name, which may contain spaces or
 * unicode) into one blob segment, reversibly: names already in the safe
 * charset stay as they are; anything else becomes "~" + base64url(utf8).
 */
export function encodeBlobSegment(name: string): string {
  if (/^[A-Za-z0-9._-]{1,200}$/.test(name) && name !== "." && name !== ".." && !name.startsWith(LOCAL_TMP_PREFIX)) {
    return name;
  }
  const enc = `~${Buffer.from(name, "utf8").toString("base64url")}`;
  if (enc.length > 255) throw new BlobKeyError("File name too long.");
  return enc;
}

export function decodeBlobSegment(seg: string): string {
  return seg.startsWith("~") ? Buffer.from(seg.slice(1), "base64url").toString("utf8") : seg;
}

// ---- refs: what a database row stores instead of a filesystem path ----

const REF_PREFIX = "blob:";

/** "blob:<namespace>/<path>" — stored in DB rows that used to hold a path. */
export function blobRef(ns: BlobNamespace, path: string): string {
  assertNamespace(ns);
  return `${REF_PREFIX}${ns}/${assertBlobPath(path)}`;
}

export function isBlobRef(ref: unknown): ref is string {
  return typeof ref === "string" && ref.startsWith(REF_PREFIX);
}

/** Parse a blob ref; null for anything that is not a valid one. */
export function parseBlobRef(ref: string): { namespace: BlobNamespace; path: string } | null {
  if (!isBlobRef(ref)) return null;
  const rest = ref.slice(REF_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const ns = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (!isBlobNamespace(ns)) return null;
  try {
    assertBlobPath(path);
  } catch {
    return null;
  }
  return { namespace: ns, path };
}

// ---- backends ----

export interface BlobHead {
  size: number;
  contentType: string | null;
  lastModified: Date | null;
}

export interface BlobListEntry {
  /** Path relative to the namespace. */
  path: string;
  size: number;
  lastModified: Date | null;
}

export interface BlobListing {
  objects: BlobListEntry[];
  /** With a "/" delimiter: the "sub-directories" (each ends with "/"). */
  prefixes: string[];
}

export interface BlobRange {
  /** Inclusive byte offsets. */
  start: number;
  end: number;
}

export interface BlobBackend {
  readonly name: StorageMode;
  put(ns: BlobNamespace, path: string, bytes: Buffer, mimeType: string): Promise<void>;
  get(ns: BlobNamespace, path: string, range?: BlobRange): Promise<Buffer | null>;
  head(ns: BlobNamespace, path: string): Promise<BlobHead | null>;
  delete(ns: BlobNamespace, path: string): Promise<void>;
  list(ns: BlobNamespace, prefix: string, opts?: { delimiter?: "/" }): Promise<BlobListing>;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  json: "application/json",
  jsonl: "application/x-ndjson",
  xml: "application/xml",
  html: "text/html",
  txt: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  webm: "video/webm",
  mp4: "video/mp4",
  zip: "application/zip",
};

export function mimeForBlobPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? null;
}

export class LocalBlobBackend implements BlobBackend {
  readonly name = "local" as const;

  /** Root override per namespace (tests); default localBlobDir(). */
  constructor(private readonly rootFor: (ns: BlobNamespace) => string = localBlobDir) {}

  private root(ns: BlobNamespace): string {
    assertNamespace(ns);
    return resolve(this.rootFor(ns));
  }

  private abs(ns: BlobNamespace, path: string): { root: string; abs: string } {
    assertBlobPath(path);
    const root = this.root(ns);
    const abs = resolve(root, ...path.split("/"));
    if (!abs.startsWith(root + sep)) throw new BlobKeyError("Blob path escapes the namespace root.");
    return { root, abs };
  }

  async put(ns: BlobNamespace, path: string, bytes: Buffer): Promise<void> {
    const { abs } = this.abs(ns, path);
    await mkdir(dirname(abs), { recursive: true });
    const tmp = join(dirname(abs), `${LOCAL_TMP_PREFIX}${randomUUID()}`);
    await fsWrite(tmp, bytes, { flag: "wx" });
    try {
      await rename(tmp, abs);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async get(ns: BlobNamespace, path: string, range?: BlobRange): Promise<Buffer | null> {
    const { abs } = this.abs(ns, path);
    try {
      const st = await stat(abs);
      if (!st.isFile()) return null;
      if (!range) return await fsRead(abs);
      const start = Math.max(0, range.start);
      const end = Math.min(range.end, st.size - 1);
      if (end < start) return Buffer.alloc(0);
      const fh = await fsOpen(abs, "r");
      try {
        const buf = Buffer.alloc(end - start + 1);
        const { bytesRead } = await fh.read(buf, 0, buf.length, start);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  }

  async head(ns: BlobNamespace, path: string): Promise<BlobHead | null> {
    const { abs } = this.abs(ns, path);
    try {
      const st = await stat(abs);
      if (!st.isFile()) return null;
      return { size: st.size, contentType: mimeForBlobPath(path), lastModified: st.mtime };
    } catch {
      return null;
    }
  }

  async delete(ns: BlobNamespace, path: string): Promise<void> {
    const { root, abs } = this.abs(ns, path);
    try {
      await unlink(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw err;
    }
    // Prune now-empty parent directories (S3 has no directories either).
    let dir = dirname(abs);
    while (dir.startsWith(root + sep)) {
      try {
        await rmdir(dir);
      } catch {
        break;
      }
      dir = dirname(dir);
    }
  }

  async list(ns: BlobNamespace, prefix: string, opts?: { delimiter?: "/" }): Promise<BlobListing> {
    assertBlobPrefix(prefix);
    const root = this.root(ns);
    const out: BlobListing = { objects: [], prefixes: [] };
    const walk = async (relDir: string, recurse: boolean) => {
      const absDir = relDir ? resolve(root, ...relDir.split("/").filter(Boolean)) : root;
      let dirents;
      try {
        dirents = await readdir(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of dirents) {
        if (d.name.startsWith(LOCAL_TMP_PREFIX) || d.isSymbolicLink()) continue;
        if (!BLOB_SEGMENT_RE.test(d.name) || d.name === "." || d.name === "..") continue;
        const rel = `${relDir}${d.name}`;
        if (d.isDirectory()) {
          if (recurse) await walk(`${rel}/`, true);
          else out.prefixes.push(`${rel}/`);
        } else if (d.isFile()) {
          const st = await stat(join(absDir, d.name)).catch(() => null);
          if (st) out.objects.push({ path: rel, size: st.size, lastModified: st.mtime });
        }
      }
    };
    await walk(prefix, opts?.delimiter !== "/");
    out.objects.sort((a, b) => a.path.localeCompare(b.path));
    out.prefixes.sort();
    return out;
  }
}

function xmlDecode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Parse one ListObjectsV2 response page (pure; tested). */
export function parseListObjectsV2(xml: string): {
  objects: Array<{ key: string; size: number; lastModified: Date | null }>;
  prefixes: string[];
  nextToken: string | null;
} {
  const objects: Array<{ key: string; size: number; lastModified: Date | null }> = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = m[1]!;
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
    if (key === undefined) continue;
    const size = Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1] ?? 0);
    const lm = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(body)?.[1];
    const d = lm ? new Date(lm) : null;
    objects.push({ key: xmlDecode(key), size, lastModified: d && !Number.isNaN(d.getTime()) ? d : null });
  }
  const prefixes: string[] = [];
  for (const m of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>\s*<\/CommonPrefixes>/g)) {
    prefixes.push(xmlDecode(m[1]!));
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { objects, prefixes, nextToken: truncated && token ? xmlDecode(token) : null };
}

export class S3BlobBackend implements BlobBackend {
  readonly name = "s3" as const;
  constructor(private readonly s3: S3CompatibleAdapter = sharedS3()) {}

  static objectKey(ns: BlobNamespace, path: string): string {
    assertNamespace(ns);
    return `blobs/${ns}/${assertBlobPath(path)}`;
  }

  async put(ns: BlobNamespace, path: string, bytes: Buffer, mimeType: string): Promise<void> {
    const res = await this.s3.request("PUT", S3BlobBackend.objectKey(ns, path), {
      body: bytes,
      headers: { "content-type": mimeType || mimeForBlobPath(path) || "application/octet-stream" },
    });
    if (!res.ok) throw new Error(`S3 PUT failed (${res.status}).`);
  }

  async get(ns: BlobNamespace, path: string, range?: BlobRange): Promise<Buffer | null> {
    const res = await this.s3.request("GET", S3BlobBackend.objectKey(ns, path), {
      headers: range ? { range: `bytes=${Math.max(0, range.start)}-${range.end}` } : undefined,
    });
    if (res.status === 404) return null;
    if (res.status === 416) return Buffer.alloc(0);
    if (!res.ok) throw new Error(`S3 GET failed (${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }

  async head(ns: BlobNamespace, path: string): Promise<BlobHead | null> {
    const res = await this.s3.request("HEAD", S3BlobBackend.objectKey(ns, path));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 HEAD failed (${res.status}).`);
    const lm = res.headers.get("last-modified");
    const d = lm ? new Date(lm) : null;
    return {
      size: Number(res.headers.get("content-length") ?? 0),
      contentType: res.headers.get("content-type"),
      lastModified: d && !Number.isNaN(d.getTime()) ? d : null,
    };
  }

  async delete(ns: BlobNamespace, path: string): Promise<void> {
    const res = await this.s3.request("DELETE", S3BlobBackend.objectKey(ns, path));
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE failed (${res.status}).`);
  }

  async list(ns: BlobNamespace, prefix: string, opts?: { delimiter?: "/" }): Promise<BlobListing> {
    assertNamespace(ns);
    assertBlobPrefix(prefix);
    const base = `blobs/${ns}/`;
    const out: BlobListing = { objects: [], prefixes: [] };
    let token: string | null = null;
    for (let page = 0; page < 1000; page++) {
      const query: Record<string, string> = { "list-type": "2", prefix: `${base}${prefix}` };
      if (opts?.delimiter) query.delimiter = opts.delimiter;
      if (token) query["continuation-token"] = token;
      const res = await this.s3.request("GET", "", { query });
      if (!res.ok) throw new Error(`S3 LIST failed (${res.status}).`);
      const parsed = parseListObjectsV2(await res.text());
      for (const o of parsed.objects) {
        if (!o.key.startsWith(base)) continue;
        out.objects.push({ path: o.key.slice(base.length), size: o.size, lastModified: o.lastModified });
      }
      for (const p of parsed.prefixes) if (p.startsWith(base)) out.prefixes.push(p.slice(base.length));
      token = parsed.nextToken;
      if (!token) break;
    }
    out.objects.sort((a, b) => a.path.localeCompare(b.path));
    out.prefixes.sort();
    return out;
  }
}

/** The blob backend MARKETR_STORAGE selects (shared S3 client in s3 mode). */
export function getBlobBackend(): BlobBackend {
  if (cachedBlobs) return cachedBlobs;
  cachedBlobs = storageMode() === "s3" ? new S3BlobBackend() : new LocalBlobBackend();
  return cachedBlobs;
}

/** Test seam: force a backend (null restores env selection). */
export function setBlobBackendForTests(backend: BlobBackend | null): void {
  cachedBlobs = backend;
}

// ---- the public blob API ----

/** Store bytes; returns the ref to keep in a database row. */
export async function blobPut(ns: BlobNamespace, path: string, bytes: Buffer | Uint8Array | string, mimeType?: string): Promise<string> {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  await getBlobBackend().put(ns, assertBlobPath(path), buf, mimeType || mimeForBlobPath(path) || "application/octet-stream");
  return blobRef(ns, path);
}

export async function blobGet(ns: BlobNamespace, path: string, range?: BlobRange): Promise<Buffer | null> {
  return getBlobBackend().get(ns, assertBlobPath(path), range);
}

/** First path that exists (new workspace-scoped key, then the legacy key). */
export async function blobGetFirst(ns: BlobNamespace, paths: string[]): Promise<Buffer | null> {
  for (const p of paths) {
    const got = await blobGet(ns, p);
    if (got) return got;
  }
  return null;
}

export async function blobHead(ns: BlobNamespace, path: string): Promise<BlobHead | null> {
  return getBlobBackend().head(ns, assertBlobPath(path));
}

export async function blobDelete(ns: BlobNamespace, path: string): Promise<void> {
  await getBlobBackend().delete(ns, assertBlobPath(path));
}

export async function blobList(ns: BlobNamespace, prefix = "", opts?: { delimiter?: "/" }): Promise<BlobListing> {
  return getBlobBackend().list(ns, prefix, opts);
}

/** Delete every object under a prefix (a site's working copy, a run's artifacts). */
export async function blobDeletePrefix(ns: BlobNamespace, prefix: string): Promise<number> {
  if (!prefix) throw new BlobKeyError("Refusing to delete a whole namespace.");
  const { objects } = await blobList(ns, prefix);
  for (const o of objects) await blobDelete(ns, o.path);
  return objects.length;
}

// ---- stored references (new blob refs and legacy filesystem paths) ----

const legacyWarned = new Set<string>();

export type StoredLocation =
  | { kind: "blob"; namespace: BlobNamespace; path: string }
  | { kind: "legacy"; absPath: string };

/**
 * Resolve what a DB row stores: a blob ref of the expected namespace, or a
 * legacy filesystem path (absolute, or relative to the app directory) that
 * stays inside the namespace's local directory (or one of `legacyRoots`).
 * Anything else — another namespace, a path escaping the roots — is null
 * (fail closed). Legacy paths are served while the file exists on this disk
 * (single-box installs); a one-time log line names the namespace.
 */
export interface StoredRefOptions {
  /** Extra directories a legacy path may live in (besides the namespace dir). */
  legacyRoots?: string[];
  /** Base for RELATIVE legacy paths (default: the app directory). */
  relativeTo?: string;
}

export function resolveStoredRef(
  ref: string | null | undefined,
  ns: BlobNamespace,
  opts: StoredRefOptions = {},
): StoredLocation | null {
  if (!ref || typeof ref !== "string") return null;
  if (isBlobRef(ref)) {
    const parsed = parseBlobRef(ref);
    if (!parsed || parsed.namespace !== ns) return null;
    return { kind: "blob", namespace: parsed.namespace, path: parsed.path };
  }
  const abs = resolve(isAbsolute(ref) ? ref : join(opts.relativeTo ?? process.cwd(), ref));
  const roots = [localBlobDir(ns), ...(opts.legacyRoots ?? [])].map((r) => resolve(r));
  if (!roots.some((r) => abs.startsWith(r + sep))) return null;
  if (!legacyWarned.has(ns)) {
    legacyWarned.add(ns);
    console.warn(
      `[storage] serving a legacy local path for namespace "${ns}" — fine on a single box; ` +
        `files written before MARKETR_STORAGE=s3 are not visible to other instances.`,
    );
  }
  return { kind: "legacy", absPath: abs };
}

/** Bytes behind a stored ref (null when missing or not resolvable). */
export async function readStoredRef(
  ref: string | null | undefined,
  ns: BlobNamespace,
  opts: StoredRefOptions & { range?: BlobRange } = {},
): Promise<Buffer | null> {
  const loc = resolveStoredRef(ref, ns, opts);
  if (!loc) return null;
  if (loc.kind === "blob") return blobGet(loc.namespace, loc.path, opts.range);
  return new LocalFileReader(loc.absPath).read(opts.range);
}

/** Size (and type) behind a stored ref; null when missing. */
export async function headStoredRef(
  ref: string | null | undefined,
  ns: BlobNamespace,
  opts: StoredRefOptions = {},
): Promise<BlobHead | null> {
  const loc = resolveStoredRef(ref, ns, opts);
  if (!loc) return null;
  if (loc.kind === "blob") return blobHead(loc.namespace, loc.path);
  try {
    const st = await stat(loc.absPath);
    return st.isFile() ? { size: st.size, contentType: mimeForBlobPath(loc.absPath), lastModified: st.mtime } : null;
  } catch {
    return null;
  }
}

/** Delete what a stored ref points at (legacy files too). Missing is fine. */
export async function deleteStoredRef(
  ref: string | null | undefined,
  ns: BlobNamespace,
  opts: StoredRefOptions = {},
): Promise<boolean> {
  const loc = resolveStoredRef(ref, ns, opts);
  if (!loc) return false;
  if (loc.kind === "blob") {
    await blobDelete(loc.namespace, loc.path);
    return true;
  }
  try {
    await unlink(loc.absPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return true;
    throw err;
  }
}

class LocalFileReader {
  constructor(private readonly absPath: string) {}
  async read(range?: BlobRange): Promise<Buffer | null> {
    try {
      if (!range) return await fsRead(this.absPath);
      const fh = await fsOpen(this.absPath, "r");
      try {
        const st = await fh.stat();
        const start = Math.max(0, range.start);
        const end = Math.min(range.end, st.size - 1);
        if (end < start) return Buffer.alloc(0);
        const buf = Buffer.alloc(end - start + 1);
        const { bytesRead } = await fh.read(buf, 0, buf.length, start);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  }
}
