// ShapesOS Desktop: the hidden audio window.
//
// Voice in: microphone (only while the talk key is held) → 16 kHz mono PCM
// s16le → the STT WebSocket ShapesOS minted a short-lived token for. Partial
// and final transcripts go back to the main process.
// Voice out: TTS bytes streamed from the main process (POST /api/cursor/tts)
// are played through MediaSource as they arrive; "stop" cuts playback at once.

import { floatToPcm16, resample, TranscriptAssembler } from "../shared/stt";
import type { SttStart } from "../shared/ipc";
import { desktop } from "./bridge";

// ---------- voice in ---------------------------------------------------------

let ws: WebSocket | null = null;
let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let node: AudioWorkletNode | null = null;
let assembler = new TranscriptAssembler();
let closeMsg: string | null = null;
let finalSent = false;
let pending: Uint8Array[] = [];
/** Relay mode: the main process holds the provider socket; we only send PCM. */
let relay = false;

function sendFinal(error: string | null = null): void {
  if (finalSent) return;
  finalSent = true;
  desktop.send("audio:stt-final", { text: assembler.final, error: error ?? assembler.error });
}

async function sttStart(s: SttStart): Promise<void> {
  await sttTeardown();
  assembler = new TranscriptAssembler();
  finalSent = false;
  relay = s.mode === "relay";
  closeMsg = s.mode === "socket" ? s.closeMessage : null;
  pending = [];
  try {
    if (s.mode === "socket") {
      const sock = s.protocols.length ? new WebSocket(s.url, s.protocols) : new WebSocket(s.url);
      ws = sock;
      sock.binaryType = "arraybuffer";
      sock.onopen = () => {
        for (const chunk of pending) sock.send(chunk);
        pending = [];
      };
      sock.onmessage = (e) => {
        if (typeof e.data !== "string") return;
        if (assembler.feed(e.data)) desktop.send("audio:stt-update", { text: assembler.live });
        if (assembler.terminated) sendFinal();
      };
      sock.onerror = () => sendFinal("The speech service connection failed.");
      sock.onclose = () => sendFinal();
    }

    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    ctx = new AudioContext({ sampleRate: s.sampleRate });
    await ctx.audioWorklet.addModule("pcm-worklet.js");
    const source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, "pcm-capture");
    const rate = ctx.sampleRate;
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const pcm = floatToPcm16(resample(e.data, rate, s.sampleRate));
      if (relay) desktop.send("audio:pcm", pcm);
      else if (ws?.readyState === WebSocket.OPEN) ws.send(pcm);
      else if (ws?.readyState === WebSocket.CONNECTING && pending.length < 100) pending.push(pcm);
    };
    source.connect(node);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    sendFinal(/Permission|NotAllowed/i.test(msg) ? "Microphone access is off. Turn it on in Settings." : `Couldn't start the microphone: ${msg}`);
    await sttTeardown();
  }
}

async function sttTeardown(): Promise<void> {
  node?.port.close();
  node?.disconnect();
  node = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (ctx) await ctx.close().catch(() => undefined);
  ctx = null;
}

async function sttStop(): Promise<void> {
  // Mic off at once (the key is up); give the provider a moment to flush.
  await sttTeardown();
  if (relay) {
    // The main process owns the socket and the final transcript.
    relay = false;
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (closeMsg) ws.send(closeMsg);
    const sock = ws;
    setTimeout(() => {
      sendFinal();
      sock.close();
    }, 1200);
  } else {
    ws?.close();
    sendFinal();
  }
  ws = null;
}

// ---------- voice out --------------------------------------------------------

const audio = new Audio();
audio.autoplay = true;
let ms: MediaSource | null = null;
let sb: SourceBuffer | null = null;
let queue: Uint8Array[] = [];
let ended = false;
let currentId = 0;
let url: string | null = null;
let parts: Uint8Array[] = [];

function pump(): void {
  if (!sb || sb.updating) return;
  const next = queue.shift();
  if (next) {
    sb.appendBuffer(next as unknown as BufferSource);
    return;
  }
  if (ended && ms && ms.readyState === "open") ms.endOfStream();
}

function ttsReset(): void {
  audio.pause();
  if (url) URL.revokeObjectURL(url);
  url = null;
  ms = null;
  sb = null;
  queue = [];
  parts = [];
  ended = false;
}

function ttsBegin(id: number): void {
  ttsReset();
  currentId = id;
  if (!("MediaSource" in window) || !MediaSource.isTypeSupported("audio/mpeg")) return;
  ms = new MediaSource();
  url = URL.createObjectURL(ms);
  audio.src = url;
  ms.addEventListener("sourceopen", () => {
    if (!ms) return;
    sb = ms.addSourceBuffer("audio/mpeg");
    sb.addEventListener("updateend", pump);
    pump();
  });
  void audio.play().catch(() => undefined);
}

audio.addEventListener("ended", () => desktop.send("audio:tts-done", { id: currentId }));
audio.addEventListener("error", () => desktop.send("audio:tts-done", { id: currentId }));

desktop.on("audio:stt-start", (p) => void sttStart(p as SttStart));
desktop.on("audio:stt-stop", () => void sttStop());
desktop.on("audio:tts-begin", (p) => ttsBegin((p as { id: number }).id));
desktop.on("audio:tts-chunk", (p) => {
  const { id, bytes } = p as { id: number; bytes: Uint8Array };
  if (id !== currentId) return;
  if (ms) {
    queue.push(bytes);
    pump();
  } else {
    parts.push(bytes);
  }
});
desktop.on("audio:tts-end", (p) => {
  if ((p as { id: number }).id !== currentId) return;
  ended = true;
  pump();
  // No MediaSource for MP3 here: play the whole clip once it has arrived.
  if (!ms) {
    if (!parts.length) {
      desktop.send("audio:tts-done", { id: currentId });
      return;
    }
    url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: "audio/mpeg" }));
    parts = [];
    audio.src = url;
    void audio.play().catch(() => desktop.send("audio:tts-done", { id: currentId }));
  }
});
desktop.on("audio:tts-stop", () => {
  ttsReset();
  desktop.send("audio:tts-done", { id: currentId });
});

desktop.send("audio:ready");
