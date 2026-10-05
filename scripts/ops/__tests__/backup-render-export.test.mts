// Deploy PR: scripts/ops/backup.sh BACKUP_SOURCE=render-export against a FAKE
// Render API and a FAKE S3 endpoint (both local HTTP servers in this test —
// mocks, not Render or R2). Proves the request sequence, that the API key
// never reaches the export download or the bucket, that a corrupt or missing
// export fails the run, and that the upload is SigV4-signed.
// Run: npx tsx --test scripts/ops/__tests__/backup-render-export.test.mts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const SCRIPT = join(process.cwd(), "scripts/ops/backup.sh");
const KEY = "rnd_test_key_never_leaks";

interface Hit {
  method: string;
  url: string;
  auth: string | undefined;
  sha: string | undefined;
  bytes: number;
}

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

function run(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", [SCRIPT], {
      env: { PATH: process.env.PATH ?? "", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

describe("backup.sh BACKUP_SOURCE=render-export (fake Render API + fake S3)", () => {
  const work = mkdtempSync(join(tmpdir(), "shapes-backup-test-"));
  const archive = join(work, "export.dir.tar.gz");
  let api: Server;
  let apiUrl = "";
  let hits: Hit[] = [];
  let mode: "ok" | "never" | "corrupt" | "unauthorized" = "ok";
  let posted = false;
  let polls = 0;

  before(async () => {
    const src = join(work, "src", "2026-10-05T03_17Z", "shapesos");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "toc.dat"), "fake pg_dump directory format");
    execFileSync("tar", ["-czf", archive, "-C", join(work, "src"), "."]);

    api = createServer(async (req, res) => {
      const b = await body(req);
      hits.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        sha: req.headers["x-amz-content-sha256"] as string | undefined,
        bytes: b.length,
      });
      const url = req.url ?? "";
      if (url.startsWith("/v1/postgres/")) {
        if (req.headers.authorization !== `Bearer ${KEY}` || mode === "unauthorized") {
          res.writeHead(401).end('{"message":"unauthorized"}');
          return;
        }
        if (req.method === "POST") {
          posted = true;
          res.writeHead(202).end();
          return;
        }
        const old = { id: "exp-old", createdAt: "2026-10-04T03:17:00Z", url: `${apiUrl}/download/old` };
        if (!posted || mode === "never") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([old]));
          return;
        }
        polls += 1;
        // First poll: the new export exists but has no URL yet (still running).
        const fresh = { id: "exp-new", createdAt: "2026-10-05T03:17:00Z", ...(polls > 1 ? { url: `${apiUrl}/download/new` } : {}) };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([fresh, old]));
        return;
      }
      if (url === "/download/new") {
        res.writeHead(200).end(mode === "corrupt" ? Buffer.from("not a tarball") : readFileSync(archive));
        return;
      }
      if (url.startsWith("/bucket/")) {
        res.writeHead(200).end();
        return;
      }
      res.writeHead(404).end();
    });
    apiUrl = await listen(api);
  });

  after(() => {
    api.close();
    rmSync(work, { recursive: true, force: true });
  });

  const env = (dir: string): Record<string, string> => ({
    BACKUP_SOURCE: "render-export",
    RENDER_API_KEY: KEY,
    RENDER_POSTGRES_ID: "dpg-test123",
    RENDER_API_BASE: `${apiUrl}/v1`,
    BACKUP_EXPORT_POLL_SECONDS: "0",
    BACKUP_EXPORT_TIMEOUT_SECONDS: "5",
    BACKUP_DIR: dir,
    BACKUP_RETENTION_DAYS: "14",
    BACKUP_S3_BUCKET: "bucket",
    BACKUP_S3_ENDPOINT: apiUrl,
    BACKUP_S3_REGION: "auto",
    BACKUP_S3_PREFIX: "backups/",
    BACKUP_S3_ACCESS_KEY: "AKIDEXAMPLE",
    BACKUP_S3_SECRET_KEY: "s3-secret-example",
  });
  const reset = (m: typeof mode) => {
    mode = m;
    hits = [];
    posted = false;
    polls = 0;
  };

  it("requests an export, waits for it, downloads, verifies and uploads it signed", async () => {
    reset("ok");
    const dir = join(work, "ok");
    const r = await run(env(dir));
    assert.equal(r.code, 0, r.out);
    const files = readdirSync(dir).sort();
    assert.equal(files.length, 2, files.join(","));
    assert.match(files[0]!, /^shapesos-render-dpg-test123-\d{8}T\d{6}Z\.dir\.tar\.gz$/);
    assert.equal(files[1], `${files[0]}.sha256`);
    assert.ok(readFileSync(join(dir, files[1]!), "utf8").includes(files[0]!));

    const seq = hits.map((h) => `${h.method} ${h.url.replace(/shapesos-render-.*$/, "<name>")}`);
    assert.deepEqual(seq.slice(0, 2), ["GET /v1/postgres/dpg-test123/export", "POST /v1/postgres/dpg-test123/export"]);
    assert.ok(seq.includes("GET /download/new"), seq.join("\n"));
    const puts = hits.filter((h) => h.method === "PUT");
    assert.deepEqual(puts.map((h) => h.url.replace(/\d{8}T\d{6}Z/, "<ts>")), [
      "/bucket/backups/shapesos-render-dpg-test123-<ts>.dir.tar.gz",
      "/bucket/backups/shapesos-render-dpg-test123-<ts>.dir.tar.gz.sha256",
    ]);
    for (const p of puts) {
      assert.match(p.auth ?? "", /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/);
      assert.ok(p.sha, "x-amz-content-sha256 is sent");
    }
    assert.equal(puts[0]!.bytes, readFileSync(archive).length);
    // The Render API key goes only to the Render API.
    for (const h of hits.filter((x) => !x.url.startsWith("/v1/"))) assert.ok(!(h.auth ?? "").includes(KEY), h.url);
    assert.doesNotMatch(r.out, new RegExp(KEY));
    assert.doesNotMatch(r.out, /s3-secret-example/);
  });

  it("fails when the export never appears (timeout)", async () => {
    reset("never");
    const r = await run({ ...env(join(work, "never")), BACKUP_EXPORT_TIMEOUT_SECONDS: "1", BACKUP_EXPORT_POLL_SECONDS: "1" });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /did not finish within 1s/);
    assert.equal(hits.filter((h) => h.method === "PUT").length, 0);
  });

  it("fails when the download does not unpack, and uploads nothing", async () => {
    reset("corrupt");
    const dir = join(work, "corrupt");
    const r = await run(env(dir));
    assert.notEqual(r.code, 0);
    assert.match(r.out, /does not unpack/);
    assert.equal(hits.filter((h) => h.method === "PUT").length, 0);
    assert.deepEqual(readdirSync(dir), [], "the partial file is removed");
  });

  it("fails on an API error", async () => {
    reset("unauthorized");
    const r = await run(env(join(work, "unauth")));
    assert.notEqual(r.code, 0);
    assert.match(r.out, /listing Render exports failed/);
  });

  it("refuses to start without its settings or with an unknown source", async () => {
    reset("ok");
    const base = env(join(work, "cfg"));
    const { RENDER_POSTGRES_ID: _id, ...noId } = base;
    let r = await run(noId);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /needs RENDER_POSTGRES_ID/);
    const { RENDER_API_KEY: _key, ...noKey } = base;
    r = await run(noKey);
    assert.match(r.out, /needs RENDER_API_KEY/);
    r = await run({ ...base, BACKUP_SOURCE: "nope" });
    assert.match(r.out, /BACKUP_SOURCE must be pg_dump or render-export/);
    assert.equal(hits.length, 0, "nothing was called");
  });
});
