// Marketr — Higgsfield API port (milestone 21).
//
// Thin wrapper around the Higgsfield public API so the ad service never
// touches HTTP directly: tests inject MockHiggsfieldPort (no network, no
// spend) and production injects createHiggsfieldPort(decryptedApiKey).
//
// API surface (per the higgsfield skill, verified 2026-09-17):
//   POST https://platform.higgsfield.ai/<application-path>  (args as JSON body)
//     → { request_id, status_url }
//   GET  https://platform.higgsfield.ai/requests/<id>/status → job status
// Auth: Authorization: Key <KEY_ID:KEY_SECRET>
//
// Model slugs are the application paths from GET /models. VIDEO_MODEL below
// is the verified Seedance 2.5 image-to-video route from the skill. IMAGE_MODEL
// is a CONFIGURABLE DEFAULT ONLY — image-generation slugs were NOT in the
// verified skill notes and MUST be confirmed via GET /models against a real
// key before any production image generation.
// NOTE: this is the provider API, NOT the old public higgsfield-ai/higgsfield
// GPU-orchestration repository.

export interface HiggsfieldJobArgs {
  modelPath: string;
  /** Provider args body, e.g. { image_url, prompt, duration, resolution }. */
  args: Record<string, unknown>;
}

export interface SubmittedJob {
  requestId: string;
  statusUrl: string;
}

export type HiggsfieldJobState = "queued" | "in_progress" | "completed" | "failed" | "cancelled";

export interface HiggsfieldJobStatus {
  requestId: string;
  state: HiggsfieldJobState;
  /** Finished media URLs (present when completed). */
  mediaUrls: string[];
  error?: string;
  /** Provider-reported cost in cents when available (usually absent). */
  costCents?: number;
}

export interface HiggsfieldPort {
  submitJob(job: HiggsfieldJobArgs): Promise<SubmittedJob>;
  getStatus(requestId: string): Promise<HiggsfieldJobStatus>;
}

const API_BASE = "https://platform.higgsfield.ai";

/** Verified route (skill, 2026-09-17): image-to-video. Args: image_url, prompt, duration, resolution ("480p"|"720p"). */
export const DEFAULT_VIDEO_MODEL = "bytedance/seedance-2.5/image-to-video";

/**
 * UNVERIFIED — placeholder default, confirm via GET /models before production.
 * Image-generation application paths were not covered by the verified skill
 * notes; do not ship production image jobs on this slug without checking the
 * live catalog first.
 */
export const DEFAULT_IMAGE_MODEL = "bytedance/seedance-2.5/text-to-image";

async function throwIfHiggsfieldError(res: Response, op: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  const err = new Error(`Higgsfield ${op} failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
  (err as { status?: number }).status = res.status;
  throw err;
}

/** Classify a failure as transient (worth polling/retrying) or permanent. */
export function isTransientHiggsfieldError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 429) return true;
  if (status !== undefined) return status >= 500;
  // Network-level errors (fetch threw) are transient.
  return err instanceof TypeError;
}

export function createHiggsfieldPort(apiKey: string): HiggsfieldPort {
  const headers = {
    Authorization: `Key ${apiKey}`,
    "Content-Type": "application/json",
  };
  return {
    async submitJob(job: HiggsfieldJobArgs): Promise<SubmittedJob> {
      const res = await fetch(`${API_BASE}/${job.modelPath}`, {
        method: "POST",
        headers,
        body: JSON.stringify(job.args),
      });
      await throwIfHiggsfieldError(res, "submit");
      const data = (await res.json()) as { request_id?: string; status_url?: string };
      if (!data.request_id) throw new Error("Higgsfield submit returned no request_id.");
      return { requestId: data.request_id, statusUrl: data.status_url ?? `${API_BASE}/requests/${data.request_id}/status` };
    },
    async getStatus(requestId: string): Promise<HiggsfieldJobStatus> {
      const res = await fetch(`${API_BASE}/requests/${encodeURIComponent(requestId)}/status`, { headers });
      await throwIfHiggsfieldError(res, "status");
      const data = (await res.json()) as {
        status?: string;
        result?: { urls?: string[]; url?: string };
        error?: string;
        cost_cents?: number;
      };
      const raw = String(data.status ?? "").toLowerCase();
      const state: HiggsfieldJobState =
        raw === "completed" || raw === "succeeded" || raw === "success"
          ? "completed"
          : raw === "failed" || raw === "error"
            ? "failed"
            : raw === "cancelled" || raw === "canceled"
              ? "cancelled"
              : raw === "in_progress" || raw === "processing" || raw === "running"
                ? "in_progress"
                : "queued";
      const urls = data.result?.urls ?? (data.result?.url ? [data.result.url] : []);
      return {
        requestId,
        state,
        mediaUrls: urls,
        error: data.error,
        costCents: typeof data.cost_cents === "number" ? data.cost_cents : undefined,
      };
    },
  };
}

/**
 * Mock port for tests and offline development. Scripted per request id:
 * the test controls the sequence of states returned by getStatus.
 * ZERO network calls — it never touches the real API.
 */
export class MockHiggsfieldPort implements HiggsfieldPort {
  private counter = 0;
  private submitted: HiggsfieldJobArgs[] = [];
  /** requestId → queue of states to return on successive getStatus calls. */
  private scripts = new Map<string, HiggsfieldJobStatus[]>();
  /** requestId → media URLs to attach when the script hits "completed". */
  private media = new Map<string, string[]>();

  getSubmitted(): HiggsfieldJobArgs[] {
    return this.submitted;
  }

  /** Seed a scripted state sequence for the next submitted job. */
  scriptNext(states: HiggsfieldJobState[], mediaUrls: string[] = [], error?: string): void {
    const id = `mock-req-${this.counter + 1}`;
    this.media.set(id, mediaUrls);
    this.scripts.set(
      id,
      states.map((s) => ({ requestId: id, state: s, mediaUrls: [], error })),
    );
  }

  /** Default behavior: 2 polls → completed with one mock asset. */
  async submitJob(job: HiggsfieldJobArgs): Promise<SubmittedJob> {
    this.counter += 1;
    this.submitted.push(job);
    const id = `mock-req-${this.counter}`;
    if (!this.scripts.has(id)) {
      this.scripts.set(id, [
        { requestId: id, state: "in_progress", mediaUrls: [] },
        { requestId: id, state: "completed", mediaUrls: [] },
      ]);
      this.media.set(id, [`https://cdn.example.com/ads/${id}.mp4`]);
    }
    return { requestId: id, statusUrl: `https://platform.higgsfield.ai/requests/${id}/status` };
  }

  async getStatus(requestId: string): Promise<HiggsfieldJobStatus> {
    const queue = this.scripts.get(requestId);
    if (!queue || queue.length === 0) {
      return { requestId, state: "completed", mediaUrls: this.media.get(requestId) ?? [] };
    }
    const next = queue.shift()!;
    if (next.state === "completed" && next.mediaUrls.length === 0) {
      next.mediaUrls = this.media.get(requestId) ?? [`https://cdn.example.com/ads/${requestId}.mp4`];
    }
    return next;
  }
}
