// ShapesOS — Phase 21B (WS=drive): the browser side of uploading — loose files, whole folders
// (picked with webkitdirectory or dropped), and big files in resumable parts straight to storage.
// Planning is lib/drive/client/uploads.ts (pure, tested); this file is the network.

import { DIRECT_UPLOAD_MAX, partRanges, type UploadJob, type UploadProgress } from "@/lib/drive/client/uploads";
import { ApiError, postJson } from "./api";

export type ConflictChoice = "replace" | "skip";

export interface UploadOptions {
  workspaceId: string;
  /** Display path of the folder to upload into. */
  dir: string;
  /** Asked when a file with that name exists; resolves to what to do. */
  onConflict: (name: string) => Promise<ConflictChoice>;
  onProgress: (items: UploadProgress[]) => void;
  signal?: AbortSignal;
}

interface InitiateDirect {
  mode: "direct";
  maxBytes: number;
}
interface InitiateMultipart {
  mode: "multipart";
  uploadId: string;
  partSize: number;
  partCount: number;
}

async function uploadDirect(job: UploadJob, o: UploadOptions, replace: boolean): Promise<Response> {
  const form = new FormData();
  form.append("workspaceId", o.workspaceId);
  form.append("dir", o.dir);
  form.append("file", job.file);
  if (job.relativePath) form.append("relativePath", job.relativePath);
  if (replace) form.append("replace", "1");
  return fetch("/api/drive/upload", { method: "POST", body: form, signal: o.signal });
}

/** PUT one part to its presigned URL, retrying a few times (a dropped connection costs one part, not the file). */
async function putPart(url: string, body: Blob, signal?: AbortSignal): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method: "PUT", body, signal });
      if (res.ok) return;
      last = new Error(`storage answered ${res.status}`);
    } catch (e) {
      if (signal?.aborted) throw e;
      last = e;
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw last instanceof Error ? last : new Error("part upload failed");
}

async function uploadMultipart(job: UploadJob, o: UploadOptions, init: InitiateMultipart, onSent: (n: number) => void): Promise<void> {
  const ranges = partRanges(job.file.size, init.partSize);
  const numbers = ranges.map((_, i) => i + 1);
  // Ask the provider which parts it already holds (resume), then send only the rest.
  const status = await postJson<{ missing: number[] }>("/api/drive/uploads", { workspaceId: o.workspaceId, action: "status", uploadId: init.uploadId });
  const todo = numbers.filter((n) => status.missing.includes(n));
  let sent = (numbers.length - todo.length) * init.partSize;
  onSent(Math.min(sent, job.file.size));
  const queue = [...todo];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const batch = queue.splice(0, 1);
      const { parts } = await postJson<{ parts: Array<{ partNumber: number; url: string }> }>("/api/drive/uploads", { workspaceId: o.workspaceId, action: "parts", uploadId: init.uploadId, parts: batch });
      for (const p of parts) {
        const [a, b] = ranges[p.partNumber - 1]!;
        await putPart(p.url, job.file.slice(a, b), o.signal);
        sent += b - a;
        onSent(Math.min(sent, job.file.size));
      }
    }
  });
  await Promise.all(workers);
  await postJson("/api/drive/uploads", { workspaceId: o.workspaceId, action: "complete", uploadId: init.uploadId });
}

/** Upload a batch one file at a time (keeps the memory low and the order predictable). */
export async function uploadBatch(jobs: UploadJob[], o: UploadOptions): Promise<UploadProgress[]> {
  const items: UploadProgress[] = jobs.map((j, i) => ({ id: i, name: j.relativePath ?? j.file.name, size: j.file.size, sent: 0, status: "queued" }));
  const push = () => o.onProgress(items.map((i) => ({ ...i })));
  push();
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]!;
    const item = items[i]!;
    if (o.signal?.aborted) {
      item.status = "skipped";
      continue;
    }
    item.status = "uploading";
    push();
    try {
      if (job.file.size > DIRECT_UPLOAD_MAX) {
        const dirParts = job.relativePath ? job.relativePath.split("/").slice(0, -1) : [];
        const dir = [o.dir, ...dirParts].join("/");
        const init = await postJson<InitiateDirect | InitiateMultipart>("/api/drive/uploads", { workspaceId: o.workspaceId, action: "initiate", dir, filename: job.file.name, size: job.file.size, mimeType: job.file.type || undefined });
        if (init.mode === "multipart") {
          await uploadMultipart(job, o, init, (n) => {
            item.sent = n;
            push();
          });
          item.status = "done";
          item.sent = item.size;
          push();
          continue;
        }
      }
      let res = await uploadDirect(job, o, false);
      if (res.status === 409) {
        const body = (await res.json().catch(() => null)) as { canReplace?: boolean } | null;
        if (body?.canReplace) {
          const choice = await o.onConflict(job.file.name);
          if (choice === "skip") {
            item.status = "skipped";
            push();
            continue;
          }
          res = await uploadDirect(job, o, true);
        }
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        throw new ApiError(body?.error ?? "Upload failed.", res.status, body?.code);
      }
      item.status = "done";
      item.sent = item.size;
    } catch (e) {
      item.status = "failed";
      item.error = e instanceof Error ? e.message : "Upload failed.";
    }
    push();
  }
  return items;
}
