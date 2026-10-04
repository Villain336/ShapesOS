// ShapesOS — non-urgent image jobs through the OpenAI Batch API (Phase 7).
//
// LIBRARY ONLY: nothing calls this yet. A future caller (e.g. a nightly
// social-image job) must persist the returned batchId itself — there is no
// table for it, by design, until there is a caller.
//
// Checked against the OpenAI docs on 2026-10-04:
//   - Batch guide: "50% cost discount compared to synchronous APIs"; the
//     available endpoints include `/v1/images/generations` and
//     `/v1/images/edits`; "each input file can only include requests to a
//     single model"; up to 50,000 requests and 200 MB per batch; 24h window.
//   - gpt-image-2 model page: Batch (`v1/batch`) — Supported.
//   - Batch pricing for gpt-image-2: image output $15 / 1M tokens (vs $30).
//   - Each JSONL line: { custom_id, method: "POST", url, body } where body is
//     the endpoint's own parameters. Output lines: { custom_id, response:
//     { status_code, body }, error }; failures go to error_file_id.
// Only generations are batched here: edits need multipart reference images,
// which the JSONL body can only carry as URLs / File-API ids.
//
// Flow: submitImageBatch() → (poll) getImageBatch() → collectImageBatch(),
// which saves every image as a WorkspaceFile (deterministic paths, so a
// re-collect never duplicates) and meters it at the Batch (half) price.
//
// UNVERIFIED-LIVE: exercised against a stub fetch only
// (lib/images/__tests__/batch.test.ts).

import { meter } from "@/lib/metering/service";
import { imageGenerationCredits } from "@/lib/metering/credits";
import { FsError } from "@/lib/filesystem/service";
import {
  buildGenerationBody,
  imageRequestConfig,
  isImageQuality,
  openAiImageRequest,
  parseImagesResponse,
  ImageRequestError,
  type GenerateImageInput,
  type ImageCallOptions,
} from "./openai";
import { batchImagePath, storeGeneratedImage, workspaceFileUrl } from "./files";

export const IMAGE_BATCH_ENDPOINT = "/v1/images/generations";
export const MAX_BATCH_REQUESTS = 50_000;
const MAX_BATCH_BYTES = 200 * 1024 * 1024;

export type ImageBatchStatus =
  | "validating"
  | "failed"
  | "in_progress"
  | "finalizing"
  | "completed"
  | "expired"
  | "cancelling"
  | "cancelled";

/** Statuses after which nothing more will be produced. */
const TERMINAL: ReadonlySet<string> = new Set(["failed", "completed", "expired", "cancelled"]);

export interface ImageBatchJob extends GenerateImageInput {
  /** Unique per batch; becomes the file name stem. [A-Za-z0-9_-], ≤ 64. */
  customId: string;
}

export interface ImageBatchInfo {
  batchId: string;
  status: ImageBatchStatus | string;
  done: boolean;
  inputFileId: string | null;
  outputFileId: string | null;
  errorFileId: string | null;
  requestCounts: { total: number; completed: number; failed: number } | null;
}

function toInfo(json: unknown): ImageBatchInfo {
  const b = (json ?? {}) as {
    id?: unknown;
    status?: unknown;
    input_file_id?: unknown;
    output_file_id?: unknown;
    error_file_id?: unknown;
    request_counts?: { total?: unknown; completed?: unknown; failed?: unknown };
  };
  const s = (v: unknown) => (typeof v === "string" && v ? v : null);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const status = s(b.status) ?? "unknown";
  return {
    batchId: s(b.id) ?? "",
    status,
    done: TERMINAL.has(status),
    inputFileId: s(b.input_file_id),
    outputFileId: s(b.output_file_id),
    errorFileId: s(b.error_file_id),
    requestCounts: b.request_counts
      ? { total: n(b.request_counts.total), completed: n(b.request_counts.completed), failed: n(b.request_counts.failed) }
      : null,
  };
}

/** The JSONL input file for a set of jobs (exported for tests). */
export function buildImageBatchJsonl(model: string, jobs: ImageBatchJob[]): string {
  if (jobs.length === 0) throw new ImageRequestError("A batch needs at least one job.");
  if (jobs.length > MAX_BATCH_REQUESTS) throw new ImageRequestError(`A batch holds at most ${MAX_BATCH_REQUESTS} jobs.`);
  const seen = new Set<string>();
  const lines = jobs.map((job) => {
    const id = job.customId;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new ImageRequestError("Every job needs a customId of letters, digits, _ or - (at most 64).");
    }
    if (seen.has(id)) throw new ImageRequestError(`Duplicate customId "${id}".`);
    seen.add(id);
    // Same body as the synchronous call — validated the same way, never
    // with response_format.
    const body = buildGenerationBody(model, job);
    return JSON.stringify({ custom_id: id, method: "POST", url: IMAGE_BATCH_ENDPOINT, body });
  });
  const jsonl = `${lines.join("\n")}\n`;
  if (Buffer.byteLength(jsonl) > MAX_BATCH_BYTES) throw new ImageRequestError("The batch input is larger than 200 MB.");
  return jsonl;
}

/** Upload the jobs and create the batch (24h window). One model per batch. */
export async function submitImageBatch(
  input: { jobs: ImageBatchJob[]; metadata?: Record<string, string> },
  opts: ImageCallOptions = {},
): Promise<ImageBatchInfo & { model: string }> {
  const cfg = imageRequestConfig(opts);
  const jsonl = buildImageBatchJsonl(cfg.model, input.jobs);
  const form = new FormData();
  form.append("purpose", "batch");
  form.append("file", new Blob([jsonl], { type: "application/jsonl" }), "image-batch.jsonl");
  const file = (await openAiImageRequest(cfg, { method: "POST", path: "/files", form }, opts)) as { id?: unknown };
  if (typeof file?.id !== "string" || !file.id) throw new ImageRequestError("The Files API returned no file id.");
  const created = await openAiImageRequest(
    cfg,
    {
      method: "POST",
      path: "/batches",
      json: {
        input_file_id: file.id,
        endpoint: IMAGE_BATCH_ENDPOINT,
        completion_window: "24h",
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
    },
    { ...opts, maxRetries: 0 }, // never create a second batch on a retry
  );
  return { ...toInfo(created), model: cfg.model };
}

/** Poll a batch's status. */
export async function getImageBatch(batchId: string, opts: ImageCallOptions = {}): Promise<ImageBatchInfo> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(batchId)) throw new ImageRequestError("Invalid batch id.");
  const cfg = imageRequestConfig(opts);
  return toInfo(await openAiImageRequest(cfg, { method: "GET", path: `/batches/${batchId}` }, opts));
}

export interface CollectedImage {
  customId: string;
  fileId: string;
  url: string;
  logicalPath: string;
  credits: number;
}

export interface CollectResult {
  info: ImageBatchInfo;
  /** False while the batch is still running — call again later. */
  ready: boolean;
  saved: CollectedImage[];
  /** Images already saved by an earlier collect (path taken). */
  alreadySaved: string[];
  /** Per-request failures: custom id + a short code (never a message body). */
  failed: Array<{ customId: string; code: string }>;
}

function safeCode(v: unknown): string {
  return typeof v === "string" && /^[a-z0-9_.]{1,64}$/i.test(v) ? v : "error";
}

function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* a torn line is reported as missing, never guessed */
    }
  }
  return out;
}

/**
 * Collect a finished batch into WorkspaceFiles and meter each image at the
 * Batch price. Safe to call repeatedly: paths and idempotency keys are
 * deterministic per (batch, customId, image index).
 */
export async function collectImageBatch(
  args: { batchId: string; workspaceId: string; projectId: string; userId: string },
  opts: ImageCallOptions = {},
): Promise<CollectResult> {
  const cfg = imageRequestConfig(opts);
  const info = await getImageBatch(args.batchId, opts);
  const result: CollectResult = { info, ready: info.done, saved: [], alreadySaved: [], failed: [] };
  if (!info.done) return result;

  if (info.errorFileId) {
    const text = (await openAiImageRequest(
      cfg,
      { method: "GET", path: `/files/${encodeURIComponent(info.errorFileId)}/content`, asText: true },
      opts,
    )) as string;
    for (const row of parseJsonl(String(text ?? ""))) {
      const r = row as { custom_id?: unknown; error?: { code?: unknown }; response?: { status_code?: unknown } };
      result.failed.push({
        customId: typeof r.custom_id === "string" ? r.custom_id : "unknown",
        code: safeCode(r.error?.code ?? (r.response?.status_code ? `http_${r.response.status_code}` : undefined)),
      });
    }
  }
  if (!info.outputFileId) return result;

  const text = (await openAiImageRequest(
    cfg,
    { method: "GET", path: `/files/${encodeURIComponent(info.outputFileId)}/content`, asText: true },
    opts,
  )) as string;

  for (const row of parseJsonl(String(text ?? ""))) {
    const r = row as {
      custom_id?: unknown;
      response?: { status_code?: unknown; body?: unknown } | null;
      error?: { code?: unknown } | null;
    };
    const customId = typeof r.custom_id === "string" && r.custom_id ? r.custom_id : "unknown";
    if (r.error || r.response?.status_code !== 200) {
      result.failed.push({ customId, code: safeCode(r.error?.code ?? `http_${String(r.response?.status_code ?? "none")}`) });
      continue;
    }
    let parsed;
    try {
      parsed = parseImagesResponse(r.response.body, cfg.model, null);
    } catch {
      result.failed.push({ customId, code: "empty" });
      continue;
    }
    const quality = isImageQuality(parsed.quality) ? parsed.quality : "medium";
    for (let i = 0; i < parsed.images.length; i++) {
      const logicalPath = batchImagePath(args.projectId, args.batchId, customId, i);
      let stored;
      try {
        stored = await storeGeneratedImage({
          workspaceId: args.workspaceId,
          projectId: args.projectId,
          userId: args.userId,
          bytes: parsed.images[i]!.bytes,
          logicalPath,
        });
      } catch (e) {
        if (e instanceof FsError && e.code === "conflict") {
          result.alreadySaved.push(logicalPath);
          continue;
        }
        throw e;
      }
      const charge = await meter({
        workspaceId: args.workspaceId,
        projectId: args.projectId,
        actorId: args.userId,
        action: "image_generation",
        credits: imageGenerationCredits({ quality, size: parsed.size, batch: true }),
        idempotencyKey: `imagebatch:${args.batchId}:${customId}:${i}`,
        evidenceRef: `image-batch:${args.batchId}:${customId}`,
      });
      result.saved.push({
        customId,
        fileId: stored.file.id,
        url: workspaceFileUrl(args.workspaceId, stored.file.id),
        logicalPath: stored.file.logicalPath,
        credits: charge.ok ? charge.charged : 0,
      });
    }
  }
  return result;
}
