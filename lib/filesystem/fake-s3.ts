// ShapesOS — an in-process, S3-COMPATIBLE FAKE for tests and the
// multi-instance smoke (scripts/smoke/multi-instance.mts). TEST/SMOKE ONLY:
// no application module imports this file, and it is labelled as a fake
// everywhere it is used. There is no Docker daemon in the build box, so
// MinIO cannot run; this fake stands in for it.
//
// What it does, path-style only (http://127.0.0.1:<port>/<bucket>/<key>):
//   PUT object · GET object (incl. Range) · HEAD object · DELETE object ·
//   GET bucket?list-type=2 (prefix, delimiter, max-keys, continuation-token).
// Every request must carry a valid AWS SigV4 Authorization header for the
// configured key pair: the fake rebuilds the canonical request from what
// actually arrived on the wire and recomputes the signature with the SAME
// pure signer the app uses (lib/filesystem/storage.ts signV4) — so a mismatch
// between what the client signs and what it sends fails here (403).

import { createServer, type IncomingMessage, type Server } from "node:http";
import { s3CanonicalPath, s3CanonicalQuery, sha256Hex, signV4 } from "./storage";

export interface FakeS3Options {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** Page size cap for list-type=2 (tests exercise paging with a small one). */
  maxKeys?: number;
}

export interface FakeS3 {
  server: Server;
  endpoint: string;
  objects: Map<string, { body: Buffer; contentType: string; lastModified: Date }>;
  requests: Array<{ method: string; path: string; signed: boolean }>;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Verify a request's SigV4 header the way S3 does (header-based auth). */
function verifySignature(req: IncomingMessage, rawPath: string, rawQuery: string, body: Buffer, opts: FakeS3Options): boolean {
  const auth = req.headers.authorization ?? "";
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return false;
  const [, keyId, , region, signedHeaders, signature] = m;
  if (keyId !== opts.accessKeyId || region !== (opts.region ?? "us-east-1")) return false;
  const amzDate = String(req.headers["x-amz-date"] ?? "");
  const dm = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (!dm) return false;
  const now = new Date(Date.UTC(+dm[1]!, +dm[2]! - 1, +dm[3]!, +dm[4]!, +dm[5]!, +dm[6]!));
  if (Math.abs(Date.now() - now.getTime()) > 15 * 60_000) return false;
  const payloadHash = String(req.headers["x-amz-content-sha256"] ?? "");
  if (payloadHash !== sha256Hex(body)) return false;
  // Re-canonicalize the query exactly as S3 does: decode, then sort + encode.
  const query: Record<string, string> = {};
  for (const part of rawQuery ? rawQuery.split("&") : []) {
    const eq = part.indexOf("=");
    const k = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
    query[k] = eq < 0 ? "" : decodeURIComponent(part.slice(eq + 1));
  }
  const headers: Record<string, string> = {};
  for (const h of signedHeaders!.split(";")) {
    if (["host", "x-amz-date", "x-amz-content-sha256", "x-amz-security-token"].includes(h)) continue;
    const v = req.headers[h];
    if (v === undefined) return false;
    headers[h] = Array.isArray(v) ? v.join(",") : String(v);
  }
  const token = req.headers["x-amz-security-token"];
  const expected = signV4({
    method: req.method ?? "GET",
    host: String(req.headers.host ?? ""),
    canonicalPath: s3CanonicalPath(decodeURIComponent(rawPath)),
    canonicalQuery: s3CanonicalQuery(query),
    headers,
    payloadHash,
    region: region!,
    credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey, sessionToken: token ? String(token) : undefined },
    now,
  });
  return expected.signature === signature && expected.headers.authorization.includes(`SignedHeaders=${signedHeaders}`);
}

export async function startFakeS3(opts: FakeS3Options): Promise<FakeS3> {
  const objects = new Map<string, { body: Buffer; contentType: string; lastModified: Date }>();
  const requests: FakeS3["requests"] = [];
  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const q = url.indexOf("?");
    const rawPath = q < 0 ? url : url.slice(0, q);
    const rawQuery = q < 0 ? "" : url.slice(q + 1);
    const body = await readBody(req);
    const signed = verifySignature(req, rawPath, rawQuery, body, opts);
    requests.push({ method: req.method ?? "", path: rawPath, signed });
    if (!signed) {
      res.writeHead(403, { "content-type": "application/xml" });
      res.end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
      return;
    }
    const path = decodeURIComponent(rawPath);
    const prefix = `/${opts.bucket}`;
    if (path !== prefix && !path.startsWith(`${prefix}/`)) {
      res.writeHead(404).end("<Error><Code>NoSuchBucket</Code></Error>");
      return;
    }
    const key = path.slice(prefix.length + 1);
    if (!key) {
      // Bucket-level: ListObjectsV2.
      const params = new URLSearchParams(rawQuery);
      if (req.method !== "GET" || params.get("list-type") !== "2") {
        res.writeHead(400).end();
        return;
      }
      const pfx = params.get("prefix") ?? "";
      const delimiter = params.get("delimiter");
      const max = Math.min(Number(params.get("max-keys") ?? 1000), opts.maxKeys ?? 1000);
      const after = params.get("continuation-token");
      const keys = [...objects.keys()].filter((k) => k.startsWith(pfx)).sort();
      const contents: string[] = [];
      const common = new Set<string>();
      for (const k of keys) {
        if (delimiter) {
          const rest = k.slice(pfx.length);
          const d = rest.indexOf(delimiter);
          if (d >= 0) {
            common.add(pfx + rest.slice(0, d + 1));
            continue;
          }
        }
        contents.push(k);
      }
      const start = after ? contents.findIndex((k) => k > after) : 0;
      const page = start < 0 ? [] : contents.slice(start, start + max);
      const truncated = start >= 0 && start + max < contents.length;
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${opts.bucket}</Name><Prefix>${xmlEsc(pfx)}</Prefix>` +
        page
          .map((k) => {
            const o = objects.get(k)!;
            return `<Contents><Key>${xmlEsc(k)}</Key><LastModified>${o.lastModified.toISOString()}</LastModified><Size>${o.body.length}</Size></Contents>`;
          })
          .join("") +
        (after ? "" : [...common].sort().map((p) => `<CommonPrefixes><Prefix>${xmlEsc(p)}</Prefix></CommonPrefixes>`).join("")) +
        `<IsTruncated>${truncated}</IsTruncated>` +
        (truncated ? `<NextContinuationToken>${xmlEsc(page[page.length - 1]!)}</NextContinuationToken>` : "") +
        `</ListBucketResult>`;
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(xml);
      return;
    }
    const obj = objects.get(key);
    switch (req.method) {
      case "PUT":
        objects.set(key, { body, contentType: String(req.headers["content-type"] ?? "application/octet-stream"), lastModified: new Date() });
        res.writeHead(200).end();
        return;
      case "HEAD":
        if (!obj) return void res.writeHead(404).end();
        res.writeHead(200, { "content-length": String(obj.body.length), "content-type": obj.contentType, "last-modified": obj.lastModified.toUTCString() });
        res.end();
        return;
      case "GET": {
        if (!obj) return void res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
        const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
        if (range) {
          const s = Number(range[1]);
          const e = Math.min(range[2] ? Number(range[2]) : obj.body.length - 1, obj.body.length - 1);
          if (s >= obj.body.length) return void res.writeHead(416).end();
          res.writeHead(206, { "content-type": obj.contentType, "content-range": `bytes ${s}-${e}/${obj.body.length}` });
          res.end(obj.body.subarray(s, e + 1));
          return;
        }
        res.writeHead(200, { "content-type": obj.contentType, "content-length": String(obj.body.length) });
        res.end(obj.body);
        return;
      }
      case "DELETE":
        objects.delete(key);
        res.writeHead(204).end();
        return;
      default:
        res.writeHead(405).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    server,
    endpoint: `http://127.0.0.1:${port}`,
    objects,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
