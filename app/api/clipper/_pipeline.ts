// Marketr — Phase 13C: clipper pipeline adapter + job executor.
//
// RUNS ONLY ON THE CONTAINER/VPS LANE (nodejs runtime, child_process).
// Never edge: ffmpeg/ffprobe exec, local-temp intermediates, and the raw
// storage adapter all require a real filesystem and subprocess access.
//
// This module is the ONE place the API routes import W2's lib/clipper
// functions from. If W2's export names differ slightly, fix them HERE only —
// the routes below reference nothing outside this file's re-exported surface.
//
// W2 CONTRACT (verified against lib/clipper — barrel at lib/clipper/index.ts):
//   getTranscriptionProvider().transcribe(buf) => WordTimedTranscript {words:[{w,start,end}],text}
//   scoreSegments(transcript, {count}, scorer?) => Promise<ClipCandidate[]> {startSec,endSec,viralityScore,scoreReasons[],hookText}
//   selectClips(candidates, transcript, {count,minSec?,maxSec?}) => ClipCandidate[] (15-60s, sentence boundaries)
//   buildRenderCommand({input,assPath,startSec,endSec,output?,faceRegion?,sourceW?,sourceH?}) => RenderSpec (.ffmpegArgs, .output)
//   buildAss(words, style: CaptionStyle) => ASS string (sync)
//   resolveCaptionStyle(workspaceId) => Promise<CaptionStyle>

import {
  getTranscriptionProvider,
  scoreSegments,
  selectClips,
  buildRenderCommand,
  buildAss,
  resolveCaptionStyle,
} from "@/lib/clipper";
import type { CaptionStyle } from "@/lib/clipper";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Prisma } from "@prisma/client";
import { claimRows } from "@/lib/jobs/claim";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getStorageAdapter } from "@/lib/filesystem/storage";
import { safeFetch } from "@/lib/connectors/safe-fetch";
import type { ResolveFn } from "@/lib/safe-url";
import { queueClipDraftToPostiz } from "@/app/api/clipper/_postiz-choke";

const execFileAsync = promisify(execFile);

// ── W2 shape aliases (structural; validated at the boundary below) ─────────

export interface TimedWord { w: string; start: number; end: number }
export interface WordTimedTranscript { words: TimedWord[]; text: string }
export interface ClipCandidate {
  startSec: number; endSec: number; viralityScore: number;
  scoreReasons: unknown[]; hookText: string;
}

// ── Storage + temp helpers ────────────────────────────────────────────────

export const CLIPPER_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const CLIPPER_MAX_URL_BYTES = 500 * 1024 * 1024;

export async function storeUpload(bytes: Buffer, mimeType: string): Promise<string> {
  const key = randomUUID();
  await getStorageAdapter().put(key, bytes, mimeType || "application/octet-stream");
  return key;
}

export async function readSourceBytes(source: { fileRef: string | null; sourceUrl: string | null }): Promise<Buffer> {
  if (source.fileRef) {
    const buf = await getStorageAdapter().get(source.fileRef);
    if (!buf) throw new Error("Source file is missing from storage.");
    return buf;
  }
  if (source.sourceUrl) return downloadUrlBytes(source.sourceUrl);
  throw new Error("Source has neither a stored file nor a URL.");
}

/** Bounded direct-URL fetch for url-origin sources. Not a generic browser:
 *  refuses non-http(s), caps bytes, 30s timeout, and goes through safeFetch
 *  (per-request DNS validation, every redirect hop re-checked) so a source
 *  URL can't reach internal addresses. Exported for tests. */
export async function downloadUrlBytes(
  url: string,
  deps: { fetchImpl?: typeof fetch; resolve?: ResolveFn } = {},
): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid source URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Source URL must be http(s).");
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await safeFetch(
      url,
      { signal: ctrl.signal },
      { fetchFn: deps.fetchImpl, resolve: deps.resolve },
    );
    if (!res.ok) throw new Error(`Source URL returned ${res.status}.`);
    const len = res.headers.get("content-length");
    if (len && Number(len) > CLIPPER_MAX_URL_BYTES) throw new Error("Source file too large.");
    const ab = await res.arrayBuffer();
    if (ab.byteLength > CLIPPER_MAX_URL_BYTES) throw new Error("Source file too large.");
    if (ab.byteLength === 0) throw new Error("Source URL returned no data.");
    return Buffer.from(ab);
  } finally {
    clearTimeout(t);
  }
}

/** Job-local scratch dir under os.tmpdir(). ffmpeg INTERMEDIATES ONLY —
 *  never durable outputs; final artifacts always go through the storage
 *  adapter. Caller must rm -rf when done (helpers below do it). */
export async function makeJobDir(jobId: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `clipper-${jobId}-`));
}

export async function cleanJobDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ── ffmpeg / ffprobe ──────────────────────────────────────────────────────

export async function probeDurationSeconds(inputPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputPath],
      { timeout: 60_000 },
    );
    const n = Number(String(stdout).trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function runFfmpeg(args: string[], cwd: string): Promise<void> {
  // buildRenderCommand returns ffmpeg ARGS; tolerate a leading "ffmpeg".
  const cleaned = args[0] === "ffmpeg" ? args.slice(1) : args;
  try {
    await execFileAsync("ffmpeg", cleaned, { timeout: 15 * 60_000, cwd, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const stderr = (e as { stderr?: unknown }).stderr;
    throw new Error(`ffmpeg failed: ${typeof stderr === "string" ? stderr.slice(0, 2000) : e instanceof Error ? e.message : "unknown"}`);
  }
}

// ── ClipJob record plumbing (all through withWorkspaceScope) ──────────────

export async function createClipJob(workspaceId: string, data: {
  kind: string; sourceId?: string | null; payload?: Record<string, unknown>;
}) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.clipJob.create({
      data: {
        workspaceId,
        kind: data.kind,
        sourceId: data.sourceId ?? null,
        payload: (data.payload ?? {}) as unknown as Prisma.InputJsonValue,
      },
      select: jobSelect,
    }),
  );
}

const jobSelect = {
  id: true, workspaceId: true, sourceId: true, kind: true, status: true,
  progress: true, payload: true, error: true, createdAt: true, updatedAt: true,
} as const;

async function setJobProgress(workspaceId: string, jobId: string, progress: number) {
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.clipJob.update({ where: { id: jobId, workspaceId }, data: { progress } }),
  );
}

async function finishJob(workspaceId: string, jobId: string, progress = 1) {
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.clipJob.update({ where: { id: jobId, workspaceId }, data: { status: "done", progress } }),
  );
}

async function failJob(workspaceId: string, jobId: string, message: string) {
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.clipJob.update({
      where: { id: jobId, workspaceId },
      data: { status: "failed", error: message.slice(0, 2000) },
    }),
  );
}

// ── Atomic claim ──────────────────────────────────────────────────────────
// Single UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED) in one
// transaction with the workspace GUC set: exactly one claimer wins per row,
// even with concurrent processors. Returns null when nothing is pending.
// Phase 8: the statement is the shared claim helper (lib/jobs/claim.ts),
// which the agent job queue uses too.

interface ClaimedJob {
  id: string; workspaceId: string; sourceId: string | null; kind: string;
  payload: unknown;
}

export async function claimNextPendingJob(workspaceId: string): Promise<ClaimedJob | null> {
  const rows = await claimRows<ClaimedJob>({
    workspaceId,
    table: "clip_jobs",
    where: Prisma.sql`sub."status" = 'pending'`,
    orderBy: Prisma.sql`sub."created_at" ASC`,
    set: Prisma.sql`"status" = 'processing', "progress" = 0, "updated_at" = NOW()`,
    returning: Prisma.sql`"id", "workspace_id" AS "workspaceId", "source_id" AS "sourceId", "kind", "payload"`,
  });
  return rows[0] ?? null;
}

// ── Executors ─────────────────────────────────────────────────────────────

async function executeTranscribe(job: ClaimedJob) {
  const ws = job.workspaceId;
  await setJobProgress(ws, job.id, 0.1);
  const source = await withWorkspaceScope(ws, (tx) =>
    tx.clipSource.findUnique({ where: { id: job.sourceId ?? "", workspaceId: ws } }),
  );
  if (!source) throw new Error("Source not found for transcribe job.");
  await withWorkspaceScope(ws, (tx) =>
    tx.clipSource.update({ where: { id: source.id, workspaceId: ws }, data: { transcriptStatus: "processing" } }),
  );

  const bytes = await readSourceBytes(source);
  await setJobProgress(ws, job.id, 0.25);

  const dir = await makeJobDir(job.id);
  try {
    const inputPath = join(dir, "input.bin");
    await writeFile(inputPath, bytes);
    const duration = await probeDurationSeconds(inputPath);
    await setJobProgress(ws, job.id, 0.4);

    const provider = getTranscriptionProvider();
    const raw = (await provider.transcribe(bytes)) as unknown as WordTimedTranscript;
    const words = Array.isArray(raw?.words)
      ? raw.words.filter((w) => w && typeof w.w === "string" && Number.isFinite(w.start) && Number.isFinite(w.end))
      : [];
    const text = typeof raw?.text === "string" ? raw.text : words.map((w) => w.w).join(" ");
    await setJobProgress(ws, job.id, 0.85);

    await withWorkspaceScope(ws, (tx) =>
      tx.clipSource.update({
        where: { id: source.id, workspaceId: ws },
        data: {
          transcriptStatus: "ready",
          transcript: { words, text } as unknown as Prisma.InputJsonValue,
          ...(duration != null ? { durationSec: duration } : {}),
        },
      }),
    );
  } finally {
    await cleanJobDir(dir);
  }
}

async function executeGenerate(job: ClaimedJob) {
  const ws = job.workspaceId;
  await setJobProgress(ws, job.id, 0.1);
  const source = await withWorkspaceScope(ws, (tx) =>
    tx.clipSource.findUnique({
      where: { id: job.sourceId ?? "", workspaceId: ws },
      select: { id: true, title: true, transcriptStatus: true, transcript: true },
    }),
  );
  if (!source) throw new Error("Source not found for generate job.");
  if (source.transcriptStatus !== "ready" || !source.transcript) {
    throw new Error("Source transcript is not ready.");
  }
  const payload = (job.payload ?? {}) as { count?: number };
  const count = Math.min(10, Math.max(1, Math.floor(payload.count ?? 3)));

  // Ask scoring for a wider field, then let selection narrow it down.
  const transcript = source.transcript as unknown as WordTimedTranscript;
  const candidates = await scoreSegments(transcript, { count: count * 2, workspaceId: ws });
  await setJobProgress(ws, job.id, 0.5);
  const picked = selectClips(candidates ?? [], transcript, { count });
  await setJobProgress(ws, job.id, 0.7);

  const style = await resolveCaptionStyle(ws);
  await withWorkspaceScope(ws, (tx) =>
    tx.clip.createMany({
      data: picked.map((c) => ({
        workspaceId: ws,
        sourceId: source.id,
        startSec: c.startSec,
        endSec: c.endSec,
        viralityScore: c.viralityScore,
        scoreReasons: (c.scoreReasons ?? []) as unknown as Prisma.InputJsonValue,
        hookText: c.hookText ?? null,
        captionStyle: (style ?? {}) as unknown as Prisma.InputJsonValue,
        status: "draft",
      })),
    }),
  );
}

async function executeRender(job: ClaimedJob) {
  const ws = job.workspaceId;
  await setJobProgress(ws, job.id, 0.1);
  const payload = (job.payload ?? {}) as { clipId?: string };
  if (!payload.clipId) throw new Error("Render job is missing clipId.");
  const clip = await withWorkspaceScope(ws, (tx) =>
    tx.clip.findUnique({
      where: { id: payload.clipId, workspaceId: ws },
      include: { source: { select: { fileRef: true, sourceUrl: true, transcript: true } } },
    }),
  );
  if (!clip) throw new Error("Clip not found for render job.");
  if (clip.status !== "approved" && clip.status !== "draft") {
    throw new Error(`Clip must be draft or approved to render (was ${clip.status}).`);
  }
  await withWorkspaceScope(ws, (tx) =>
    tx.clip.update({ where: { id: clip.id, workspaceId: ws }, data: { renderStatus: "processing" } }),
  );

  const transcript = clip.source.transcript as unknown as WordTimedTranscript | null;
  const words: TimedWord[] = Array.isArray(transcript?.words)
    ? transcript.words
        .filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end))
        .filter((w) => w.end > clip.startSec && w.start < clip.endSec)
        .map((w) => ({ ...w, start: Math.max(0, w.start - clip.startSec), end: Math.max(0, w.end - clip.startSec) }))
    : [];
  const style: CaptionStyle =
    (clip.captionStyle as unknown as CaptionStyle | null) ??
    (await resolveCaptionStyle(ws));
  const ass = buildAss(words, style);
  await setJobProgress(ws, job.id, 0.3);

  const bytes = await readSourceBytes(clip.source);
  const dir = await makeJobDir(job.id);
  try {
    const inputPath = join(dir, "input.bin");
    const assPath = join(dir, "captions.ass");
    const outPath = join(dir, "clip.mp4");
    await writeFile(inputPath, bytes);
    await writeFile(assPath, ass, "utf8");
    await setJobProgress(ws, job.id, 0.4);

    // buildRenderCommand is W2-owned and takes the output path directly;
    // runFfmpeg strips a leading "ffmpeg" argv[0] if present.
    const spec = buildRenderCommand({
      input: inputPath,
      assPath,
      startSec: clip.startSec,
      endSec: clip.endSec,
      output: outPath,
    });
    const args = spec.ffmpegArgs;
    await setJobProgress(ws, job.id, 0.5);
    await runFfmpeg(args, dir);

    const outBytes = await readFile(outPath);
    const key = randomUUID();
    await getStorageAdapter().put(key, outBytes, "video/mp4");
    await setJobProgress(ws, job.id, 0.9);

    await withWorkspaceScope(ws, (tx) =>
      tx.clip.update({
        where: { id: clip.id, workspaceId: ws },
        data: {
          outputRef: key,
          renderStatus: "ready",
          captions: {
            style,
            segments: words.map((w) => ({ text: w.w, start: w.start, end: w.end })),
          } as unknown as Prisma.InputJsonValue,
        },
      }),
    );
  } catch (e) {
    await withWorkspaceScope(ws, (tx) =>
      tx.clip.update({ where: { id: clip.id, workspaceId: ws }, data: { renderStatus: "failed" } }),
    );
    throw e;
  } finally {
    await cleanJobDir(dir);
  }
}

/** Claim-agnostic entry: executes one already-claimed (processing) job. */
export async function executeClaimedJob(job: ClaimedJob): Promise<void> {
  try {
    if (job.kind === "transcribe") await executeTranscribe(job);
    else if (job.kind === "generate") await executeGenerate(job);
    else if (job.kind === "render") await executeRender(job);
    else throw new Error(`Unknown job kind: ${job.kind}`);
    await finishJob(job.workspaceId, job.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown job failure";
    await failJob(job.workspaceId, job.id, msg);
    // Keep side effects honest: a failed transcribe unblocks the source.
    if (job.kind === "transcribe" && job.sourceId) {
      await withWorkspaceScope(job.workspaceId, (tx) =>
        tx.clipSource.update({
          where: { id: job.sourceId as string, workspaceId: job.workspaceId },
          data: { transcriptStatus: "failed" },
        }),
      ).catch(() => {});
    }
    throw e;
  }
}

// Re-export the choke point so routes stay one import away from the invariant.
export { queueClipDraftToPostiz };
