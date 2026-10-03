// Phase 1 (untrusted content): CTV dev video path confinement + landing-tap
// SSRF guard.
// Run: npx tsx --test lib/flywheel/ctv/__tests__/untrusted-input.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readDevVideoPath, DevVideoPathError } from "../dev-video-path";
import { checkLandingTaps } from "../spot-kit";

describe("readDevVideoPath", () => {
  let base: string;
  let outside: string;
  before(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ctv-devpath-"));
    base = path.join(root, "base");
    outside = path.join(root, "outside");
    await mkdir(base);
    await mkdir(outside);
    await writeFile(path.join(base, "ok.mp4"), Buffer.from("video-bytes"));
    await writeFile(path.join(outside, "secret.txt"), "top secret");
    await symlink(path.join(outside, "secret.txt"), path.join(base, "link.mp4"));
    await mkdir(path.join(base, "dir.mp4"));
    await writeFile(path.join(base, "big.mp4"), Buffer.alloc(64));
  });
  after(async () => {
    await rm(path.dirname(base), { recursive: true, force: true });
  });

  const opts = () => ({ baseDir: base, nodeEnv: "development" });

  it("reads a regular file inside the base dir", async () => {
    const r = await readDevVideoPath(path.join(base, "ok.mp4"), opts());
    assert.equal(r.bytes.toString(), "video-bytes");
  });

  it("rejects .. traversal out of the base dir", async () => {
    await assert.rejects(
      readDevVideoPath(`${base}/../outside/secret.txt`, opts()),
      /restricted to the OS temp dir/,
    );
  });

  it("rejects a symlink that points outside the base dir", async () => {
    await assert.rejects(readDevVideoPath(path.join(base, "link.mp4"), opts()), DevVideoPathError);
  });

  it("rejects non-regular files and device paths", async () => {
    await assert.rejects(readDevVideoPath(path.join(base, "dir.mp4"), opts()), /regular file/);
    await assert.rejects(readDevVideoPath("/dev/zero", opts()), DevVideoPathError);
  });

  it("enforces the size cap", async () => {
    await assert.rejects(
      readDevVideoPath(path.join(base, "big.mp4"), { ...opts(), maxBytes: 10 }),
      /byte limit/,
    );
  });

  it("is disabled in production and rejects relative paths", async () => {
    await assert.rejects(
      readDevVideoPath(path.join(base, "ok.mp4"), { baseDir: base, nodeEnv: "production" }),
      /disabled in production/,
    );
    await assert.rejects(readDevVideoPath("ok.mp4", opts()), /absolute/);
  });
});

describe("checkLandingTaps SSRF guard", () => {
  it("never sends a HEAD to an internal hop", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (u: string | URL | Request) => {
      seen.push(String(u));
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
    }) as typeof fetch;
    const r = await checkLandingTaps("https://brand.example/offer", {
      fetchImpl,
      resolve: async () => ["93.184.216.34"],
    });
    assert.equal(r.ok, false);
    assert.match(r.detail, /landing check failed/);
    assert.deepEqual(seen, ["https://brand.example/offer"]);
  });

  it("counts taps on a public chain", async () => {
    const fetchImpl = (async (u: string | URL | Request) =>
      String(u).endsWith("/a")
        ? new Response(null, { status: 301, headers: { location: "/b" } })
        : new Response(null, { status: 200 })) as typeof fetch;
    const r = await checkLandingTaps("https://brand.example/a", {
      fetchImpl,
      resolve: async () => ["93.184.216.34"],
    });
    assert.equal(r.ok, true);
    assert.equal(r.taps, 2);
  });
});
