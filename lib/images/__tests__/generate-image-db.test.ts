// ShapesOS — Phase 7: the generate_image tool and Batch collection, end to
// end against Postgres with the OpenAI image API stubbed by a local server
// (OPENAI_BASE_URL is read at call time). Proves:
//   1. the tool saves the PNG as a WorkspaceFile in the project's folder,
//      meters it once (image_generation, quality-priced) and returns the
//      file id + URL;
//   2. no OpenAI key → "Image generation needs an OpenAI key", nothing is
//      generated, saved or charged;
//   3. a capped workspace never reaches OpenAI;
//   4. collectImageBatch saves every batch image as a WorkspaceFile, meters
//      at the Batch (half) price, and a second collect neither duplicates
//      files nor charges again.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test lib/images/__tests__/generate-image-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getTool } from "@/lib/chat/tools";
import { collectImageBatch } from "../batch";

const RUN = `p7img-${randomUUID().slice(0, 8)}`;
const WS = `${RUN}-ws`;
const WS_CAPPED = `${RUN}-capped`;
const USER = `${RUN}-user`;
let projectId = "";
let cappedProjectId = "";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const requests: Array<{ method: string; url: string; body: string }> = [];
let server: Server;
let storageDir = "";

const ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "LLM_API_KEY", "LLM_BASE_URL", "LLM_IMAGE_MODEL", "MARKETR_STORAGE", "MARKETR_STORAGE_DIR"];
const savedEnv: Record<string, string | undefined> = {};

function batchOutputJsonl(): string {
  const line = (id: string, quality: string) =>
    JSON.stringify({
      id: `req_${id}`,
      custom_id: id,
      response: { status_code: 200, body: { created: 1, data: [{ b64_json: PNG_B64 }], quality, size: "1024x1024" } },
      error: null,
    });
  return [line("hero-a", "medium"), line("hero-b", "low")].join("\n") + "\n";
}

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", body });
      const json = (code: number, v: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(v));
      };
      if (req.url === "/v1/images/generations") return json(200, { created: 1, data: [{ b64_json: PNG_B64 }] });
      if (req.url === "/v1/batches/batch_done") {
        return json(200, { id: "batch_done", status: "completed", output_file_id: "file-out", error_file_id: "file-err" });
      }
      if (req.url === "/v1/files/file-out/content") {
        res.writeHead(200, { "content-type": "application/jsonl" });
        return res.end(batchOutputJsonl());
      }
      if (req.url === "/v1/files/file-err/content") {
        res.writeHead(200, { "content-type": "application/jsonl" });
        return res.end(
          JSON.stringify({ id: "req_c", custom_id: "hero-c", response: null, error: { code: "batch_expired", message: "secret-ish text" } }) + "\n",
        );
      }
      json(404, { error: { code: "not_found" } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  storageDir = mkdtempSync(join(tmpdir(), "p7-images-"));
  process.env.MARKETR_STORAGE = "local";
  process.env.MARKETR_STORAGE_DIR = storageDir;
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;

  await prisma.workspace.create({ data: { id: WS, name: `P7 ${WS}`, ownerUserId: USER } }); // self_hosted: never blocks
  await prisma.workspace.create({ data: { id: WS_CAPPED, name: `P7 ${WS_CAPPED}`, ownerUserId: USER, plan: "starter" } });
  await prisma.spendCap.create({ data: { workspaceId: WS_CAPPED, capCredits: 0, blockAtCap: true } });
  projectId = (await prisma.project.create({ data: { workspaceId: WS, domain: `${RUN}.example` } })).id;
  cappedProjectId = (await prisma.project.create({ data: { workspaceId: WS_CAPPED, domain: `${RUN}-c.example` } })).id;
});

after(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(storageDir, { recursive: true, force: true });
  // usage_events is append-only (a trigger refuses DELETE), so the
  // workspaces stay; ids are unique per run.
  await prisma.$disconnect();
});

function ctx(workspaceId: string, pid: string) {
  return { projectId: pid, workspaceId, userId: USER, role: "editor" as const, confirmed: true };
}

describe("generate_image tool (stubbed OpenAI, real DB + filesystem + metering)", () => {
  it("saves a WorkspaceFile in the project's folder and meters it once", async () => {
    const tool = getTool("generate_image");
    assert.ok(tool);
    requests.length = 0;
    const out = await tool!.execute(ctx(WS, projectId), {
      prompt: "A sunlit espresso bar, wide hero shot",
      size: "landscape",
      quality: "high",
      fileName: "Hero image.png",
    });
    const d = out.details as { fileId: string; url: string; logicalPath: string; credits: number; model: string; size: string };
    assert.equal(requests.length, 1);
    const sent = JSON.parse(requests[0]!.body);
    assert.equal(sent.model, "gpt-image-2");
    assert.equal(sent.size, "1536x1024");
    assert.equal(sent.quality, "high");
    assert.equal("response_format" in sent, false);

    const row = await prisma.workspaceFile.findUnique({ where: { id: d.fileId } });
    assert.ok(row, "a WorkspaceFile row exists");
    assert.equal(row!.workspaceId, WS);
    assert.equal(row!.mimeType, "image/png");
    assert.equal(row!.kind, "file");
    assert.equal(row!.createdBy, USER);
    assert.ok(row!.logicalPath.startsWith(`/files/images/${projectId}/`), row!.logicalPath);
    assert.match(row!.filename, /^Hero-image-[0-9a-f]{8}\.png$/);
    assert.equal(d.url, `/api/files/${d.fileId}?workspaceId=${WS}&download=1`);

    const events = await prisma.usageEvent.findMany({ where: { workspaceId: WS, action: "image_generation" } });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.credits, 85, "high quality, 1536x1024");
    assert.equal(events[0]!.idempotencyKey, `imagegen:${d.fileId}`);
    assert.equal(events[0]!.projectId, projectId);
    assert.equal(d.credits, 85);
    assert.match(out.summary, /Image saved to \/files\/images\//);
  });

  it("with no OpenAI key it says so and generates, saves and charges nothing", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.LLM_API_KEY = "";
    try {
      requests.length = 0;
      const before = await prisma.workspaceFile.count({ where: { workspaceId: WS } });
      const evBefore = await prisma.usageEvent.count({ where: { workspaceId: WS } });
      const out = await getTool("generate_image")!.execute(ctx(WS, projectId), { prompt: "anything" });
      assert.match(out.summary, /Image generation needs an OpenAI key/);
      assert.equal(requests.length, 0);
      assert.equal(await prisma.workspaceFile.count({ where: { workspaceId: WS } }), before);
      assert.equal(await prisma.usageEvent.count({ where: { workspaceId: WS } }), evBefore);
    } finally {
      process.env.OPENAI_API_KEY = saved;
      delete process.env.LLM_API_KEY;
    }
  });

  it("a capped workspace never reaches OpenAI", async () => {
    requests.length = 0;
    const out = await getTool("generate_image")!.execute(ctx(WS_CAPPED, cappedProjectId), { prompt: "anything" });
    assert.match(out.summary, /Credit cap reached/);
    assert.equal(requests.length, 0);
    assert.equal(await prisma.workspaceFile.count({ where: { workspaceId: WS_CAPPED } }), 0);
  });

  it("refuses viewers and bad sizes before spending", async () => {
    requests.length = 0;
    await assert.rejects(
      getTool("generate_image")!.execute({ ...ctx(WS, projectId), role: "viewer" }, { prompt: "x" }),
      /editor role required/,
    );
    await assert.rejects(getTool("generate_image")!.execute(ctx(WS, projectId), { prompt: "x", size: "100x100" }), /multiples of 16|pixels/);
    assert.equal(requests.length, 0);
  });
});

describe("collectImageBatch (stubbed Batch API)", () => {
  it("saves each image as a WorkspaceFile at the Batch price; a re-collect is a no-op", async () => {
    const args = { batchId: "batch_done", workspaceId: WS, projectId, userId: USER };
    const first = await collectImageBatch(args);
    assert.equal(first.ready, true);
    assert.equal(first.saved.length, 2);
    assert.deepEqual(first.failed, [{ customId: "hero-c", code: "batch_expired" }]);
    const [a, b] = first.saved;
    assert.equal(a!.logicalPath, `/files/images/${projectId}/batch-batch_done/hero-a-1.png`);
    assert.equal(a!.credits, 11, "medium at half price");
    assert.equal(b!.credits, 2, "low at half price, rounded up");
    for (const s of first.saved) {
      const row = await prisma.workspaceFile.findUnique({ where: { id: s.fileId } });
      assert.equal(row?.mimeType, "image/png");
    }

    const again = await collectImageBatch(args);
    assert.equal(again.saved.length, 0);
    assert.equal(again.alreadySaved.length, 2);
    const events = await prisma.usageEvent.findMany({
      where: { workspaceId: WS, idempotencyKey: { startsWith: "imagebatch:batch_done:" } },
    });
    assert.equal(events.length, 2, "no second charge");
  });
});
