// Marketr — Phase 13D Worker B: VoiceStudio client tests.
// Run: npx tsx --test lib/voice/__tests__/voicestudio.test.ts
// No DB, no network — global fetch is mocked per test.
//
// Asserts:
//  1) synthesize() returns probed non-empty audio bytes on success.
//  2) A refused connection is classified "down" (honest: never audio), retried once.
//  3) 4xx → "request" with NO retry; 5xx → "model" with exactly 1 retry.
//  4) Empty body → "empty" (retryable); JSON body → "model" (not retryable).
//  5) Our own timeout abort → "model" (backend alive but slow), NO retry —
//     a duplicate would just queue behind the same serial engine.
//  6) synthesizeWithKnownVoice refuses invented voice ids, naming the real ones.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  synthesize,
  synthesizeWithKnownVoice,
  listVoices,
  clearVoicesCache,
  isBackendDown,
  VoiceStudioError,
} from "../voicestudio";

const realFetch = globalThis.fetch;
let calls: number;

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  calls = 0;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls += 1;
    return handler(String(url), init ?? {});
  }) as typeof fetch;
}

function wavBytes(): Buffer {
  // Minimal plausible WAV header + a few samples (probe only needs non-empty,
  // non-JSON bytes; duration parsing is tested via voiceover.ts).
  const b = Buffer.alloc(64);
  b.write("RIFF", 0);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  return b;
}

function okAudio(body: Buffer = wavBytes()): Response {
  return new Response(body as unknown as BodyInit, {
    status: 200,
    headers: { "content-type": "audio/wav" },
  });
}

beforeEach(() => {
  clearVoicesCache();
  calls = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearVoicesCache();
});

describe("synthesize()", () => {
  it("returns probed non-empty audio bytes on success", async () => {
    mockFetch(async () => okAudio());
    const bytes = await synthesize({ voice: "alloy", input: "Hello world." });
    assert.ok(Buffer.isBuffer(bytes));
    assert.ok(bytes.length > 0, "probe must reject empty audio");
    assert.equal(calls, 1, "no retry on success");
  });

  it("classifies a refused connection as backend-down (never audio)", async () => {
    mockFetch(async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    });
    await assert.rejects(
      () => synthesize({ voice: "alloy", input: "hi" }),
      (e: unknown) => {
        assert.ok(e instanceof VoiceStudioError);
        assert.equal(e.kind, "down");
        assert.ok(isBackendDown(e));
        assert.match(e.message, /unreachable/i);
        return true;
      },
    );
    assert.equal(calls, 2, "one retry on backend-down");
  });

  it("classifies 4xx as bad-request with NO retry", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ error: "bad voice" }), { status: 400 }),
    );
    await assert.rejects(
      () => synthesize({ voice: "nope", input: "hi" }),
      (e: unknown) => {
        assert.ok(e instanceof VoiceStudioError);
        assert.equal(e.kind, "request");
        assert.ok(!isBackendDown(e));
        return true;
      },
    );
    assert.equal(calls, 1, "never retry a 4xx");
  });

  it("classifies 5xx as model failure with exactly one retry", async () => {
    mockFetch(async () => new Response("engine exploded", { status: 500 }));
    await assert.rejects(
      () => synthesize({ voice: "alloy", input: "hi" }),
      (e: unknown) => {
        assert.ok(e instanceof VoiceStudioError);
        assert.equal(e.kind, "model");
        return true;
      },
    );
    assert.equal(calls, 2, "exactly one retry on 5xx");
  });

  it("refuses a 200 with an empty body (empty, not audio)", async () => {
    mockFetch(
      async () =>
        new Response(Buffer.alloc(0) as unknown as BodyInit, {
          status: 200,
          headers: { "content-type": "audio/wav" },
        }),
    );
    await assert.rejects(
      () => synthesize({ voice: "alloy", input: "hi" }),
      (e: unknown) => {
        assert.ok(e instanceof VoiceStudioError);
        assert.equal(e.kind, "empty");
        return true;
      },
    );
  });

  it("refuses a 200 with a JSON body masquerading as audio", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ error: "oops" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await assert.rejects(
      () => synthesize({ voice: "alloy", input: "hi" }),
      (e: unknown) => {
        assert.ok(e instanceof VoiceStudioError);
        assert.equal(e.kind, "model");
        return true;
      },
    );
  });

  it("classifies 429 saturation as engine-busy (not down) with a ~70s backoff", async () => {
    mockFetch(async () => new Response("saturated", { status: 429 }));
    const t0 = Date.now();
    await assert.rejects(
      () => synthesize({ voice: "alloy", input: "hi", timeoutMs: 5000 }),
      (e: unknown) => {
        assert.ok(e instanceof VoiceStudioError);
        assert.equal(e.kind, "model");
        assert.ok(!isBackendDown(e), "saturation is not 'down'");
        assert.ok(e.retryable);
        assert.equal(e.retryAfterMs, 70_000);
        return true;
      },
    );
    // One retry after the ~70s backoff.
    assert.equal(calls, 2);
    assert.ok(Date.now() - t0 >= 69_000, "must honor the backoff before retrying");
  });

  it("classifies our own timeout as model-slow (alive, not down) with NO retry", async () => {
    mockFetch(async (_url, init) => {
      // Never answer; let the client's own AbortController fire.
      await new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        );
      });
      throw new Error("unreachable");
    });
    await assert.rejects(
      () => synthesize({ voice: "alloy", input: "hi", timeoutMs: 50 }),
      (e: unknown) => {
        assert.ok(e instanceof VoiceStudioError);
        assert.equal(e.kind, "model");
        assert.ok(!isBackendDown(e));
        assert.ok(!e.retryable, "must not queue a duplicate behind the slow engine");
        assert.match(e.message, /too slow/i);
        return true;
      },
    );
    assert.equal(calls, 1, "no retry on engine-timeout");
  });
});

describe("voice discovery", () => {
  const voicesPayload = {
    voices: [
      { voice_id: "alloy", name: "Alloy", type: "openai_alias" },
      { voice_id: "nova", name: "Nova", type: "openai_alias" },
    ],
  };

  it("discovers voices from the backend and caches the list", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/v1/audio/voices")) {
        return new Response(JSON.stringify(voicesPayload), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const v1 = await listVoices();
    assert.deepEqual(v1.map((v) => v.voice_id), ["alloy", "nova"]);
    const v2 = await listVoices();
    assert.equal(v2, v1, "second call must come from cache");
    assert.equal(calls, 1, "voices fetched exactly once");
  });

  it("synthesizeWithKnownVoice refuses invented voice ids and names the real ones", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/v1/audio/voices")) {
        return new Response(JSON.stringify(voicesPayload), { status: 200 });
      }
      return okAudio();
    });
    await assert.rejects(
      () => synthesizeWithKnownVoice({ voice: "morgan-freeman", input: "hi" }),
      (e: unknown) => {
        assert.ok(e instanceof VoiceStudioError);
        assert.equal(e.kind, "request");
        assert.match(e.message, /Unknown voice id "morgan-freeman"/);
        assert.match(e.message, /alloy, nova/);
        return true;
      },
    );
    // Voices were discovered but no synthesis call was ever attempted.
    assert.ok(calls >= 1);
  });
});
