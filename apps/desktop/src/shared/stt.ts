// ShapesOS Desktop: streaming speech-to-text, the pure parts.
//
// The server mints a short-lived token (POST /api/cursor/transcribe-token);
// the platform key never reaches this app. The audio window streams 16 kHz
// mono PCM s16le over a WebSocket and feeds every message into a
// TranscriptAssembler, which understands:
//   * AssemblyAI Universal Streaming v3: { type: "Turn", transcript, end_of_turn }
//   * Deepgram live: { type: "Results", channel.alternatives[0].transcript, is_final }
//   * the ShapesOS labelled mock (dev/e2e only): AssemblyAI-v3-shaped
//     { type: "Begin" | "Turn" | "Termination", transcript, end_of_turn, mock: true }
//     over SSE (and the older { type: "transcript", text, final } shape).

import type { SttProvider } from "./contract";

export class TranscriptAssembler {
  private finals: string[] = [];
  private partial = "";
  /** Provider error, if one arrived. */
  error: string | null = null;
  terminated = false;

  /** Feed one WebSocket text message; returns true when the transcript changed. */
  feed(raw: string): boolean {
    let m: unknown;
    try {
      m = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!m || typeof m !== "object") return false;
    const o = m as Record<string, unknown>;
    const type = typeof o.type === "string" ? o.type : "";

    if (typeof o.error === "string") {
      this.error = o.error;
      return false;
    }
    if (type === "Termination" || type === "terminated") {
      this.terminated = true;
      return false;
    }
    // AssemblyAI v3: one Turn object per turn, growing until end_of_turn.
    if (type === "Turn" && typeof o.transcript === "string") {
      if (o.end_of_turn === true) {
        if (o.transcript.trim()) this.finals.push(o.transcript.trim());
        this.partial = "";
      } else {
        this.partial = o.transcript;
      }
      return true;
    }
    // Deepgram: Results with is_final.
    if (type === "Results" && o.channel && typeof o.channel === "object") {
      const alts = (o.channel as Record<string, unknown>).alternatives;
      const first = Array.isArray(alts) ? (alts[0] as Record<string, unknown> | undefined) : undefined;
      const text = typeof first?.transcript === "string" ? first.transcript : "";
      if (o.is_final === true) {
        if (text.trim()) this.finals.push(text.trim());
        this.partial = "";
      } else {
        this.partial = text;
      }
      return true;
    }
    // ShapesOS mock.
    if (type === "transcript" && typeof o.text === "string") {
      if (o.final === true) {
        if (o.text.trim()) this.finals.push(o.text.trim());
        this.partial = "";
      } else {
        this.partial = o.text;
      }
      return true;
    }
    return false;
  }

  /** What to show as a live caption (finals + the current partial). */
  get live(): string {
    return [...this.finals, this.partial.trim()].filter(Boolean).join(" ");
  }

  /** The utterance when the key is released (partial included: the person stopped talking). */
  get final(): string {
    return this.live.replace(/\s+/g, " ").trim();
  }
}

/** How the transcribe-token response says the token travels (contract amendment, 2026-10-06). */
export type SttAuthVia = "query_token" | "bearer_header";

/**
 * Where the speech-to-text stream runs, decided from the transcribe-token
 * response (p19a-contract.md + the WS=server amendment):
 *   * renderer-ws — the hidden audio window opens the provider WebSocket
 *     itself, token in the query (AssemblyAI: `&token=`).
 *   * main-ws — a browser WebSocket can't send headers, so the MAIN process
 *     opens it with `Authorization: Bearer <token>` (Deepgram) and the audio
 *     window relays PCM to it over IPC.
 *   * main-sse — the server's labelled mock (dev/e2e only): `wsUrl` is an
 *     https SSE URL (GET /api/cursor/mock-stt) of AssemblyAI-v3-shaped
 *     messages, read by the main process with the signed-in session; no
 *     microphone is opened.
 */
export type SttPlan =
  | { transport: "renderer-ws"; url: string; protocols: string[] }
  | { transport: "main-ws"; url: string; headers: Record<string, string> }
  | { transport: "main-sse"; url: string };

export function sttPlan(t: {
  provider: SttProvider;
  wsUrl: string;
  token: string;
  sampleRate: number;
  authVia?: SttAuthVia;
}): SttPlan | null {
  let u: URL;
  try {
    u = new URL(t.wsUrl);
  } catch {
    return null;
  }
  const ws = u.protocol === "wss:" || u.protocol === "ws:";
  const http = u.protocol === "https:" || u.protocol === "http:";
  const set = (k: string, v: string) => {
    if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  };
  if (!t.token && t.provider !== "mock") return null;
  switch (t.provider) {
    case "assemblyai":
      if (!ws) return null;
      set("sample_rate", String(t.sampleRate));
      set("encoding", "pcm_s16le");
      set("format_turns", "true");
      if (t.authVia === "bearer_header") return { transport: "main-ws", url: u.toString(), headers: { Authorization: `Bearer ${t.token}` } };
      set("token", t.token);
      return { transport: "renderer-ws", url: u.toString(), protocols: [] };
    case "deepgram":
      if (!ws) return null;
      set("encoding", "linear16");
      set("sample_rate", String(t.sampleRate));
      set("channels", "1");
      set("interim_results", "true");
      set("smart_format", "true");
      if (t.authVia === "query_token") {
        set("token", t.token);
        return { transport: "renderer-ws", url: u.toString(), protocols: [] };
      }
      // The contract default for Deepgram: the Authorization header, from main.
      return { transport: "main-ws", url: u.toString(), headers: { Authorization: `Bearer ${t.token}` } };
    case "mock":
      if (http) return { transport: "main-sse", url: u.toString() };
      if (!ws) return null;
      if (t.token) set("token", t.token);
      return { transport: "renderer-ws", url: u.toString(), protocols: [] };
    default:
      return null;
  }
}

/** The message that asks a provider to finish and flush. */
export function sttCloseMessage(provider: SttProvider): string | null {
  if (provider === "assemblyai") return JSON.stringify({ type: "Terminate" });
  if (provider === "deepgram") return JSON.stringify({ type: "CloseStream" });
  if (provider === "mock") return JSON.stringify({ type: "Terminate" });
  return null;
}

/** Float32 samples [-1, 1] → little-endian signed 16-bit PCM. */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return out;
}

/** Linear resample (the AudioContext usually runs at 16 kHz already; this is the fallback). */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const f = pos - i0;
    out[i] = (input[i0] ?? 0) * (1 - f) + (input[i1] ?? 0) * f;
  }
  return out;
}
