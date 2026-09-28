// Marketr — Phase 13D Worker B: VoiceStudio TTS client.
//
// VoiceStudio is the DEFAULT and only default TTS backend (Tico's standing
// instruction 2026-09-27: "Use Voicestudio repo for voice"). Provider voices
// (ElevenLabs etc.) are a per-workspace opt-in fallback ONLY — never the
// default path, and never built here.
//
// VoiceStudio backend: ~/workspace/voicestudio, OpenAI-compatible API at
//   POST /v1/audio/speech  { model:"tts-1", voice:"<voice_id>", input:"…",
//                             response_format:"wav" } → audio bytes
//   GET  /v1/audio/voices   → { voices: [{ voice_id, name, type, … }] }
//   GET  /health            → { status:"ok", device, version }
// Base URL: process.env.VOICESTUDIO_URL || "http://localhost:3900".
//
// Errors are classified HONESTLY — a refused connection is "backend down",
// not "empty audio"; callers surface the right remediation.
//
// Never invent voice ids: listVoices() discovers them from the backend and
// caches the list; synthesize() refuses unknown ids before spending a call.

export const VOICESTUDIO_DEFAULT_URL = "http://localhost:3900";
// CPU reality (measured 2026-09-28): the VoiceStudio engine on this box is
// serial and CPU-bound — even a 12-char synthesis can take several MINUTES
// while the box is loaded. The timeout below only bounds a hung backend;
// a refused connection fails FAST (kind "down") regardless of this value.
const DEFAULT_TIMEOUT_MS = 600_000;

export function voiceStudioUrl(): string {
  return (
    process.env.VOICESTUDIO_URL?.trim().replace(/\/+$/, "") ||
    VOICESTUDIO_DEFAULT_URL
  );
}

export interface VoiceStudioVoice {
  voice_id: string;
  name: string;
  type: string;
  description?: string;
}

export interface SynthesizeOptions {
  voice: string;
  input: string;
  /** default "wav" — only formats the backend advertises should be requested. */
  format?: string;
  model?: string;
  timeoutMs?: number;
}

// ── Honest error taxonomy ──────────────────────────────────────────────────

export class VoiceStudioError extends Error {
  readonly kind: "down" | "model" | "request" | "empty";
  readonly status?: number;
  /** Whether synthesize() may retry this error once. */
  readonly retryable: boolean;
  /** If set, synthesize() waits this long before its one retry. */
  readonly retryAfterMs?: number;
  constructor(
    kind: VoiceStudioError["kind"],
    message: string,
    status?: number,
    retryable = false,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "VoiceStudioError";
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Backend unreachable / connection refused / DNS — never reported as audio. */
export const isBackendDown = (e: unknown): boolean =>
  e instanceof VoiceStudioError && e.kind === "down";

// ── Internal fetch with timeout ────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (ctrl.signal.aborted) {
      // The backend accepted the connection but never answered in time:
      // alive, not down — the engine is just slow (CPU box, serial).
      // Retrying would only queue a duplicate job behind the same engine.
      throw new VoiceStudioError(
        "model",
        `VoiceStudio accepted the request but did not answer within ${Math.round(timeoutMs / 1000)}s — ` +
          `backend is alive but too slow on this box. Retry later or raise the timeout.`,
        undefined,
        false,
      );
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new VoiceStudioError(
      "down",
      `VoiceStudio backend unreachable at ${url}: ${msg}. ` +
        `Is VoiceStudio running (~/workspace/voicestudio, GET /health)?`,
      undefined,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

// ── Health ─────────────────────────────────────────────────────────────────

export interface VoiceStudioHealth {
  status: string;
  device?: string;
  version?: string;
}

/** Returns the backend's own health payload, or throws VoiceStudioError(down). */
export async function health(timeoutMs = 10_000): Promise<VoiceStudioHealth> {
  const res = await fetchWithTimeout(
    `${voiceStudioUrl()}/health`,
    { method: "GET" },
    timeoutMs,
  );
  if (!res.ok) {
    throw new VoiceStudioError(
      "down",
      `VoiceStudio /health returned ${res.status} — backend unhealthy.`,
      res.status,
    );
  }
  return (await res.json()) as VoiceStudioHealth;
}

// ── Voices (discovered, cached) ────────────────────────────────────────────

let voicesCache: { at: number; voices: VoiceStudioVoice[] } | null = null;
const VOICES_CACHE_TTL_MS = 5 * 60_000;

/** Discover voices from the live backend. Never invent ids — cache the list. */
export async function listVoices(opts?: {
  timeoutMs?: number;
  forceRefresh?: boolean;
}): Promise<VoiceStudioVoice[]> {
  if (
    !opts?.forceRefresh &&
    voicesCache &&
    Date.now() - voicesCache.at < VOICES_CACHE_TTL_MS
  ) {
    return voicesCache.voices;
  }
  const res = await fetchWithTimeout(
    `${voiceStudioUrl()}/v1/audio/voices`,
    { method: "GET" },
    opts?.timeoutMs ?? 15_000,
  );
  if (!res.ok) {
    throw new VoiceStudioError(
      "down",
      `VoiceStudio /v1/audio/voices returned ${res.status}.`,
      res.status,
    );
  }
  const body = (await res.json()) as { voices?: VoiceStudioVoice[] };
  const voices = Array.isArray(body.voices) ? body.voices : [];
  voicesCache = { at: Date.now(), voices };
  return voices;
}

/** Test/seeding hook: drop the cached voice list. */
export function clearVoicesCache(): void {
  voicesCache = null;
}

// ── Synthesis ──────────────────────────────────────────────────────────────

function classifyHttpError(status: number, bodyText: string): VoiceStudioError {
  if (status === 400 || status === 404 || status === 422) {
    return new VoiceStudioError(
      "request",
      `VoiceStudio rejected the synthesis request (${status}): ${bodyText.slice(0, 300)}`,
      status,
      false, // never retry a 4xx
    );
  }
  if (status === 429) {
    // The single CPU worker is saturated — the backend's own log says this
    // request is safe to retry as-is in ~66s. Classify as engine-side, NOT
    // "down": the backend is alive, just busy.
    return new VoiceStudioError(
      "model",
      `VoiceStudio is saturated (429): the single worker is busy with another generation. Retry in ~70s.`,
      status,
      true,
      70_000,
    );
  }
  if (status === 500 || status === 502 || status === 503) {
    // 5xx from a local backend is a model/engine failure, not our request.
    return new VoiceStudioError(
      "model",
      `VoiceStudio engine failed during synthesis (${status}): ${bodyText.slice(0, 300)}`,
      status,
      true,
    );
  }
  return new VoiceStudioError(
    "down",
    `VoiceStudio returned unexpected status ${status}: ${bodyText.slice(0, 300)}`,
    status,
    true,
  );
}

async function synthesizeOnce(o: SynthesizeOptions): Promise<Buffer> {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const input = o.input.trim();
  if (!input) throw new VoiceStudioError("request", "Synthesis input is empty.");
  if (!o.voice) throw new VoiceStudioError("request", "No voice id given.");

  const res = await fetchWithTimeout(
    `${voiceStudioUrl()}/v1/audio/speech`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: o.model ?? "tts-1",
        voice: o.voice,
        input,
        response_format: o.format ?? "wav",
      }),
    },
    timeoutMs,
  );

  if (!res.ok) {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      /* ignore */
    }
    throw classifyHttpError(res.status, bodyText);
  }

  const contentType = res.headers.get("content-type") ?? "";
  const bytes = Buffer.from(await res.arrayBuffer());

  // PROBE the output before anyone can claim audio: refuse error pages /
  // JSON error bodies masquerading as audio, and empty responses.
  if (bytes.length === 0) {
    throw new VoiceStudioError(
      "empty",
      "VoiceStudio returned 200 with an empty body — no audio received.",
      200,
      true,
    );
  }
  if (contentType.includes("application/json")) {
    throw new VoiceStudioError(
      "model",
      `VoiceStudio returned JSON instead of audio: ${bytes.toString("utf8").slice(0, 300)}`,
      200,
      false,
    );
  }
  return bytes;
}

/**
 * Synthesize text to WAV audio bytes.
 * One retry on retryable generation failures (backend-down, 5xx, empty) —
 * never on bad-request and never on engine-timeout (a duplicate would just
 * queue behind the same slow serial engine). Output is probed (non-empty,
 * not JSON) before return; we never claim audio from an error response.
 */
export async function synthesize(o: SynthesizeOptions): Promise<Buffer> {
  try {
    return await synthesizeOnce(o);
  } catch (e) {
    if (e instanceof VoiceStudioError && !e.retryable) throw e;
    // One retry — honoring the backend's own backoff hint when it gives one
    // (429 saturation: ~70s), else a short 750ms pause.
    const waitMs =
      e instanceof VoiceStudioError && e.retryAfterMs ? e.retryAfterMs : 750;
    await new Promise((r) => setTimeout(r, waitMs));
    return await synthesizeOnce(o);
  }
}

/**
 * Convenience: synthesize with a voice id verified against the discovered
 * voice list. Throws a "request" error listing available ids when unknown.
 */
export async function synthesizeWithKnownVoice(
  o: SynthesizeOptions,
): Promise<Buffer> {
  const voices = await listVoices();
  const ids = voices.map((v) => v.voice_id);
  if (!ids.includes(o.voice)) {
    throw new VoiceStudioError(
      "request",
      `Unknown voice id "${o.voice}". Known VoiceStudio voices: ${ids.join(", ")}.`,
    );
  }
  return synthesize(o);
}
