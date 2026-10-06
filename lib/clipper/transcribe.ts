// Marketr — Phase 13C clipper: transcription providers.
//
// Contract: audio in → word-level timed transcript out.
// Key handling follows the repo's provider convention (lib/llm/router.ts):
// keys come from env, read at call time, never cached at import; a missing
// key is an HONEST hard error, never a silent mock.

import type { Word, WordTimedTranscript } from "./types";

export interface TranscribeOptions {
  /** Language hint (BCP-47, e.g. "en"). Defaults to auto-detect. */
  language?: string;
  /** Whisper-class model name. Env TRANSCRIPTION_MODEL, default "whisper-1". */
  model?: string;
  // Phase 18.2 (WS=comms): Meet uploads recordings in their own format
  // (m4a / webm / wav / mp3); the API reads the format from the file name.
  // Default unchanged: "audio.mp3" / audio/mpeg.
  fileName?: string;
  mimeType?: string;
}

export interface TranscriptionProvider {
  /** Stable provider key, e.g. "openai-whisper" | "mock". */
  readonly name: string;
  /** True only when backed by a real transcription API. */
  readonly isLive: boolean;
  transcribe(audio: Buffer, opts?: TranscribeOptions): Promise<WordTimedTranscript>;
}

/** Thrown when no transcription key is configured. Never fake a transcript. */
export class TranscriptionNotConfiguredError extends Error {
  constructor() {
    super(
      "Transcription key not configured: set TRANSCRIPTION_API_KEY (or reuse OPENAI_API_KEY / LLM_API_KEY) " +
        "to enable real transcription, or use the mock provider explicitly in tests/dev.",
    );
    this.name = "TranscriptionNotConfiguredError";
  }
}

/**
 * Resolve the transcription API key the way other providers resolve BYO
 * keys: dedicated env first, then the shared OpenAI-compatible key chain.
 * Read at call time (never cached) per the router's T4 convention.
 */
export function resolveTranscriptionKey(): string {
  return (
    process.env.TRANSCRIPTION_API_KEY ??
    process.env.OPENAI_API_KEY ??
    process.env.LLM_API_KEY ??
    ""
  ).trim();
}

function resolveTranscriptionBaseUrl(): string {
  return (
    process.env.TRANSCRIPTION_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    process.env.LLM_BASE_URL ??
    "https://api.openai.com/v1"
  ).trim().replace(/\/$/, "");
}

/** OpenAI-compatible whisper-class provider (POST /audio/transcriptions). */
export class WhisperTranscriptionProvider implements TranscriptionProvider {
  readonly name = "openai-whisper";
  readonly isLive = true;

  async transcribe(
    audio: Buffer,
    opts: TranscribeOptions = {},
  ): Promise<WordTimedTranscript> {
    const key = resolveTranscriptionKey();
    if (!key) throw new TranscriptionNotConfiguredError();
    const model =
      opts.model ?? (((process.env.TRANSCRIPTION_MODEL ?? "").trim()) || "whisper-1");

    const form = new FormData();
    // Node's global FormData accepts a Blob; wrap the Buffer to stay typed.
    form.append("file", new Blob([Uint8Array.from(audio)], { type: opts.mimeType ?? "audio/mpeg" }), opts.fileName ?? "audio.mp3");
    form.append("model", model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    if (opts.language) form.append("language", opts.language);

    const res = await fetch(`${resolveTranscriptionBaseUrl()}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Transcription API error ${res.status}: ${body.slice(0, 500)}`,
      );
    }
    return normalizeVerboseJson((await res.json()) as Record<string, unknown>);
  }
}

/** Map whisper verbose_json → WordTimedTranscript, defensively. */
function normalizeVerboseJson(json: Record<string, unknown>): WordTimedTranscript {
  const rawWords = Array.isArray(json.words) ? json.words : [];
  const words: Word[] = [];
  for (const entry of rawWords) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const w = typeof e.word === "string" ? e.word.trim() : "";
    const start = Number(e.start);
    const end = Number(e.end);
    if (!w || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    words.push({ w, start, end });
  }
  words.sort((a, b) => a.start - b.start);
  const text =
    typeof json.text === "string" && json.text.trim()
      ? json.text.trim()
      : words.map((w) => w.w).join(" ");
  return { words, text };
}

/**
 * Fixture transcript for tests/dev ONLY — clearly labeled mock:true so a
 * fixture can never be mistaken for real transcription output.
 */
export const MOCK_TRANSCRIPT_FIXTURE: WordTimedTranscript = (() => {
  const text =
    "Stop scrolling. If you are building a business in 2026, here is the one thing that actually matters: speed to distribution is the moat. Nobody remembers the second best product. Ship it, get it into users hands, and let the market teach you what to build next.";
  const words: Word[] = [];
  let t = 0;
  for (const w of text.split(" ")) {
    const dur = 0.28 + (w.length % 3) * 0.04;
    words.push({ w, start: +t.toFixed(2), end: +(t + dur).toFixed(2) });
    t += dur + 0.06;
  }
  return { words, text, mock: true };
})();

/** Dev/test provider returning the fixture. Never selected automatically. */
export class MockTranscriptionProvider implements TranscriptionProvider {
  readonly name = "mock";
  readonly isLive = false;

  async transcribe(_audio: Buffer, _opts?: TranscribeOptions): Promise<WordTimedTranscript> {
    console.warn(
      "[clipper/transcribe] MockTranscriptionProvider used — fixture transcript, not real speech. Dev/test only.",
    );
    return MOCK_TRANSCRIPT_FIXTURE;
  }
}

/**
 * Factory: returns the whisper provider when a key is configured, otherwise
 * THROWS TranscriptionNotConfiguredError. The mock is deliberately NOT the
 * fallback — silence about a missing key is how fake transcripts leak into
 * production. Callers that explicitly want the fixture use
 * MockTranscriptionProvider directly.
 */
export function getTranscriptionProvider(): TranscriptionProvider {
  if (!resolveTranscriptionKey()) throw new TranscriptionNotConfiguredError();
  return new WhisperTranscriptionProvider();
}
