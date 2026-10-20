// AudioWorklet: batches microphone frames (~100 ms) and posts them to the
// audio window, which converts them to PCM s16le for the STT socket.

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;
declare const sampleRate: number;

class PcmCapture extends AudioWorkletProcessor {
  private buf: Float32Array = new Float32Array(Math.round(sampleRate / 10));
  private n = 0;

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i] ?? 0;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf);
        this.buf = new Float32Array(this.buf.length);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
