// ShapesOS Desktop: voice in (STT through the hidden audio window) and voice
// out (POST /api/cursor/tts streamed into the audio window).
//
// Voice out speaks the answer sentence by sentence as text_delta events
// arrive, one request at a time, and stops instantly on stop() (the stop
// key, or pressing the talk key again): the in-flight fetch is aborted and
// playback is cut.

import type { BrowserWindow } from "electron";
import { TTS_MAX_CHARS, type TtsProvider } from "../shared/contract";
import { sttCloseMessage, sttSocket } from "../shared/stt";
import type { ShapesApi } from "./api";

/** Split streaming text into speakable chunks at sentence ends. */
export class SentenceBuffer {
  private buf = "";

  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    for (;;) {
      // The first sentence end that leaves a speakable piece (≥ 12 chars, so
      // "e.g." or "1." stay with what follows).
      const ends = /[.!?\u2026]["')\]]*\s+|\n+/g;
      let cut = -1;
      for (let m = ends.exec(this.buf); m; m = ends.exec(this.buf)) {
        const e = m.index + m[0].length;
        if (this.buf.slice(0, e).trim().length >= 12) {
          cut = e;
          break;
        }
      }
      if (cut === -1) break;
      out.push(...chunk(this.buf.slice(0, cut)));
      this.buf = this.buf.slice(cut);
    }
    if (this.buf.length > TTS_MAX_CHARS) {
      out.push(...chunk(this.buf));
      this.buf = "";
    }
    return out.filter((s) => s.trim());
  }

  flush(): string[] {
    const rest = this.buf;
    this.buf = "";
    return chunk(rest).filter((s) => s.trim());
  }
}

function chunk(s: string): string[] {
  const t = s.trim();
  if (t.length <= TTS_MAX_CHARS) return [t];
  const out: string[] = [];
  for (let i = 0; i < t.length; i += TTS_MAX_CHARS) out.push(t.slice(i, i + TTS_MAX_CHARS));
  return out;
}

export class SpeechOut {
  private queue: string[] = [];
  private running = false;
  private abort: AbortController | null = null;
  private seq = 0;
  private waiters = new Map<number, () => void>();
  private idleWaiters: (() => void)[] = [];
  provider: TtsProvider = "none";
  enabled = true;
  /** For the smoke and Settings: the last response's provider header. */
  lastProviderHeader: string | null = null;
  lastMock = false;
  onActive: (active: boolean) => void = () => undefined;

  constructor(
    private api: ShapesApi,
    private audio: () => BrowserWindow | null,
  ) {}

  get active(): boolean {
    return this.running || this.queue.length > 0;
  }

  /** The audio window reports a clip finished. */
  done(id: number): void {
    this.waiters.get(id)?.();
    this.waiters.delete(id);
  }

  say(text: string): void {
    if (!this.enabled || this.provider === "none" || !text.trim()) return;
    this.queue.push(text);
    if (!this.running) void this.pump();
  }

  /** Resolves when everything queued has been spoken (or stopped). */
  idle(): Promise<void> {
    if (!this.active) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  stop(): void {
    this.queue = [];
    this.abort?.abort();
    this.abort = null;
    const w = this.audio();
    if (w && !w.isDestroyed()) w.webContents.send("audio:tts-stop");
    for (const r of this.waiters.values()) r();
    this.waiters.clear();
  }

  private async pump(): Promise<void> {
    this.running = true;
    this.onActive(true);
    try {
      while (this.queue.length) {
        const text = this.queue.shift()!;
        const id = ++this.seq;
        const ctl = new AbortController();
        this.abort = ctl;
        const w = this.audio();
        if (!w || w.isDestroyed()) break;
        try {
          const res = await this.api.tts(text, ctl.signal);
          this.lastProviderHeader = res.headers.get("x-shapes-tts-provider");
          this.lastMock = res.headers.get("x-shapes-mock") === "1";
          const finished = new Promise<void>((r) => this.waiters.set(id, r));
          w.webContents.send("audio:tts-begin", { id });
          const reader = res.body?.getReader();
          if (reader) {
            for (;;) {
              const { value, done } = await reader.read();
              if (done || ctl.signal.aborted) break;
              w.webContents.send("audio:tts-chunk", { id, bytes: value });
            }
          }
          w.webContents.send("audio:tts-end", { id });
          // Wait for playback, but never forever (a broken clip).
          await Promise.race([finished, new Promise((r) => setTimeout(r, 60_000))]);
        } catch {
          if (ctl.signal.aborted) break;
          // A failed clip is skipped; captions still show the text.
        }
      }
    } finally {
      this.running = false;
      this.abort = null;
      this.onActive(false);
      for (const r of this.idleWaiters.splice(0)) r();
    }
  }
}

/** Voice in: a short-lived STT token from ShapesOS, then the audio window streams the mic. */
export class SpeechIn {
  private live = "";
  private finalWaiter: ((t: string) => void) | null = null;
  private active = false;
  error: string | null = null;
  onLive: (text: string) => void = () => undefined;

  constructor(
    private api: ShapesApi,
    private audio: () => BrowserWindow | null,
  ) {}

  async start(): Promise<boolean> {
    this.live = "";
    this.error = null;
    const w = this.audio();
    if (!w || w.isDestroyed()) {
      this.error = "Audio isn't ready yet.";
      return false;
    }
    const t = await this.api.transcribeToken();
    const sock = sttSocket(t);
    if (!sock) {
      this.error = "Speech-to-text isn't configured on this server.";
      return false;
    }
    this.active = true;
    w.webContents.send("audio:stt-start", {
      url: sock.url,
      protocols: sock.protocols,
      provider: t.provider,
      sampleRate: t.sampleRate,
      closeMessage: sttCloseMessage(t.provider),
    });
    return true;
  }

  update(text: string): void {
    this.live = text;
    this.onLive(text);
  }

  final(text: string, error: string | null): void {
    if (error) this.error = error;
    if (text) this.live = text;
    this.finalWaiter?.(this.live);
    this.finalWaiter = null;
  }

  /** Key released: stop the mic and wait (briefly) for the provider's last words. */
  async stop(graceMs = 1500): Promise<string> {
    if (!this.active) return this.live;
    this.active = false;
    const w = this.audio();
    const result = new Promise<string>((r) => (this.finalWaiter = r));
    if (w && !w.isDestroyed()) w.webContents.send("audio:stt-stop");
    const timeout = new Promise<string>((r) => setTimeout(() => r(this.live), graceMs));
    const text = await Promise.race([result, timeout]);
    this.finalWaiter = null;
    return text.trim();
  }

  cancel(): void {
    this.active = false;
    this.finalWaiter = null;
    const w = this.audio();
    if (w && !w.isDestroyed()) w.webContents.send("audio:stt-stop");
  }
}
