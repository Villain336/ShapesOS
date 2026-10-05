// ShapesOS — Phase 8: path safety inside a sandbox (PURE).
//
// Every path a code tool touches resolves INSIDE the sandbox workdir. The
// model's path is treated as hostile: absolute paths must already sit under
// the workdir, `..` that climbs out is refused, NUL bytes are refused, and
// the result is always a normalized absolute POSIX path. (The sandbox is
// itself isolated from the host — this keeps the agent inside the project
// tree it was given, so a checkpoint covers everything it changed.)

import { posix } from "node:path";

export class SandboxPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPathError";
  }
}

/** Resolve `p` against `workdir`; throws SandboxPathError when it escapes. */
export function resolveSandboxPath(workdir: string, p: string | undefined | null): string {
  const root = posix.normalize(workdir).replace(/\/+$/, "") || "/";
  const raw = (p ?? "").trim();
  if (raw.includes("\0")) throw new SandboxPathError("Path contains a NUL byte.");
  if (raw.length > 4096) throw new SandboxPathError("Path is too long.");
  const abs = posix.normalize(raw === "" || raw === "." ? root : raw.startsWith("/") ? raw : posix.join(root, raw));
  const clean = abs.length > 1 ? abs.replace(/\/+$/, "") : abs;
  if (clean !== root && !clean.startsWith(root + "/")) {
    throw new SandboxPathError(`Path ${raw} is outside the sandbox workdir (${root}).`);
  }
  return clean;
}

/** The path relative to the workdir ("." for the workdir itself). */
export function relativeToWorkdir(workdir: string, abs: string): string {
  const rel = posix.relative(posix.normalize(workdir), abs);
  return rel === "" ? "." : rel;
}

/** Single-quote a string for /bin/sh. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
