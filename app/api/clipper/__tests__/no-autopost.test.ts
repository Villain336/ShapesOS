// Marketr — Phase 13C Worker 5: draft-first invariant proof.
// Run: npx tsx --test app/api/clipper/__tests__/no-autopost.test.ts
//
// DRAFT-FIRST IS LOAD-BEARING. The clipper may only ever create Postiz
// DRAFTS — never publish ("now") or schedule ("schedule"). This suite
// proves it three ways:
//   (a) the REAL queueClipDraftToPostiz() against a stubbed network
//       boundary emits an outgoing post type of EXACTLY "draft";
//   (b) _postiz-choke.ts contains no "now"/"schedule" string literals and
//       does not import the PostizPostType union, so those types are
//       unreachable by construction;
//   (c) no other file under app/api/clipper/ can reach schedulePostizPost
//       or the Postiz posts route at all (grep over the dir's source).
//
// NOTE on mocking: there is no vitest in this repo (and new deps are
// forbidden), and node:test's mock.module() is unavailable through tsx's
// CJS shim — so module-boundary interception is impossible here. Instead,
// (a) stubs the network boundary one layer down (global fetch) and asserts
// on the REAL wire payload the real choke code produces. That is the
// load-bearing invariant: what actually leaves the process.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { queueClipDraftToPostiz } from "../_postiz-choke";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHOKE_PATH = join(HERE, "..", "_postiz-choke.ts");
const CLIPPER_DIR = join(HERE, "..");

/** Strip // and block comments, respecting string literals. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let quote: string | null = null;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

// --- (a) network-boundary stub --------------------------------------------

interface CapturedCall {
  url: string;
  body: unknown;
}

const calls: CapturedCall[] = [];
let realFetch: typeof fetch;
let savedUrl: string | undefined;
let savedKey: string | undefined;

beforeEach(() => {
  calls.length = 0;
  realFetch = globalThis.fetch;
  savedUrl = process.env.POSTIZ_URL;
  savedKey = process.env.POSTIZ_API_KEY;
  // Dummy BYO-key config: postizFetch reads these at call time.
  process.env.POSTIZ_URL = "https://postiz.test";
  process.env.POSTIZ_API_KEY = "test-key";
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String((input as Request).url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "draft_test_1" }),
    };
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedUrl === undefined) delete process.env.POSTIZ_URL;
  else process.env.POSTIZ_URL = savedUrl;
  if (savedKey === undefined) delete process.env.POSTIZ_API_KEY;
  else process.env.POSTIZ_API_KEY = savedKey;
});

describe("no-autopost: draft-first invariant", () => {
  it("(a) queueClipDraftToPostiz emits type EXACTLY \"draft\" on the wire", async () => {
    const content = "Clip draft: speed to distribution is the moat";
    const queued = await queueClipDraftToPostiz({
      channelIds: ["ch_1", "ch_2"],
      content,
    });

    assert.equal(calls.length, 1, "exactly one Postiz API call");
    assert.ok(
      calls[0].url.endsWith("/public/v1/posts"),
      `must hit the Postiz posts route, got ${calls[0].url}`,
    );
    const payload = calls[0].body as Record<string, unknown>;
    assert.equal(
      payload.type,
      "draft",
      'outgoing post type must be EXACTLY "draft"',
    );
    assert.notEqual(payload.type, "now");
    assert.notEqual(payload.type, "schedule");
    const posts = payload.posts as Array<{
      value: Array<{ content: string }>;
    }>;
    assert.equal(
      posts[0].value[0].content,
      content,
      "draft body must carry the clip content",
    );
    assert.equal(
      queued.postizRef,
      "draft_test_1",
      "must surface the Postiz draft id",
    );
  });

  it('(b) the choke source has no "now"/"schedule" literals and no PostizPostType import', () => {
    const src = stripComments(readFileSync(CHOKE_PATH, "utf8"));

    for (const q of ['"', "'", "`"]) {
      assert.ok(
        !src.includes(`${q}now${q}`),
        `choke must not contain a ${q}now${q} string literal`,
      );
      assert.ok(
        !src.includes(`${q}schedule${q}`),
        `choke must not contain a ${q}schedule${q} string literal`,
      );
    }
    assert.ok(
      !src.includes("PostizPostType"),
      "choke must not import the PostizPostType union — " +
        '"now"/"schedule" must be unreachable by construction',
    );
    assert.ok(
      src.includes('type: "draft"'),
      'the single hardcoded type: "draft" must be present',
    );
    assert.ok(
      /import\s*\{\s*schedulePostizPost\s*\}\s*from/.test(src),
      "the only Postiz import must be schedulePostizPost",
    );
  });

  it("(c) no other file under app/api/clipper/ reaches Postiz posting", () => {
    const files = tsFiles(CLIPPER_DIR);
    assert.ok(
      files.length >= 5,
      `expected the clipper route tree, found ${files.length} files`,
    );
    for (const f of files) {
      if (f === CHOKE_PATH) continue;
      const stripped = stripComments(readFileSync(f, "utf8"));
      const rel = f.replace(CLIPPER_DIR + "/", "");
      assert.ok(
        !stripped.includes("schedulePostizPost"),
        `${rel}: only _postiz-choke.ts may call schedulePostizPost`,
      );
      assert.ok(
        !stripped.includes("postizFetch"),
        `${rel}: only the Postiz client may call postizFetch`,
      );
      assert.ok(
        !stripped.includes("/public/v1/posts"),
        `${rel}: only the Postiz client may touch the posts route`,
      );
      for (const q of ['"', "'", "`"]) {
        assert.ok(
          !stripped.includes(`type:${" "}${q}now${q}`) &&
            !stripped.includes(`type:${q}now${q}`),
          `${rel}: no "now" post type outside the choke`,
        );
        assert.ok(
          !stripped.includes(`type:${" "}${q}schedule${q}`) &&
            !stripped.includes(`type:${q}schedule${q}`),
          `${rel}: no "schedule" post type outside the choke`,
        );
      }
    }
  });
});
