// ShapesOS — Phase 8: capped, streamed command output (shared by providers).
//
// Collects stdout / stderr up to maxOutputBytes each (UTF-8 safe across
// chunk boundaries), forwards every decoded chunk to onOutput while under the
// cap, and records whether anything was cut.

import { StringDecoder } from "node:string_decoder";
import type { SandboxExecOptions, SandboxExecResult } from "./types";

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

type Stream = "stdout" | "stderr";

export class OutputCollector {
  private readonly max: number;
  private readonly onOutput?: SandboxExecOptions["onOutput"];
  private readonly parts: Record<Stream, string[]> = { stdout: [], stderr: [] };
  private readonly bytes: Record<Stream, number> = { stdout: 0, stderr: 0 };
  private readonly decoders: Record<Stream, StringDecoder> = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  truncated = false;

  constructor(opts: Pick<SandboxExecOptions, "maxOutputBytes" | "onOutput"> = {}) {
    this.max = opts.maxOutputBytes && opts.maxOutputBytes > 0 ? opts.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES;
    this.onOutput = opts.onOutput;
  }

  push(stream: Stream, chunk: Buffer | string): void {
    let buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const room = this.max - this.bytes[stream];
    if (room <= 0) {
      if (buf.length) this.truncated = true;
      return;
    }
    if (buf.length > room) {
      buf = buf.subarray(0, room);
      this.truncated = true;
    }
    this.bytes[stream] += buf.length;
    const text = this.decoders[stream].write(buf);
    if (!text) return;
    this.parts[stream].push(text);
    try {
      this.onOutput?.({ stream, data: text });
    } catch {
      // A broken listener never breaks the command.
    }
  }

  result(exitCode: number, timedOut: boolean, startedAt: number): SandboxExecResult {
    for (const s of ["stdout", "stderr"] as const) {
      const tail = this.decoders[s].end();
      if (tail) this.parts[s].push(tail);
    }
    return {
      exitCode,
      stdout: this.parts.stdout.join(""),
      stderr: this.parts.stderr.join(""),
      timedOut,
      truncated: this.truncated,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Docker's multiplexed attach/exec stream (Tty=false): frames of
 * [stream(1)=1 stdout|2 stderr, 0,0,0, size(uint32 BE)] + payload. Feeds
 * partial chunks; calls `emit` per complete (or partial) payload slice.
 */
export class DockerDemuxer {
  private header = Buffer.alloc(0);
  private remaining = 0;
  private stream: Stream = "stdout";

  constructor(private readonly emit: (stream: Stream, data: Buffer) => void) {}

  write(chunk: Buffer): void {
    let off = 0;
    while (off < chunk.length) {
      if (this.remaining === 0) {
        const need = 8 - this.header.length;
        const take = chunk.subarray(off, off + need);
        this.header = Buffer.concat([this.header, take]);
        off += take.length;
        if (this.header.length < 8) return;
        const kind = this.header[0];
        this.stream = kind === 2 ? "stderr" : "stdout";
        this.remaining = this.header.readUInt32BE(4);
        this.header = Buffer.alloc(0);
        continue;
      }
      const take = chunk.subarray(off, off + this.remaining);
      off += take.length;
      this.remaining -= take.length;
      if (take.length) this.emit(this.stream, take);
    }
  }
}

/** Frame a payload the way Docker does (used by the fake engine in tests). */
export function dockerFrame(stream: Stream, data: Buffer | string): Buffer {
  const body = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const h = Buffer.alloc(8);
  h[0] = stream === "stderr" ? 2 : 1;
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}
