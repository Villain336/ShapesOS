// ShapesOS — Phase 7: image jobs through the OpenAI Batch API, offline
// (fetch stubbed). Collection into WorkspaceFiles is in the DB suite
// (generate-image-db.test.ts).
// Run: npx tsx --test lib/images/__tests__/batch.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildImageBatchJsonl, getImageBatch, submitImageBatch, IMAGE_BATCH_ENDPOINT } from "../batch";
import { ImageConfigError, ImageRequestError } from "../openai";

const ENV = { OPENAI_API_KEY: "sk-test-key" };

describe("buildImageBatchJsonl", () => {
  it("writes one /v1/images/generations line per job, same body as the sync call", () => {
    const jsonl = buildImageBatchJsonl("gpt-image-2", [
      { customId: "hero-1", prompt: "A hero image", quality: "low", size: "1536x1024" },
      { customId: "hero-2", prompt: "Another", quality: "high" },
    ]);
    assert.ok(jsonl.endsWith("\n"));
    const lines = jsonl.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], {
      custom_id: "hero-1",
      method: "POST",
      url: IMAGE_BATCH_ENDPOINT,
      body: { model: "gpt-image-2", prompt: "A hero image", size: "1536x1024", n: 1, output_format: "png", quality: "low" },
    });
    assert.equal(lines[1].body.size, "1024x1024");
    for (const l of lines) assert.equal("response_format" in l.body, false);
  });

  it("rejects empty, duplicate or unsafe custom ids and invalid jobs", () => {
    assert.throws(() => buildImageBatchJsonl("gpt-image-2", []), ImageRequestError);
    assert.throws(
      () => buildImageBatchJsonl("gpt-image-2", [{ customId: "a", prompt: "x" }, { customId: "a", prompt: "y" }]),
      /Duplicate customId/,
    );
    assert.throws(() => buildImageBatchJsonl("gpt-image-2", [{ customId: "../x", prompt: "x" }]), /customId/);
    assert.throws(() => buildImageBatchJsonl("gpt-image-2", [{ customId: "a", prompt: "x", quality: "max" as never }]), /low, medium or high/);
  });
});

describe("submit and poll", () => {
  it("uploads the JSONL (purpose batch) and creates a 24h batch on the images endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      if (url.endsWith("/files")) return Response.json({ id: "file-in-1", purpose: "batch" });
      return Response.json({ id: "batch_abc", status: "validating", input_file_id: "file-in-1", output_file_id: null, error_file_id: null });
    }) as unknown as typeof fetch;
    const info = await submitImageBatch(
      { jobs: [{ customId: "j1", prompt: "A cat", quality: "medium" }], metadata: { purpose: "test" } },
      { env: ENV, fetchImpl },
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, "https://api.openai.com/v1/files");
    const form = calls[0]!.init.body as FormData;
    assert.equal(form.get("purpose"), "batch");
    const file = form.get("file") as File;
    assert.equal(file.name, "image-batch.jsonl");
    assert.equal(JSON.parse((await file.text()).trim()).url, "/v1/images/generations");
    assert.equal(calls[1]!.url, "https://api.openai.com/v1/batches");
    assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), {
      input_file_id: "file-in-1",
      endpoint: "/v1/images/generations",
      completion_window: "24h",
      metadata: { purpose: "test" },
    });
    assert.equal(info.batchId, "batch_abc");
    assert.equal(info.done, false);
    assert.equal(info.model, "gpt-image-2");
  });

  it("does not create a second batch when the create call fails", async () => {
    let creates = 0;
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/files")) return Response.json({ id: "file-in-1" });
      creates++;
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    await assert.rejects(submitImageBatch({ jobs: [{ customId: "j1", prompt: "A cat" }] }, { env: ENV, fetchImpl }));
    assert.equal(creates, 1);
  });

  it("parses a batch's status and refuses odd ids", async () => {
    const fetchImpl = (async (url: string) => {
      assert.equal(url, "https://api.openai.com/v1/batches/batch_abc");
      return Response.json({
        id: "batch_abc",
        status: "completed",
        output_file_id: "file-out",
        error_file_id: null,
        request_counts: { total: 2, completed: 2, failed: 0 },
      });
    }) as unknown as typeof fetch;
    const info = await getImageBatch("batch_abc", { env: ENV, fetchImpl });
    assert.equal(info.done, true);
    assert.equal(info.outputFileId, "file-out");
    assert.deepEqual(info.requestCounts, { total: 2, completed: 2, failed: 0 });
    await assert.rejects(getImageBatch("../../files", { env: ENV, fetchImpl }), ImageRequestError);
  });

  it("needs an OpenAI key", async () => {
    await assert.rejects(submitImageBatch({ jobs: [{ customId: "j1", prompt: "x" }] }, { env: {} }), ImageConfigError);
  });
});
