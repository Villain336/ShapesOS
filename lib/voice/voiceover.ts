// Marketr — Phase 13D Worker B: voiceover job lifecycle.
//
// VoiceoverJob: script → (pronunciation snapshot) → VoiceStudio → audio
// bytes → workspace file store → ready | failed. Audio is stored with the
// EXISTING workspace file store (lib/filesystem/storage.ts — UUID keys,
// getStorageAdapter(): local disk or the shared S3 bucket per
// MARKETR_STORAGE — deploy PR; it used to pin LocalDiskAdapter, so a
// voiceover rendered on the worker was invisible to the web replicas), the
// same pattern 13C uses for outputRef/file refs: the job's audioRef IS the
// storage key. No new storage invented.
//
// Lifecycle: pending → processing (progress 0→1) → ready | failed.
// create() validates; process() runs the render; attachToClip() links the
// job to a 13C clip (tenant-scoped — the clip must belong to the same
// workspace, so one workspace can never attach to another's clip).

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getStorageAdapter } from "@/lib/filesystem/storage";
import {
  synthesizeWithKnownVoice,
  isBackendDown,
  VoiceStudioError,
} from "./voicestudio";
import {
  listEntries,
  applyPronunciation,
  type AppliedPronunciation,
} from "./pronunciation";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/api/errors";

const adapter = {
  put: (key: string, bytes: Buffer, mime: string) => getStorageAdapter().put(key, bytes, mime),
  get: (key: string) => getStorageAdapter().get(key),
  delete: (key: string) => getStorageAdapter().delete(key),
};

export interface VoiceoverJobRow {
  id: string;
  workspaceId: string;
  agentId: string | null;
  script: string;
  voiceId: string;
  voiceBackend: string;
  pronunciation: AppliedPronunciation[];
  audioRef: string | null;
  clipId: string | null;
  status: string;
  progress: number;
  error: string | null;
  durationSec: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const jobSelect = {
  id: true,
  workspaceId: true,
  agentId: true,
  script: true,
  voiceId: true,
  voiceBackend: true,
  pronunciation: true,
  audioRef: true,
  clipId: true,
  status: true,
  progress: true,
  error: true,
  durationSec: true,
  createdAt: true,
  updatedAt: true,
} as const;

function rowOf(j: Record<string, unknown>): VoiceoverJobRow {
  return { ...(j as unknown as VoiceoverJobRow) };
}

export interface CreateVoiceoverInput {
  script: string;
  voiceId: string;
  agentId?: string;
  clipId?: string;
}

/** Create a job (status=pending). Rejects empty scripts — validation, tested. */
export async function createVoiceoverJob(
  workspaceId: string,
  input: CreateVoiceoverInput,
): Promise<VoiceoverJobRow> {
  const script = (input.script ?? "").trim();
  if (!script) throw new BadRequestError("Voiceover script is empty — nothing to render.");
  if (!input.voiceId?.trim()) throw new BadRequestError("A VoiceStudio voice id is required.");
  if (script.length > 20_000) {
    throw new BadRequestError("Script exceeds the 20,000 character limit.");
  }
  if (input.clipId) {
    // Tenant-scoped attach target: the clip must exist in this workspace.
    const clip = await withWorkspaceScope(workspaceId, (tx) =>
      tx.clip.findFirst({ where: { id: input.clipId, workspaceId } }),
    );
    if (!clip) throw new NotFoundError("Clip not found in this workspace.");
  }
  if (input.agentId) {
    const agent = await withWorkspaceScope(workspaceId, (tx) =>
      tx.voiceAgent.findFirst({
        where: { id: input.agentId, workspaceId, purpose: "voiceover" },
      }),
    );
    if (!agent) throw new NotFoundError("Voiceover agent not found in this workspace.");
  }
  const job = await withWorkspaceScope(workspaceId, (tx) =>
    tx.voiceoverJob.create({
      data: {
        workspaceId,
        agentId: input.agentId ?? null,
        script,
        voiceId: input.voiceId.trim(),
        voiceBackend: "voicestudio", // default backend, always
        clipId: input.clipId ?? null,
        status: "pending",
        progress: 0,
      },
      select: jobSelect,
    }),
  );
  return rowOf(job);
}

export async function getVoiceoverJob(
  workspaceId: string,
  jobId: string,
): Promise<VoiceoverJobRow | null> {
  const job = await withWorkspaceScope(workspaceId, (tx) =>
    tx.voiceoverJob.findFirst({ where: { id: jobId, workspaceId }, select: jobSelect }),
  );
  return job ? rowOf(job) : null;
}

export async function listVoiceoverJobs(
  workspaceId: string,
  limit = 50,
): Promise<VoiceoverJobRow[]> {
  const jobs = await withWorkspaceScope(workspaceId, (tx) =>
    tx.voiceoverJob.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
      select: jobSelect,
    }),
  );
  return jobs.map(rowOf);
}

async function setJob(
  workspaceId: string,
  jobId: string,
  data: Prisma.VoiceoverJobUpdateManyMutationInput,
): Promise<void> {
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.voiceoverJob.updateMany({ where: { id: jobId, workspaceId }, data }),
  );
}

/** Estimate WAV duration from the RIFF header; null when unparseable. */
function estimateWavDurationSec(bytes: Buffer): number | null {
  try {
    if (bytes.length < 44) return null;
    if (bytes.toString("ascii", 0, 4) !== "RIFF") return null;
    if (bytes.toString("ascii", 8, 12) !== "WAVE") return null;
    // fmt chunk is usually at offset 12: "fmt " + len + audioFormat(2) +
    // channels(2) + sampleRate(4) + byteRate(4).
    if (bytes.toString("ascii", 12, 16) !== "fmt ") return null;
    const byteRate = bytes.readUInt32LE(28);
    if (!byteRate) return null;
    // Find the "data" chunk (robust to extra chunks).
    let off = 12;
    while (off + 8 < bytes.length) {
      const id = bytes.toString("ascii", off, off + 4);
      const len = bytes.readUInt32LE(off + 4);
      if (id === "data") return len / byteRate;
      off += 8 + len;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Render a pending job: fetch pronunciation snapshot → substitute →
 * VoiceStudio synthesize → store audio bytes → ready. Any failure lands the
 * job in failed with a human-readable error. Progress mirrors the pipeline.
 */
export async function processVoiceoverJob(
  workspaceId: string,
  jobId: string,
): Promise<VoiceoverJobRow> {
  const job = await getVoiceoverJob(workspaceId, jobId);
  if (!job) throw new NotFoundError("Voiceover job not found.");
  if (job.status === "ready") return job;
  if (job.status === "processing") {
    throw new ConflictError("Job is already processing.");
  }

  await setJob(workspaceId, jobId, { status: "processing", progress: 0.05, error: null });

  const fail = async (error: string): Promise<VoiceoverJobRow> => {
    await setJob(workspaceId, jobId, { status: "failed", error, progress: 0 });
    const j = await getVoiceoverJob(workspaceId, jobId);
    if (!j) throw new NotFoundError("Voiceover job disappeared.");
    return j;
  };

  try {
    // 1. Pronunciation snapshot (auditable on the job).
    const entries = await listEntries(workspaceId);
    await setJob(workspaceId, jobId, { progress: 0.15 });
    const { script: rendered, applied } = applyPronunciation(job.script, entries);
    await setJob(workspaceId, jobId, {
      pronunciation: JSON.parse(JSON.stringify(applied)) as Prisma.InputJsonValue,
      progress: 0.25,
    });

    // 2. Synthesize via VoiceStudio (voice id verified against the live list).
    const audio = await synthesizeWithKnownVoice({
      voice: job.voiceId,
      input: rendered,
      format: "wav",
    });
    await setJob(workspaceId, jobId, { progress: 0.7 });

    // 3. Store audio bytes in the workspace file store (UUID key = audioRef).
    const key = randomUUID();
    await adapter.put(key, audio, "audio/wav");
    await setJob(workspaceId, jobId, { progress: 0.9 });

    const durationSec = estimateWavDurationSec(audio);
    await setJob(workspaceId, jobId, {
      status: "ready",
      progress: 1,
      audioRef: key,
      durationSec,
    });
    const done = await getVoiceoverJob(workspaceId, jobId);
    if (!done) throw new NotFoundError("Voiceover job disappeared.");
    return done;
  } catch (e) {
    const msg =
      e instanceof VoiceStudioError
        ? isBackendDown(e)
          ? `VoiceStudio backend is down: ${e.message}`
          : `VoiceStudio error (${e.kind}): ${e.message}`
        : e instanceof Error
          ? e.message
          : "Unknown voiceover failure.";
    return fail(msg);
  }
}

/** Link a job to a 13C clip (tenant-scoped). Surfaces via clip detail. */
export async function attachJobToClip(
  workspaceId: string,
  jobId: string,
  clipId: string,
): Promise<VoiceoverJobRow> {
  const job = await getVoiceoverJob(workspaceId, jobId);
  if (!job) throw new NotFoundError("Voiceover job not found.");
  const clip = await withWorkspaceScope(workspaceId, (tx) =>
    tx.clip.findFirst({ where: { id: clipId, workspaceId } }),
  );
  if (!clip) throw new NotFoundError("Clip not found in this workspace.");
  await setJob(workspaceId, jobId, { clipId });
  const updated = await getVoiceoverJob(workspaceId, jobId);
  if (!updated) throw new NotFoundError("Voiceover job disappeared.");
  return updated;
}

/** Fetch the stored audio bytes for a ready job (tenant-scoped). */
export async function getJobAudio(
  workspaceId: string,
  jobId: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
  const job = await getVoiceoverJob(workspaceId, jobId);
  if (!job || !job.audioRef) return null;
  const bytes = await adapter.get(job.audioRef);
  if (!bytes) return null;
  return { bytes, mime: "audio/wav" };
}

/** Delete a job + its stored audio (best-effort). */
export async function deleteVoiceoverJob(
  workspaceId: string,
  jobId: string,
): Promise<void> {
  const job = await getVoiceoverJob(workspaceId, jobId);
  if (!job) return;
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.voiceoverJob.deleteMany({ where: { id: jobId, workspaceId } }),
  );
  if (job.audioRef) {
    await adapter.delete(job.audioRef).catch(() => {});
  }
}
