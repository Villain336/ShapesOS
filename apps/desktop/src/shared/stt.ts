// ShapesOS Desktop: streaming speech-to-text, the pure parts.
//
// The server mints a short-lived token (POST /api/cursor/transcribe-token);
// the platform key never reaches this app. The audio window streams 16 kHz
// mono PCM s16le over a WebSocket and feeds every message into a
// TranscriptAssembler, which understands:
//   * AssemblyAI Universal Streaming v3: { type: "Turn", transcript, end_of_turn }
//   * Deepgram live: { type: "Results", channel.alternatives[0].transcript, is_final }
//   * the ShapesOS labelled mock (dev/e2e only): { type: "transcript", text, final }
//     (AssemblyAI-shaped mock messages work too).

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

/** The WebSocket URL + subprotocols for a provider (tokens can't go in headers from a browser). */
export function sttSocket(
  t: { provider: SttProvider; wsUrl: string; token: string; sampleRate: number },
): { url: string; protocols: string[] } | null {
  let u: URL;
  try {
    u = new URL(t.wsUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "wss:" && u.protocol !== "ws:") return null;
  const set = (k: string, v: string) => {
    if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  };
  switch (t.provider) {
    case "assemblyai":
      set("sample_rate", String(t.sampleRate));
      set("encoding", "pcm_s16le");
      set("format_turns", "true");
      set("token", t.token);
      return { url: u.toString(), protocols: [] };
    case "deepgram":
      set("encoding", "linear16");
      set("sample_rate", String(t.sampleRate));
      set("channels", "1");
      set("interim_results", "true");
      set("smart_format", "true");
      return { url: u.toString(), protocols: ["bearer", t.token] };
    case "mock":
      set("token", t.token);
      return { url: u.toString(), protocols: [] };
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
