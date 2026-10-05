// ShapesOS — Phase 7: the OpenAI image service, offline (fetch stubbed).
// Run: npx tsx --test lib/images/__tests__/openai.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ImageConfigError,
  ImageRequestError,
  buildEditForm,
  buildGenerationBody,
  editImage,
  generateImage,
  imageServiceStatus,
  resolveImageModel,
  validateImageSize,
} from "../openai";
import { LlmProviderError, isRetryableLlmError } from "@/lib/llm/errors";
import { OPENAI_IMAGE_ZDR_MODELS, OPENAI_ZDR_MODELS, isAllowedImageModel, isRoutableHostedModel } from "@/lib/llm/router";
import { imageGenerationCredits } from "@/lib/metering/credits";

// A real 1x1 PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const SECRET = "sk-proj-THISISAFAKEKEYTHATMUSTNEVERLEAK1234567890";

const ENV = { OPENAI_API_KEY: SECRET };

interface Call {
  url: string;
  init: RequestInit;
}

function stub(responses: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return r();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const ok = (body: unknown) => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const imageOk = (extra: Record<string, unknown> = {}) => ok({ created: 1, data: [{ b64_json: PNG_B64 }], ...extra });
const noSleep = async () => {};

describe("configuration", () => {
  it("defaults to gpt-image-2; LLM_IMAGE_MODEL overrides", () => {
    assert.deepEqual(resolveImageModel({}), { model: "gpt-image-2", source: "default" });
    assert.deepEqual(resolveImageModel({ LLM_IMAGE_MODEL: " gpt-image-1.5 " }), { model: "gpt-image-1.5", source: "env" });
  });

  it("keeps the image allow-list separate from the text allow-lists", () => {
    assert.ok(OPENAI_IMAGE_ZDR_MODELS.includes("gpt-image-2"));
    for (const m of OPENAI_IMAGE_ZDR_MODELS) {
      assert.ok(!(OPENAI_ZDR_MODELS as readonly string[]).includes(m), `${m} leaked into text routing`);
      assert.equal(isRoutableHostedModel(m), false, `${m} must never route text`);
    }
    assert.equal(isAllowedImageModel("gpt-5-nano"), false);
    assert.equal(isAllowedImageModel("dall-e-3"), false);
    assert.equal(isAllowedImageModel("gemini-image"), false);
  });

  it("uses the router's key resolution: empty LLM_API_KEY does not mask OPENAI_API_KEY", () => {
    assert.equal(imageServiceStatus({ LLM_API_KEY: "", OPENAI_API_KEY: "x" }).live, true);
    assert.equal(imageServiceStatus({ LLM_API_KEY: "  " }).configured, false);
    const s = imageServiceStatus({ OPENAI_API_KEY: "x", LLM_IMAGE_MODEL: "dall-e-3" });
    assert.equal(s.live, false);
    assert.match(s.reason ?? "", /not on the OpenAI image allow-list/);
  });

  it("with no key, nothing is sent and the error says an OpenAI key is needed", async () => {
    const { calls, fetchImpl } = stub([imageOk()]);
    await assert.rejects(generateImage({ prompt: "a cat" }, { env: {}, fetchImpl }), (e: unknown) => {
      assert.ok(e instanceof ImageConfigError);
      assert.equal(e.code, "image_not_configured");
      assert.match(e.message, /needs an OpenAI key/);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("refuses a model outside the image allow-list before any call", async () => {
    const { calls, fetchImpl } = stub([imageOk()]);
    await assert.rejects(
      generateImage({ prompt: "a cat" }, { env: { ...ENV, LLM_IMAGE_MODEL: "dall-e-3" }, fetchImpl }),
      (e: unknown) => e instanceof ImageConfigError && e.code === "image_model_not_allowed",
    );
    assert.equal(calls.length, 0);
  });
});

describe("generations request shape", () => {
  it("POSTs JSON to /images/generations without response_format", async () => {
    const { calls, fetchImpl } = stub([imageOk()]);
    const res = await generateImage(
      { prompt: "  a red bicycle  ", size: "1536x1024", quality: "high", background: "transparent" },
      { env: { ...ENV, OPENAI_BASE_URL: "https://proxy.example.test/v1/" }, fetchImpl },
    );
    assert.equal(calls.length, 1);
    const c = calls[0]!;
    assert.equal(c.url, "https://proxy.example.test/v1/images/generations");
    assert.equal(c.init.method, "POST");
    const headers = c.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(headers["Content-Type"], "application/json");
    const body = JSON.parse(String(c.init.body));
    assert.deepEqual(body, {
      model: "gpt-image-2",
      prompt: "a red bicycle",
      size: "1536x1024",
      n: 1,
      output_format: "png",
      quality: "high",
      background: "transparent",
    });
    assert.equal("response_format" in body, false);
    assert.ok(c.init.signal, "every request carries an abort signal (timeout)");
    assert.equal(res.images.length, 1);
    assert.ok(res.images[0]!.bytes.equals(PNG), "base64 is decoded to the PNG bytes");
    assert.equal(res.model, "gpt-image-2");
    assert.equal(res.usage, null);
  });

  it("omits quality when not given (the API's auto) and returns usage when reported", async () => {
    const { calls, fetchImpl } = stub([
      imageOk({
        size: "1024x1024",
        quality: "medium",
        usage: { total_tokens: 100, input_tokens: 50, output_tokens: 50, input_tokens_details: { text_tokens: 10, image_tokens: 40 } },
      }),
    ]);
    const res = await generateImage({ prompt: "a cat" }, { env: ENV, fetchImpl });
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.equal("quality" in body, false);
    assert.equal(body.size, "1024x1024");
    assert.deepEqual(res.usage, { inputTokens: 50, outputTokens: 50, totalTokens: 100, inputImageTokens: 40, inputTextTokens: 10 });
    assert.equal(res.quality, "medium");
  });

  it("validates size and quality before spending anything", () => {
    assert.equal(validateImageSize("1536x864", "gpt-image-2"), "1536x864");
    assert.equal(validateImageSize("AUTO", "gpt-image-1"), "auto");
    assert.equal(validateImageSize("3840x2160", "gpt-image-2.5-sunburst"), "3840x2160");
    for (const [size, model, why] of [
      ["1536x864", "gpt-image-1", /for gpt-image-1/],
      ["1000x1000", "gpt-image-2", /multiples of 16/],
      ["4096x1024", "gpt-image-2", /3840px/],
      ["2400x768", "gpt-image-2", /3:1/],
      ["512x512", "gpt-image-2", /655,360/],
      ["big", "gpt-image-2", /Invalid size/],
    ] as const) {
      assert.throws(() => validateImageSize(size, model), (e: unknown) => e instanceof ImageRequestError && why.test(e.message), size);
    }
    assert.throws(() => buildGenerationBody("gpt-image-2", { prompt: "x", quality: "ultra" as never }), /low, medium or high/);
    assert.throws(() => buildGenerationBody("gpt-image-2", { prompt: "x", n: 11 }), /1 to 10/);
    assert.throws(() => buildGenerationBody("gpt-image-2", { prompt: "  " }), /prompt is required/);
    assert.throws(() => buildGenerationBody("gpt-image-2", { prompt: "x", background: "black" as never }), /transparent, opaque or auto/);
  });
});

describe("edits request shape (multipart)", () => {
  it("sends image[] parts, the mask and the options as multipart form data", async () => {
    const { calls, fetchImpl } = stub([imageOk()]);
    await editImage(
      {
        prompt: "Put the logo on the mug",
        images: [
          { bytes: PNG, filename: "brand/logo.png" },
          { bytes: JPEG, filename: "mug photo.jpg" },
        ],
        mask: { bytes: PNG, filename: "mask.png" },
        quality: "medium",
        size: "1024x1024",
      },
      { env: ENV, fetchImpl },
    );
    const c = calls[0]!;
    assert.equal(c.url, "https://api.openai.com/v1/images/edits");
    const headers = c.init.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], undefined, "fetch must set the multipart boundary itself");
    assert.ok(c.init.body instanceof FormData);
    const form = c.init.body as FormData;
    assert.equal(form.get("model"), "gpt-image-2");
    assert.equal(form.get("prompt"), "Put the logo on the mug");
    const images = form.getAll("image[]") as File[];
    assert.equal(images.length, 2);
    assert.equal(images[0]!.type, "image/png");
    assert.equal(images[0]!.name, "logo.png");
    assert.equal(images[1]!.type, "image/jpeg", "the bytes decide the type");
    assert.equal(images[1]!.name, "mug-photo.jpg");
    assert.equal((form.get("mask") as File).type, "image/png");
    assert.equal(form.get("quality"), "medium");
    assert.equal(form.get("size"), "1024x1024");
    assert.equal(form.get("n"), "1");
    assert.equal(form.get("output_format"), "png");
    assert.equal(form.get("response_format"), null);
    assert.equal(form.get("input_fidelity"), null, "gpt-image-2: input_fidelity must be omitted");
  });

  it("rejects bad reference images before any call", () => {
    assert.throws(() => buildEditForm("gpt-image-2", { prompt: "x", images: [] }), /At least one/);
    assert.throws(
      () => buildEditForm("gpt-image-2", { prompt: "x", images: Array.from({ length: 17 }, () => ({ bytes: PNG })) }),
      /At most 16/,
    );
    assert.throws(() => buildEditForm("gpt-image-2", { prompt: "x", images: [{ bytes: Buffer.from("<svg/>") }] }), /PNG, JPEG or WebP/);
    assert.throws(() => buildEditForm("gpt-image-2", { prompt: "x", images: [{ bytes: PNG }], mask: { bytes: JPEG } }), /mask must be a PNG/);
  });
});

describe("errors (same classification as lib/llm/errors.ts, no key material)", () => {
  it("a 401 is a non-retryable client error whose message has no key and no body", async () => {
    const leaky = () =>
      new Response(JSON.stringify({ error: { code: "invalid_api_key", message: `Incorrect API key provided: ${SECRET}` } }), {
        status: 401,
      });
    const { calls, fetchImpl } = stub([leaky]);
    await assert.rejects(generateImage({ prompt: "a cat" }, { env: ENV, fetchImpl, sleep: noSleep }), (e: unknown) => {
      assert.ok(e instanceof LlmProviderError);
      assert.equal(e.kind, "client");
      assert.equal(e.status, 401);
      assert.equal(isRetryableLlmError(e), false);
      assert.match(e.message, /HTTP 401 \(invalid_api_key\)/);
      assert.doesNotMatch(e.message, /sk-proj|Incorrect API key|NEVERLEAK/);
      assert.doesNotMatch(String(e.stack), /NEVERLEAK/);
      return true;
    });
    assert.equal(calls.length, 1, "a 4xx is never retried");
  });

  it("a 429 is retried once honouring Retry-After, then succeeds", async () => {
    const waits: number[] = [];
    const { calls, fetchImpl } = stub([
      () => new Response("{}", { status: 429, headers: { "retry-after": "2" } }),
      imageOk(),
    ]);
    const res = await generateImage({ prompt: "a cat" }, { env: ENV, fetchImpl, sleep: async (ms) => void waits.push(ms) });
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [2000]);
    assert.equal(res.images.length, 1);
  });

  it("a persistent 5xx surfaces as a retryable server error after one retry", async () => {
    const { calls, fetchImpl } = stub([() => new Response("oops", { status: 503 })]);
    await assert.rejects(generateImage({ prompt: "a cat" }, { env: ENV, fetchImpl, sleep: noSleep }), (e: unknown) => {
      assert.ok(e instanceof LlmProviderError);
      assert.equal(e.kind, "server");
      assert.equal(e.retryable, true);
      return true;
    });
    assert.equal(calls.length, 2);
  });

  it("our own timeout is classified 'timeout' and not retried (the job may still bill)", async () => {
    const hang = (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    let n = 0;
    const fetchImpl = ((u: string, init?: RequestInit) => {
      n++;
      return hang(u, init);
    }) as unknown as typeof fetch;
    await assert.rejects(generateImage({ prompt: "a cat" }, { env: ENV, fetchImpl, timeoutMs: 20, sleep: noSleep }), (e: unknown) => {
      assert.ok(e instanceof LlmProviderError);
      assert.equal(e.kind, "timeout");
      assert.equal(e.retryable, true);
      return true;
    });
    assert.equal(n, 1);
  });

  it("a caller's abort surfaces as the abort itself, never a provider failure", async () => {
    const ac = new AbortController();
    const fetchImpl = ((_u: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        ac.abort(new Error("stopped by user"));
      })) as unknown as typeof fetch;
    await assert.rejects(generateImage({ prompt: "a cat" }, { env: ENV, fetchImpl, signal: ac.signal }), /stopped by user/);
  });

  it("a network failure is retryable 'network'; an empty data array is 'empty'", async () => {
    const { fetchImpl } = stub([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    await assert.rejects(generateImage({ prompt: "a cat" }, { env: ENV, fetchImpl, sleep: noSleep }), (e: unknown) =>
      e instanceof LlmProviderError && e.kind === "network" && e.retryable,
    );
    const empty = stub([ok({ data: [] })]);
    await assert.rejects(generateImage({ prompt: "a cat" }, { env: ENV, fetchImpl: empty.fetchImpl }), (e: unknown) =>
      e instanceof LlmProviderError && e.kind === "empty",
    );
  });
});

describe("credits", () => {
  it("prices by quality, scales custom sizes, halves for Batch", () => {
    assert.equal(imageGenerationCredits({ quality: "low" }), 3);
    assert.equal(imageGenerationCredits({ quality: "medium", size: "1536x1024" }), 22);
    assert.equal(imageGenerationCredits({ quality: "high", size: "1024x1024" }), 85);
    assert.equal(imageGenerationCredits({ quality: "medium", size: "2048x2048" }), 88);
    assert.equal(imageGenerationCredits({ quality: "medium", batch: true }), 11);
    assert.equal(imageGenerationCredits({ quality: "low", n: 3 }), 9);
  });
});
