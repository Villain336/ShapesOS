// Phase 1 (untrusted content): clipper URL sources go through safeFetch.
// Run: npx tsx --test app/api/clipper/__tests__/url-source-ssrf.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { downloadUrlBytes } from "../_pipeline";
import { UnsafeUrlError } from "@/lib/safe-url";

describe("clipper downloadUrlBytes SSRF guard", () => {
  it("refuses internal targets without fetching", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("x");
    }) as typeof fetch;
    for (const url of [
      "http://169.254.169.254/latest/meta-data/iam/",
      "http://[::ffff:a9fe:a9fe]/",
      "http://minio.internal:9000/bucket/key",
    ]) {
      await assert.rejects(
        downloadUrlBytes(url, { fetchImpl, resolve: async () => ["172.18.0.3"] }),
        UnsafeUrlError,
      );
    }
    assert.equal(calls, 0);
  });

  it("refuses a redirect into an internal address", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (u: string | URL | Request) => {
      seen.push(String(u));
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:3000/" } });
    }) as typeof fetch;
    await assert.rejects(
      downloadUrlBytes("https://cdn.example/video.mp4", { fetchImpl, resolve: async () => ["93.184.216.34"] }),
      UnsafeUrlError,
    );
    assert.deepEqual(seen, ["https://cdn.example/video.mp4"]);
  });

  it("downloads a public URL", async () => {
    const fetchImpl = (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;
    const buf = await downloadUrlBytes("https://cdn.example/v.mp4", {
      fetchImpl,
      resolve: async () => ["93.184.216.34"],
    });
    assert.equal(buf.length, 3);
  });
});
