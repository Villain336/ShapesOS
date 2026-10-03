// Marketr — Phase 11 "Canvas": server-side render (document → PNG) tests.
// Run: npx tsx --test lib/design/__tests__/render-server.test.ts
//
// Asserts: invalid documents are rejected (never rendered); a small fixture
// document rasterizes to a valid PNG with the expected dimensions at 1x and
// 2x; remote images are fetched and embedded; a single failing image becomes
// a placeholder instead of failing the render. No brittle pixel diffs —
// only the PNG signature and dimensions.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  isBlockedIp,
  renderDocumentToPng,
  type RenderSuccess,
} from "../render-server";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function base(el: Record<string, unknown>) {
  return {
    id: `el-${Math.random().toString(36).slice(2, 8)}`,
    name: "el",
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    ...el,
  };
}

function fixtureDoc(withImage?: { id: string; src: string }) {
  const elements: Record<string, unknown>[] = [
    base({ type: "rect", x: 10, y: 10, width: 120, height: 80, fill: "#7c3aed", cornerRadius: 8 }),
    base({
      type: "text",
      x: 160,
      y: 40,
      text: "Hello render",
      fontFamily: "Inter",
      fontSize: 32,
      fontStyle: "bold",
      fill: "#1c1917",
      align: "left",
      lineHeight: 1.2,
      letterSpacing: 0,
    }),
    base({
      type: "chart",
      x: 10,
      y: 120,
      chartType: "bar",
      labels: ["A", "B", "C"],
      values: [10, 20, 15],
      colors: ["#7c3aed"],
      showValues: true,
    }),
    base({
      type: "qr",
      x: 300,
      y: 180,
      payload: "https://example.com",
      size: 90,
      foreground: "#000000",
      background: "#ffffff",
    }),
  ];
  if (withImage) {
    elements.push(
      base({
        type: "image",
        id: withImage.id,
        x: 200,
        y: 120,
        src: withImage.src,
        width: 100,
        height: 100,
        cornerRadius: 0,
      }),
    );
  }
  return {
    schemaVersion: 1,
    pages: [
      {
        id: "page-1",
        name: "Page 1",
        width: 400,
        height: 300,
        background: "#ffffff",
        elements,
      },
    ],
  };
}

function tinyPngBuffer(): Buffer {
  // 2x2 red PNG
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8AARAwMDEB" +
      "8R8oGAQYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGAEA" +
      "AP//AwAKzQpFAAAAAElFTkSuQmCC",
    "base64",
  );
}

function mockFetchOk() {
  const png = tinyPngBuffer();
  return (async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(new Uint8Array(png), {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  }) as typeof fetch;
}

describe("isBlockedIp (SSRF guard)", () => {
  it("blocks loopback, private, link-local, metadata, multicast", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "224.0.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
    ]) {
      assert.equal(isBlockedIp(ip), true, ip);
    }
  });
  it("allows public addresses", () => {
    for (const ip of ["93.184.216.34", "151.101.1.69", "8.8.8.8"]) {
      assert.equal(isBlockedIp(ip), false, ip);
    }
  });
});

describe("renderDocumentToPng — validation", () => {
  it("rejects a non-object document", async () => {
    const r = await renderDocumentToPng(null);
    assert.equal(r.ok, false);
  });
  it("rejects a document with no pages", async () => {
    const r = await renderDocumentToPng({ schemaVersion: 1, pages: [] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /pages/);
  });
  it("rejects an unknown element type", async () => {
    const doc = fixtureDoc();
    doc.pages[0].elements.push(base({ type: "hologram" }));
    const r = await renderDocumentToPng(doc);
    assert.equal(r.ok, false);
  });
  it("rejects an unknown pageId", async () => {
    const r = await renderDocumentToPng(fixtureDoc(), { pageId: "nope" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /page not found/);
  });
});

describe("renderDocumentToPng — rasterization", () => {
  it("renders a fixture to a valid PNG at 1x with page dimensions", async () => {
    const r = await renderDocumentToPng(fixtureDoc(), {}, { resolveHost: async () => ["93.184.216.34"] });
    assert.equal(r.ok, true);
    const ok = r as RenderSuccess;
    assert.ok(ok.png.subarray(0, 8).equals(PNG_SIG), "PNG signature");
    assert.equal(ok.width, 400);
    assert.equal(ok.height, 300);
    assert.equal(ok.pageId, "page-1");
  });

  it("renders at 2x with doubled dimensions", async () => {
    const r = await renderDocumentToPng(fixtureDoc(), { scale: 2 });
    assert.equal(r.ok, true);
    const ok = r as RenderSuccess;
    assert.ok(ok.png.subarray(0, 8).equals(PNG_SIG), "PNG signature");
    assert.equal(ok.width, 800);
    assert.equal(ok.height, 600);
  });

  it("clamps scale above the cap to 3x", async () => {
    const r = await renderDocumentToPng(fixtureDoc(), { scale: 99 });
    assert.equal(r.ok, true);
    const ok = r as RenderSuccess;
    assert.equal(ok.width, 1200);
    assert.equal(ok.height, 900);
  });
});

describe("renderDocumentToPng — images", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mockFetchOk();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("embeds a fetched remote image without warnings", async () => {
    const doc = fixtureDoc({ id: "img-1", src: "https://cdn.example.com/a.png" });
    const r = await renderDocumentToPng(
      doc,
      {},
      {
        fetchImpl: globalThis.fetch,
        resolveHost: async () => ["93.184.216.34"],
      },
    );
    assert.equal(r.ok, true);
    const ok = r as RenderSuccess;
    assert.ok(ok.png.subarray(0, 8).equals(PNG_SIG));
    assert.equal(ok.warnings.length, 0);
  });

  it("a failing image becomes a placeholder, not a failed render", async () => {
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as typeof fetch;
    const doc = fixtureDoc({ id: "img-2", src: "https://cdn.example.com/b.png" });
    const r = await renderDocumentToPng(
      doc,
      {},
      {
        fetchImpl: globalThis.fetch,
        resolveHost: async () => ["93.184.216.34"],
      },
    );
    assert.equal(r.ok, true);
    const ok = r as RenderSuccess;
    assert.ok(ok.png.subarray(0, 8).equals(PNG_SIG));
    assert.equal(ok.warnings.length, 1);
    assert.equal(ok.warnings[0].elementId, "img-2");
  });

  it("a blocked (SSRF) host never hits the network", async () => {
    let fetched = false;
    const spy = (async () => {
      fetched = true;
      return new Response(new Uint8Array(tinyPngBuffer()), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }) as typeof fetch;
    const doc = fixtureDoc({ id: "img-3", src: "http://127.0.0.1/internal.png" });
    const r = await renderDocumentToPng(doc, {}, { fetchImpl: spy });
    assert.equal(r.ok, true);
    assert.equal(fetched, false, "fetch must not be called for blocked hosts");
    const ok = r as RenderSuccess;
    assert.equal(ok.warnings.length, 1);
    assert.equal(ok.warnings[0].elementId, "img-3");
  });

  it("never follows a redirect hop into an internal address (blind SSRF)", async () => {
    const seen: string[] = [];
    const redirecting = (async (u: string | URL | Request) => {
      seen.push(String(u));
      return new Response(null, { status: 302, headers: { location: "http://[::ffff:a9fe:a9fe]/latest/" } });
    }) as typeof fetch;
    const doc = fixtureDoc({ id: "img-4", src: "https://cdn.example.com/a.png" });
    const r = await renderDocumentToPng(doc, {}, {
      fetchImpl: redirecting,
      resolveHost: async () => ["93.184.216.34"],
    });
    assert.equal(r.ok, true);
    assert.deepEqual(seen, ["https://cdn.example.com/a.png"], "the internal hop is never requested");
    const ok = r as RenderSuccess;
    assert.equal(ok.warnings.length, 1);
    assert.match(ok.warnings[0].message, /blocked host/);
  });
});
