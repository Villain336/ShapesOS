// ShapesOS — Phase 19A (WS=server): spoken answers for the agentic cursor.
// fetch only; every key is a platform key held by the server (the desktop
// never sees one). Streamed MP3 back to the caller.
//
// Order (first that is configured AND answers; a provider that fails before
// any audio is sent falls through to the next):
//   1. ElevenLabs streaming (verified 2026-10-06):
//        POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream
//             ?output_format=mp3_44100_128
//        header xi-api-key: <ELEVENLABS_API_KEY>; body { text, model_id }
//        → chunked audio/mpeg.  Voices: GET https://api.elevenlabs.io/v2/voices
//        ?page_size=100 → { voices: [{ voice_id, name, category, … }] }
//        https://elevenlabs.io/docs/api-reference/text-to-speech/stream
//        https://elevenlabs.io/docs/api-reference/voices/search
//   2. VoiceStudio (lib/voice/voicestudio.ts), only when VOICESTUDIO_URL is
//      set: the self-hosted engine (no credits). It is a single-worker CPU
//      engine, so the cursor gives it a short timeout.
//   3. OpenAI speech (verified 2026-10-06): POST https://api.openai.com/v1/audio/speech
//        { model, input, voice, response_format: "mp3" } → chunked audio.
//        Built-in voices per the guide: alloy, ash, ballad, coral, echo, fable,
//        nova, onyx, sage, shimmer, verse, marin, cedar.
//        https://developers.openai.com/api/docs/guides/text-to-speech
//
// No provider → "none" (503 tts_not_configured). A labelled mock (a short
// silent MP3, X-Shapes-Mock: 1) only with ALLOW_FAKE_PROVIDERS=1.
// Voice ids are never invented: ElevenLabs' and VoiceStudio's come from the
// provider's own list; OpenAI's are its documented built-ins.

import { cursorMocksAllowed } from "./stt";

export type TtsProviderName = "elevenlabs" | "voicestudio" | "openai" | "mock" | "none";
type Env = Record<string, string | undefined>;

export const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
export const ELEVENLABS_VOICES_URL = "https://api.elevenlabs.io/v2/voices?page_size=100";
/** Low-latency ElevenLabs model (the cursor speaks while it thinks); ELEVENLABS_MODEL_ID overrides. */
export const ELEVENLABS_DEFAULT_MODEL = "eleven_flash_v2_5";
export const ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128";
export const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
/** OpenAI's lower-latency speech model; OPENAI_TTS_MODEL overrides. */
export const OPENAI_TTS_DEFAULT_MODEL = "tts-1";
/** OpenAI's documented built-in voices (the guide above). */
export const OPENAI_TTS_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"] as const;
export const OPENAI_TTS_DEFAULT_VOICE = "alloy";
/** The cursor never waits minutes for a spoken answer. */
export const VOICESTUDIO_CURSOR_TIMEOUT_MS = 30_000;
/** Contract: ≤ 2,000 characters per call. */
export const MAX_TTS_CHARS = 2_000;

export interface TtsVoice {
  id: string;
  label: string;
}

export function ttsProviderChain(env: Env = process.env): Array<Exclude<TtsProviderName, "none">> {
  const chain: Array<Exclude<TtsProviderName, "none">> = [];
  if (env.ELEVENLABS_API_KEY?.trim()) chain.push("elevenlabs");
  if (env.VOICESTUDIO_URL?.trim()) chain.push("voicestudio");
  if (env.OPENAI_API_KEY?.trim()) chain.push("openai");
  if (chain.length === 0 && cursorMocksAllowed(env)) chain.push("mock");
  return chain;
}

/** The provider the session reports (the first of the chain). */
export function ttsProviderName(env: Env = process.env): TtsProviderName {
  return ttsProviderChain(env)[0] ?? "none";
}

export class TtsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: "tts_not_configured" | "tts_provider_error" | "tts_bad_voice",
  ) {
    super(message);
    this.name = "TtsError";
  }
}

export interface TtsDeps {
  env?: Env;
  fetchImpl?: typeof fetch;
  /** VoiceStudio client (tests inject one). */
  voiceStudio?: {
    listVoices(): Promise<Array<{ voice_id: string; name: string }>>;
    synthesize(o: { voice: string; input: string; format?: string; timeoutMs?: number }): Promise<Buffer>;
  };
}

async function voiceStudioClient(deps: TtsDeps): Promise<NonNullable<TtsDeps["voiceStudio"]>> {
  if (deps.voiceStudio) return deps.voiceStudio;
  const vs = await import("./voicestudio");
  return { listVoices: () => vs.listVoices(), synthesize: (o) => vs.synthesize(o) };
}

/** Voices the person can pick for a provider (discovered, never invented). */
export async function listTtsVoices(provider: TtsProviderName, deps: TtsDeps = {}): Promise<TtsVoice[]> {
  const env = deps.env ?? process.env;
  const f = deps.fetchImpl ?? fetch;
  if (provider === "elevenlabs") {
    const res = await f(ELEVENLABS_VOICES_URL, { headers: { "xi-api-key": env.ELEVENLABS_API_KEY!.trim() } });
    if (!res.ok) throw new TtsError(`ElevenLabs voices could not be read (${res.status}).`, 502, "tts_provider_error");
    const body = (await res.json().catch(() => ({}))) as { voices?: Array<{ voice_id?: unknown; name?: unknown }> };
    return (body.voices ?? [])
      .filter((v): v is { voice_id: string; name: string } => typeof v.voice_id === "string" && typeof v.name === "string")
      .map((v) => ({ id: v.voice_id, label: v.name }));
  }
  if (provider === "voicestudio") {
    const vs = await voiceStudioClient(deps);
    return (await vs.listVoices()).map((v) => ({ id: v.voice_id, label: v.name || v.voice_id }));
  }
  if (provider === "openai") return OPENAI_TTS_VOICES.map((v) => ({ id: v, label: v.charAt(0).toUpperCase() + v.slice(1) }));
  if (provider === "mock") return [{ id: "mock-silent", label: "Mock voice (silent)" }];
  return [];
}

/** A short silent MPEG-1 Layer III clip (10 frames, 128 kbps, 44.1 kHz ≈ 0.26 s) for the labelled mock. */
export function silentMp3(frames = 10): Uint8Array {
  const frameLen = 417; // 144 × 128000 / 44100, no padding
  const out = new Uint8Array(frameLen * frames);
  for (let i = 0; i < frames; i++) {
    out.set([0xff, 0xfb, 0x90, 0x64], i * frameLen);
  }
  return out;
}

export interface TtsResult {
  provider: Exclude<TtsProviderName, "none">;
  voice: string;
  body: ReadableStream<Uint8Array>;
  contentType: string;
  mock: boolean;
  /** Characters billed (the text length). */
  chars: number;
  /** ElevenLabs / OpenAI model id used (for pricing); null otherwise. */
  model: string | null;
}

function bytesStream(b: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(b);
      c.close();
    },
  });
}

/**
 * Speak `text`. `voice` is the person's choice for `voiceProvider`; when the
 * chain falls through to another provider, that provider's default voice is
 * used (voice ids are provider-specific).
 */
export async function synthesizeSpeech(
  input: { text: string; voice?: string | null; voiceProvider?: TtsProviderName | null },
  deps: TtsDeps = {},
): Promise<TtsResult> {
  const env = deps.env ?? process.env;
  const f = deps.fetchImpl ?? fetch;
  const text = input.text.trim();
  if (!text) throw new TtsError("Nothing to say.", 400, "tts_bad_voice");
  const chain = ttsProviderChain(env);
  if (chain.length === 0) throw new TtsError("Spoken answers are not configured on this server (set ELEVENLABS_API_KEY, VOICESTUDIO_URL or OPENAI_API_KEY).", 503, "tts_not_configured");
  const failures: string[] = [];
  for (const provider of chain) {
    const chosen = input.voiceProvider === provider ? input.voice ?? null : null;
    try {
      if (provider === "mock") {
        return { provider, voice: "mock-silent", body: bytesStream(silentMp3()), contentType: "audio/mpeg", mock: true, chars: text.length, model: null };
      }
      if (provider === "elevenlabs") {
        let voice = chosen || env.ELEVENLABS_VOICE_ID?.trim() || "";
        if (!voice) {
          const voices = await listTtsVoices("elevenlabs", deps);
          voice = voices[0]?.id ?? "";
        }
        if (!voice) throw new Error("no ElevenLabs voice is available on this account");
        const model = env.ELEVENLABS_MODEL_ID?.trim() || ELEVENLABS_DEFAULT_MODEL;
        const res = await f(`${ELEVENLABS_TTS_URL}/${encodeURIComponent(voice)}/stream?output_format=${ELEVENLABS_OUTPUT_FORMAT}`, {
          method: "POST",
          headers: { "xi-api-key": env.ELEVENLABS_API_KEY!.trim(), "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({ text, model_id: model }),
        });
        if (!res.ok || !res.body) throw new Error(`ElevenLabs answered ${res.status}`);
        return { provider, voice, body: res.body, contentType: "audio/mpeg", mock: false, chars: text.length, model };
      }
      if (provider === "voicestudio") {
        const vs = await voiceStudioClient(deps);
        let voice = chosen ?? "";
        if (!voice) voice = (await vs.listVoices())[0]?.voice_id ?? "";
        if (!voice) throw new Error("VoiceStudio has no voices");
        const audio = await vs.synthesize({ voice, input: text, format: "mp3", timeoutMs: VOICESTUDIO_CURSOR_TIMEOUT_MS });
        return { provider, voice, body: bytesStream(new Uint8Array(audio)), contentType: "audio/mpeg", mock: false, chars: text.length, model: null };
      }
      // openai
      const voice = chosen && (OPENAI_TTS_VOICES as readonly string[]).includes(chosen) ? chosen : OPENAI_TTS_DEFAULT_VOICE;
      const model = env.OPENAI_TTS_MODEL?.trim() || OPENAI_TTS_DEFAULT_MODEL;
      const res = await f(OPENAI_SPEECH_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY!.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: text, voice, response_format: "mp3" }),
      });
      if (!res.ok || !res.body) throw new Error(`OpenAI speech answered ${res.status}`);
      return { provider, voice, body: res.body, contentType: "audio/mpeg", mock: false, chars: text.length, model };
    } catch (err) {
      failures.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new TtsError(`No speech provider answered (${failures.join("; ")}).`.slice(0, 500), 502, "tts_provider_error");
}
