// Phase 19A (WS=server): agent mode's spoken limit and maxUsd validation,
// the desktop release feed parser, request limits and the UI map reader.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spokenMaxUsd, validateMaxUsd } from "../agent";
import { archOf, desktopReleases, parseLatestYml } from "@/lib/desktop-app/releases";
import { TurnBodySchema, base64Bytes, screenshotLimitError, MAX_SCREENSHOT_BYTES } from "../validate";
import { collectUiMap } from "../ui-map";

describe("agent mode limits", () => {
  it("reads the spoken limit", () => {
    assert.equal(spokenMaxUsd("research our competitors in the background, max $3"), 3);
    assert.equal(spokenMaxUsd("do it in the background maximum 2.50 dollars"), 2.5);
    assert.equal(spokenMaxUsd("up to five dollars please"), 5);
    assert.equal(spokenMaxUsd("budget of $1"), 1);
    assert.equal(spokenMaxUsd("do it in the background"), null);
    assert.equal(spokenMaxUsd("max $0"), null);
  });
  it("validates > 0 and ≤ the plan ceiling", () => {
    assert.deepEqual(validateMaxUsd(3, "pro"), { ok: true, microUsd: 3_000_000, maxUsd: 3 });
    assert.equal(validateMaxUsd(0, "pro").ok, false);
    assert.equal(validateMaxUsd(-1, "pro").ok, false);
    assert.equal(validateMaxUsd(Number.NaN, "pro").ok, false);
    assert.equal(validateMaxUsd(6, "starter").ok, false);
    assert.equal(validateMaxUsd(2, "trial").ok, false);
  });
});

const MAC_YML = `version: 1.2.3
files:
  - url: ShapesOS-1.2.3-universal.dmg
    sha512: abc==
    size: 123456789
  - url: ShapesOS-1.2.3-universal-mac.zip
    sha512: zzz==
    size: 1
path: ShapesOS-1.2.3-universal-mac.zip
sha512: zzz==
releaseDate: '2026-10-06T12:00:00.000Z'
`;
const WIN_YML = `version: 1.2.3
files:
  - url: ShapesOS-Setup-1.2.3.exe
    sha512: def==
    size: 98765432
path: ShapesOS-Setup-1.2.3.exe
`;

describe("desktop releases", () => {
  it("parses electron-builder latest*.yml", () => {
    const p = parseLatestYml(MAC_YML);
    assert.equal(p.version, "1.2.3");
    assert.equal(p.releaseDate, "2026-10-06T12:00:00.000Z");
    assert.equal(p.files.length, 2);
    assert.deepEqual(p.files[0], { url: "ShapesOS-1.2.3-universal.dmg", sha512: "abc==", size: 123456789 });
    assert.equal(archOf("ShapesOS-1.2.3-arm64.dmg"), "arm64");
    assert.equal(archOf("ShapesOS-Setup-1.2.3.exe"), "x64");
  });
  it("no feed → not configured, nothing made up", async () => {
    const r = await desktopReleases("stable", { env: {} });
    assert.deepEqual(r, { configured: false, channel: "stable", version: null, releaseDate: null, files: [] });
    assert.equal((await desktopReleases("stable", { env: { DESKTOP_UPDATE_URL: "http://insecure" } })).configured, false);
  });
  it("lists the .dmg and .exe with absolute URLs", async () => {
    const f = (async (url: string) =>
      url.endsWith("latest-mac.yml") ? new Response(MAC_YML) : url.endsWith("latest.yml") ? new Response(WIN_YML) : new Response("", { status: 404 })) as unknown as typeof fetch;
    const r = await desktopReleases("beta", { env: { DESKTOP_UPDATE_URL: "https://dl.example.com/desktop/" }, fetchImpl: f });
    assert.equal(r.configured, true);
    assert.equal(r.version, "1.2.3");
    assert.deepEqual(
      r.files.map((x) => [x.os, x.arch, x.url]),
      [
        ["mac", "universal", "https://dl.example.com/desktop/beta/ShapesOS-1.2.3-universal.dmg"],
        ["windows", "x64", "https://dl.example.com/desktop/beta/ShapesOS-Setup-1.2.3.exe"],
      ],
    );
  });
});

describe("turn limits", () => {
  const shot = (n: number, b64 = "QUJD") => ({ screen: n, width: 10, height: 10, scaleFactor: 1, primary: n === 0, jpegBase64: b64 });
  it("≤ 4 screenshots and ≤ 6 MB, else a 413 reason", () => {
    assert.equal(screenshotLimitError([shot(0), shot(1), shot(2), shot(3)]), null);
    assert.match(String(screenshotLimitError([0, 1, 2, 3, 4].map((n) => shot(n)))), /At most 4/);
    const big = "A".repeat(Math.ceil(((MAX_SCREENSHOT_BYTES + 10) * 4) / 3));
    assert.match(String(screenshotLimitError([shot(0, big)])), /6 MB/);
    assert.equal(base64Bytes("QUJD"), 3);
    assert.equal(base64Bytes("QQ=="), 1);
  });
  it("the body schema refuses non-base64 and empty transcripts", () => {
    assert.equal(TurnBodySchema.safeParse({ transcript: "hi", screenshots: [shot(0, "not base64!")] }).success, false);
    assert.equal(TurnBodySchema.safeParse({ transcript: "   ", screenshots: [] }).success, false);
    assert.equal(TurnBodySchema.safeParse({ transcript: "hi" }).success, true);
  });
});

describe("collectUiMap", () => {
  const el = (id: string, rect: { left: number; top: number; width: number; height: number }, attrs: Record<string, string> = {}, hidden = false) => ({
    getAttribute: (n: string) => ({ "data-cursor-id": id, "data-cursor-label": `L ${id}`, "data-cursor-role": "link", ...attrs })[n] ?? null,
    getBoundingClientRect: () => rect,
    closest: () => (hidden ? {} : null),
  });
  it("returns visible elements once, in page order", () => {
    const els = [
      el("nav:/a", { left: 10, top: 10, width: 100, height: 40 }),
      el("nav:/a", { left: 10, top: 60, width: 100, height: 40 }),
      el("zero", { left: 0, top: 0, width: 0, height: 0 }),
      el("offscreen", { left: 5000, top: 0, width: 10, height: 10 }),
      el("hidden", { left: 1, top: 1, width: 10, height: 10 }, {}, true),
      el("shell:topbar", { left: 0.4, top: 0, width: 800.6, height: 56 }),
    ];
    const doc = { querySelectorAll: () => els };
    const out = collectUiMap(doc as never, { innerWidth: 1280, innerHeight: 800 });
    assert.deepEqual(out.map((o) => o.id), ["nav:/a", "shell:topbar"]);
    assert.deepEqual(out[0], { id: "nav:/a", label: "L nav:/a", role: "link", rect: { x: 10, y: 10, w: 100, h: 40 } });
  });
});
