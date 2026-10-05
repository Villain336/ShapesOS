// ShapesOS — route error-handling sweep (FULL-AUDIT-2026-10-03 §5).
// Run: npx tsx --test lib/api/__tests__/route-errors.test.ts
//
// ~25 routes answered ordinary client errors with 500 (and echoed raw
// internal messages). Route handlers need a Next request scope for the
// session, so this suite drives the REAL lib code paths those routes call
// (no database needed — every case throws before the first query) through
// the routes' shared catch-all, and pins the route sources so the old
// patterns can't creep back.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { httpErrorResponse } from "../../enrichment/guard";
import { assertEddmTransition } from "../../mail/eddm";
import { upsertEntry } from "../../voice/pronunciation";
import { createVoiceoverJob } from "../../voice/voiceover";
import { createAgent } from "../../voice/agents";
import { createUniverDoc } from "../../univer/docs";
import { NangoCloudDriveAdapter, nangoCloudConfigFromEnv } from "../../datasetbuilder/nango";
import { DatasetBuilderError } from "../../datasetbuilder/types";
import { SpendFieldsSchema, SpendInputSchema } from "../../attribution/spend";
import { INTERNAL_ERROR_MESSAGE } from "../errors";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function caught(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected a throw");
}

async function mapped(fn: () => unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = httpErrorResponse(await caught(fn));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("audited routes: lib errors map to 4xx through the shared catch-all", () => {
  it("eddm/orders/[id]/status: unknown status → 400, illegal transition → 409", async () => {
    const unknown = await mapped(() => assertEddmTransition("draft", "bogus"));
    assert.equal(unknown.status, 400);
    assert.match(String(unknown.body.error), /Unknown EDDM status/);
    const illegal = await mapped(() => assertEddmTransition("complete", "draft"));
    assert.equal(illegal.status, 409);
  });

  it("voice/pronunciation: empty term → 400 (was the blanket 400/500 catch)", async () => {
    const r = await mapped(() => upsertEntry("ws", { term: " ", phonetic: "x", source: "manual" }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Pronunciation term is required.");
  });

  it("voice/voiceovers: empty script → 400", async () => {
    const r = await mapped(() => createVoiceoverJob("ws", { script: "", voiceId: "" }));
    assert.equal(r.status, 400);
  });

  it("voice/agents: missing name → 400", async () => {
    const r = await mapped(() => createAgent("ws", { name: "", voiceId: "alloy" }));
    assert.equal(r.status, 400);
  });

  it("office/docs: invalid kind → 400", async () => {
    const r = await mapped(() =>
      createUniverDoc("ws", { kind: "bogus" as never, title: "t", snapshot: {} }),
    );
    assert.equal(r.status, 400);
  });

  it("datasets/drive/files: Drive not connected → 503 with a code, not 500", async () => {
    const prev = process.env.NANGO_SECRET_KEY;
    delete process.env.NANGO_SECRET_KEY;
    try {
      const r = await mapped(() => new NangoCloudDriveAdapter(nangoCloudConfigFromEnv("")));
      assert.equal(r.status, 503);
      assert.equal(r.body.code, "NANGO_NOT_CONFIGURED");
    } finally {
      if (prev !== undefined) process.env.NANGO_SECRET_KEY = prev;
    }
  });

  it("datasets/sources: unknown kind (VALIDATION_FAILED) → 400; integrity faults stay a generic 500", async () => {
    const bad = await mapped(() => {
      throw new DatasetBuilderError("VALIDATION_FAILED", 'kind must be "paste", "web", "drive", or multipart "upload"');
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "VALIDATION_FAILED");
    assert.equal((await mapped(() => {
      throw new DatasetBuilderError("UNKNOWN_DATASET", "nope");
    })).status, 404);
    const spy = mock.method(console, "error", () => {});
    try {
      const internal = await mapped(() => {
        throw new DatasetBuilderError("LINEAGE_BROKEN", "version v3 lineage row missing");
      });
      assert.equal(internal.status, 500);
      assert.equal(internal.body.error, INTERNAL_ERROR_MESSAGE);
    } finally {
      spy.mock.restore();
    }
  });

  it("attribution/spend/[id] PATCH: {} parses (zod 4 threw on .partial() of a refined object)", () => {
    assert.throws(() => (SpendInputSchema as unknown as { partial: () => unknown }).partial());
    const empty = SpendFieldsSchema.partial().safeParse({});
    assert.equal(empty.success, true);
    const bad = SpendFieldsSchema.partial().safeParse({ amountCents: -1 });
    assert.equal(bad.success, false);
    // The full schema still enforces the period rule.
    const inverted = SpendInputSchema.safeParse({
      channel: "x",
      amountCents: 1,
      periodStart: "2026-02-01",
      periodEnd: "2026-01-01",
    });
    assert.equal(inverted.success, false);
  });
});

// --- source pins -------------------------------------------------------------

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...routeFiles(p));
    } else if (name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Routes that still put an error's message in a 500 on purpose. Each needs a
 * reason; shrink this list, don't grow it.
 */
const ECHO_500_ALLOWLIST: Record<string, string> = {
  // IDE file operations surface the site provider's own error (path rules,
  // size caps) to the editing user; follow-up: typed provider errors.
  "app/api/websites/[id]/file/route.ts": "site IDE provider messages",
  "app/api/websites/[id]/files/route.ts": "site IDE provider messages",
  "app/api/websites/[id]/download/route.ts": "site IDE provider messages",
  "app/api/sites/[id]/file/route.ts": "site IDE provider messages",
  "app/api/sites/[id]/files/route.ts": "site IDE provider messages",
  // Host configuration messages (secret key / telephony provider not set).
  "app/api/sites/route.ts": "host config message",
  "app/api/calls/numbers/route.ts": "host config message",
};

describe("route source pins", () => {
  const files = routeFiles(join(ROOT, "app", "api"));

  it("no route echoes an error's .message in a 500 (outside the allowlist)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(ROOT, f).split("\\").join("/");
      if (ECHO_500_ALLOWLIST[rel]) continue;
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/status: 500/.test(line)) return;
        // The statement that builds the 500: back up to its `return`, plus
        // the line before it (where a `const message = e.message` lives).
        let start = i;
        while (start > i - 4 && start > 0 && !/\breturn\b/.test(lines[start])) start--;
        const from = start > 0 && /const (message|msg) =/.test(lines[start - 1]) ? start - 1 : start;
        const window = lines.slice(from, i + 1).join("\n");
        if (/\b(e|err|error)\.message\b|\{ error: (message|msg) \}/.test(window)) {
          offenders.push(`${rel}:${i + 1}`);
        }
      });
    }
    assert.deepEqual(offenders, [], "use errorResponse()/httpErrorResponse() from lib/api/errors");
  });

  it("voice routes no longer turn every failure into 400/500 by message regex", () => {
    for (const f of files.filter((p) => p.includes(join("app", "api", "voice")))) {
      const src = readFileSync(f, "utf8");
      assert.doesNotMatch(src, /function asResponse/, f);
      assert.doesNotMatch(src, /\{ error: message \}, \{ status: 400 \}/, f);
      assert.doesNotMatch(src, /\.test\(message\) \? 4\d\d : 500/, f);
    }
  });

  it("funding/intro-requests validates its body with a schema (was a raw cast → TypeError 500)", () => {
    const src = readFileSync(join(ROOT, "app/api/funding/intro-requests/route.ts"), "utf8");
    assert.match(src, /IntroRequestSchema\.parse\(await readJson\(req\)\)/);
    assert.doesNotMatch(src, /as IntroRequestInput/);
  });

  it("the shared catch-all delegates to lib/api/errors", () => {
    const src = readFileSync(join(ROOT, "lib/enrichment/guard.ts"), "utf8");
    assert.match(src, /return errorResponse\(e\)/);
  });
});
