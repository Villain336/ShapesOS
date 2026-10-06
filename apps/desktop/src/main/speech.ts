// ShapesOS Desktop: voice in (STT through the hidden audio window) and voice
// out (POST /api/cursor/tts streamed into the audio window).
//
// Voice out speaks the answer sentence by sentence as text_delta events
// arrive, one request at a time, and stops instantly on stop() (the stop
// key, or pressing the talk key again): the in-flight fetch is aborted and
// playback is cut.

import type { BrowserWindow } from "electron";
import { TTS_MAX_CHARS, type TtsProvider } from "../shared/contract";
import type { SttStart } from "../shared/ipc";
import { sttCloseMessage, sttPlan, TranscriptAssembler, type SttPlan } from "../shared/stt";
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

/** The WebSocket the main process opens (undici in Electron's Node; accepts headers). */
type MainSocket = Pick<WebSocket, "send" | "close" | "readyState"> & {
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onopen: (() => void) | null;
  binaryType: string;
};
export type MainSocketFactory = (url: string, headers: Record<string, string>) => MainSocket;

const defaultSocket: MainSocketFactory = (url, headers) =>
  // Node's (undici) WebSocket takes a non-standard init with `headers`
  // (verified in Electron 44.5.1 / Node 24.21: the upgrade request carries
  // Authorization). The DOM type doesn't know that, hence the cast.
  new (WebSocket as unknown as new (u: string, init: { headers: Record<string, string> }) => MainSocket)(url, { headers });

/**
 * Voice in: a short-lived STT token from ShapesOS, then one of three
 * transports (shared/stt.ts sttPlan):
 *   renderer-ws — the audio window streams the mic straight to the provider;
 *   main-ws     — the audio window relays PCM over IPC and this process holds
 *                 the socket (Authorization header, Deepgram);
 *   main-sse    — the server's LABELLED mock: a scripted SSE transcript, no mic.
 */
export class SpeechIn {
  private live = "";
  private finalWaiter: ((t: string) => void) | null = null;
  private active = false;
  private transport: SttPlan["transport"] | null = null;
  private assembler = new TranscriptAssembler();
  private socket: MainSocket | null = null;
  private pending: Uint8Array[] = [];
  private closeMessage: string | null = null;
  private sseAbort: AbortController | null = null;
  private sseDone: Promise<void> | null = null;
  error: string | null = null;
  /** For the smoke and Settings: whether the last transcript came from the labelled mock. */
  lastMock = false;
  onLive: (text: string) => void = () => undefined;

  constructor(
    private api: ShapesApi,
    private audio: () => BrowserWindow | null,
    private openSocket: MainSocketFactory = defaultSocket,
  ) {}

  get currentTransport(): SttPlan["transport"] | null {
    return this.transport;
  }

  async start(): Promise<boolean> {
    this.live = "";
    this.error = null;
    this.assembler = new TranscriptAssembler();
    this.pending = [];
    const t = await this.api.transcribeToken();
    const plan = sttPlan(t);
    if (!plan) {
      this.error = "Speech-to-text isn't configured on this server.";
      return false;
    }
    this.lastMock = t.provider === "mock";
    this.closeMessage = sttCloseMessage(t.provider);
    this.transport = plan.transport;

    if (plan.transport === "main-sse") {
      this.active = true;
      const ctl = new AbortController();
      this.sseAbort = ctl;
      this.sseDone = (async () => {
        try {
          for await (const m of this.api.sseAt(plan.url, ctl.signal)) {
            if (this.assembler.feed(m.data)) this.update(this.assembler.live);
            if (this.assembler.terminated) break;
          }
        } catch (e) {
          if (!ctl.signal.aborted) this.error = e instanceof Error ? e.message : String(e);
        }
      })();
      return true;
    }

    const w = this.audio();
    if (!w || w.isDestroyed()) {
      this.error = "Audio isn't ready yet.";
      return false;
    }
    this.active = true;
    if (plan.transport === "main-ws") {
      const sock = this.openSocket(plan.url, plan.headers);
      sock.binaryType = "arraybuffer";
      this.socket = sock;
      sock.onopen = () => {
        for (const c of this.pending.splice(0)) sock.send(c);
      };
      sock.onmessage = (e) => {
        if (typeof e.data !== "string") return;
        if (this.assembler.feed(e.data)) this.update(this.assembler.live);
        if (this.assembler.terminated) this.final(this.assembler.final, null);
      };
      sock.onerror = () => this.final(this.assembler.final, "The speech service connection failed.");
      sock.onclose = () => this.final(this.assembler.final, this.assembler.error);
      w.webContents.send("audio:stt-start", { mode: "relay", provider: t.provider, sampleRate: t.sampleRate } satisfies SttStart);
      return true;
    }
    w.webContents.send("audio:stt-start", {
      mode: "socket",
      url: plan.url,
      protocols: plan.protocols,
      provider: t.provider,
      sampleRate: t.sampleRate,
      closeMessage: this.closeMessage,
    } satisfies SttStart);
    return true;
  }

  /** PCM from the audio window (main-ws transport only). */
  pcm(bytes: Uint8Array): void {
    if (!this.active || this.transport !== "main-ws" || !this.socket) return;
    if (this.socket.readyState === 1) this.socket.send(bytes);
    else if (this.socket.readyState === 0 && this.pending.length < 100) this.pending.push(bytes);
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
    const transport = this.transport;
    if (transport === "main-sse") {
      const done = this.sseDone ?? Promise.resolve();
      await Promise.race([done, new Promise((r) => setTimeout(r, graceMs))]);
      this.sseAbort?.abort();
      this.sseAbort = null;
      this.sseDone = null;
      return this.assembler.final || this.live.trim();
    }
    const w = this.audio();
    const result = new Promise<string>((r) => (this.finalWaiter = r));
    if (w && !w.isDestroyed()) w.webContents.send("audio:stt-stop");
    const sock = transport === "main-ws" ? this.socket : null;
    if (sock && sock.readyState === 1 && this.closeMessage) sock.send(this.closeMessage);
    const timeout = new Promise<string>((r) => setTimeout(() => r(this.live), graceMs));
    const text = await Promise.race([result, timeout]);
    this.finalWaiter = null;
    if (sock) {
      this.socket = null;
      try {
        sock.close();
      } catch {
        /* already closed */
      }
    }
    return text.trim();
  }

  cancel(): void {
    this.active = false;
    this.finalWaiter = null;
    this.sseAbort?.abort();
    this.sseAbort = null;
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = null;
    const w = this.audio();
    if (w && !w.isDestroyed()) w.webContents.send("audio:stt-stop");
  }
}
