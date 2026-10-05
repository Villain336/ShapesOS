// ShapesOS — Phase 8: what the Runs page shows about a run's sandbox (PURE).
//
// The run timeline keeps sandbox output OFF the step list (a build prints
// thousands of lines); the page shows it as a console under "Code sandbox",
// next to the checkpoints (restorable while the sandbox lives) and the
// preview links for the ports the run exposed.

import { previewPath } from "./preview";

interface EventLike {
  seq: number;
  summary: string;
  payload: unknown;
  createdAt: Date | string;
}

function kindOf(e: { payload: unknown }): string | null {
  const k = (e.payload as { kind?: unknown } | null)?.kind;
  return typeof k === "string" ? k : null;
}

/** Streamed command output (kept off the step list). */
export function isSandboxOutputEvent(e: { payload: unknown }): boolean {
  return kindOf(e) === "sandbox.output";
}

export interface CheckpointView {
  snapshotId: string;
  sandboxId: string | null;
  files: string[];
  createdAt: string;
  seq: number;
}

export interface SandboxRunView {
  checkpoints: CheckpointView[];
  /** The last lines of streamed output, oldest first. */
  output: Array<{ tool: string; stream: "stdout" | "stderr"; text: string }>;
  restoredSnapshotIds: string[];
}

export function sandboxRunView(events: readonly EventLike[], opts: { maxOutputChars?: number } = {}): SandboxRunView {
  const checkpoints: CheckpointView[] = [];
  const restored: string[] = [];
  let output: SandboxRunView["output"] = [];
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const kind = kindOf(e);
    if (kind === "sandbox.checkpoint" && typeof p.snapshotId === "string") {
      checkpoints.push({
        snapshotId: p.snapshotId,
        sandboxId: typeof p.sandboxId === "string" ? p.sandboxId : null,
        files: Array.isArray(p.files) ? p.files.filter((f): f is string => typeof f === "string") : [],
        createdAt: typeof e.createdAt === "string" ? e.createdAt : e.createdAt.toISOString(),
        seq: e.seq,
      });
    } else if (kind === "sandbox.restored" && typeof p.snapshotId === "string") {
      restored.push(p.snapshotId);
    } else if (kind === "sandbox.output" && typeof p.data === "string") {
      output.push({ tool: typeof p.tool === "string" ? p.tool : "bash", stream: p.stream === "stderr" ? "stderr" : "stdout", text: p.data });
    }
  }
  // Keep only the tail of the output.
  const max = opts.maxOutputChars ?? 20_000;
  let total = 0;
  const kept: typeof output = [];
  for (let i = output.length - 1; i >= 0; i--) {
    const o = output[i]!;
    if (total + o.text.length > max) {
      kept.unshift({ ...o, text: o.text.slice(-(max - total)) });
      break;
    }
    kept.unshift(o);
    total += o.text.length;
  }
  output = kept;
  return { checkpoints: checkpoints.reverse(), output, restoredSnapshotIds: restored };
}

/** Preview links for the ports a run exposed. */
export function previewLinks(runId: string, ports: readonly number[]): Array<{ port: number; href: string }> {
  return [...new Set(ports)].sort((a, b) => a - b).map((port) => ({ port, href: previewPath(runId, port) }));
}
