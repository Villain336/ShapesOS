// ShapesOS — Phase 18.2 (WS=content): the Terminal app (server only).
//
// A person's shell on a WORKSPACE SANDBOX through the existing sandbox layer
// (lib/sandbox: Docker / E2B / Daytona — same provider, same CPU / memory /
// pids limits, same egress allow-list, same idle timeout). Nothing runs on
// the host: with no provider configured the Terminal says so and runs
// nothing (sandboxAvailability()).
//
// Rules:
//   - editor+ only (the route checks the workspace role; this re-checks)
//   - a terminal session belongs to the person who opened it: nobody else —
//     no admin, no agent — can type into it (agents attaching to a person's
//     terminal is not allowed in this phase). Admins may END any session
//     (Activity Monitor → Stop).
//   - commands a person types are NOT agent actions (no tier prompt) but every
//     one is recorded (terminal_commands: who, what, exit code, duration —
//     never the output) and the session start / end is audited.
//   - each command runs as `sh -lc` in the session's sandbox with a wall-clock
//     limit; output streams back as it arrives (Sandbox.exec onOutput) and is
//     capped. The working directory is carried between commands.
//   - paid sandbox minutes (E2B / Daytona) are refused for a capped workspace
//     and metered when the session ends (sandbox_minute), like agent runs.

import type { WorkspaceRole } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { roleAtLeast } from "@/lib/authz";
import { auditEvent } from "@/lib/auditlog";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError } from "@/lib/api/errors";
import type { Sandbox } from "@/lib/sandbox/types";

export const TERMINAL_COMMAND_MAX = 4_000;
export const TERMINAL_EXEC_TIMEOUT_MS = 120_000;
export const TERMINAL_OUTPUT_MAX_BYTES = 256 * 1024;
const CWD_MARK = "\u001eSHAPES_CWD:";

export interface TerminalActor {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
}

export interface TerminalSessionOut {
  id: string;
  userId: string;
  provider: string;
  status: string;
  startedAt: string;
  lastActiveAt: string;
  endedAt: string | null;
}

function out(r: { id: string; userId: string; provider: string; status: string; startedAt: Date; lastActiveAt: Date; endedAt: Date | null }): TerminalSessionOut {
  return { id: r.id, userId: r.userId, provider: r.provider, status: r.status, startedAt: r.startedAt.toISOString(), lastActiveAt: r.lastActiveAt.toISOString(), endedAt: r.endedAt?.toISOString() ?? null };
}

function requireEditor(actor: TerminalActor): void {
  if (!roleAtLeast(actor.role, "editor")) throw new ForbiddenError("The terminal is for editors and above.");
}

/** PURE: a command a person may send (one line or a short script, no NUL). */
export function checkCommand(command: unknown): string {
  if (typeof command !== "string") throw new BadRequestError("command is text.");
  const c = command.replace(/\r\n?/g, "\n");
  if (!c.trim()) throw new BadRequestError("Type a command.");
  if (c.length > TERMINAL_COMMAND_MAX) throw new BadRequestError(`A command is at most ${TERMINAL_COMMAND_MAX} characters.`);
  if (c.includes("\u0000")) throw new BadRequestError("A command can't contain NUL.");
  return c;
}

/** PURE: a working directory the client says it is in (absolute, plain). */
export function checkCwd(cwd: unknown, fallback: string): string {
  if (typeof cwd !== "string" || !cwd.startsWith("/") || cwd.length > 1024 || /[\u0000-\u001f]/.test(cwd)) return fallback;
  return cwd;
}

/** PURE: the shell line that runs the command in `cwd` and reports where it ended up. */
export function wrapCommand(command: string, cwd: string): string {
  const q = `'${cwd.replace(/'/g, `'\\''`)}'`;
  return `cd ${q} 2>/dev/null || cd ~; ${command}\n__shapes_rc=$?; printf '\\n${CWD_MARK.replace("\u001e", "\\036")}%s\\n' "$(pwd)"; exit $__shapes_rc`;
}

/** PURE: split the cwd marker off the end of stdout. */
export function splitCwd(stdout: string): { text: string; cwd: string | null } {
  const i = stdout.lastIndexOf(CWD_MARK);
  if (i < 0) return { text: stdout, cwd: null };
  const cwd = stdout.slice(i + CWD_MARK.length).split("\n")[0]!.trim();
  return { text: stdout.slice(0, i).replace(/\n$/, ""), cwd: cwd || null };
}

export async function terminalAvailability(): Promise<{ ok: true; provider: string } | { ok: false; reason: string }> {
  const { sandboxAvailability } = await import("@/lib/sandbox");
  const a = await sandboxAvailability();
  return a.ok ? { ok: true, provider: a.provider } : { ok: false, reason: a.reason };
}

export async function getTerminalSession(workspaceId: string, id: string): Promise<TerminalSessionOut | null> {
  const row = await withWorkspaceScope(workspaceId, (tx) => tx.terminalSession.findFirst({ where: { id, workspaceId } }));
  return row ? out(row) : null;
}

async function attach(row: { provider: string; sandboxId: string; secretEnc: string | null }): Promise<Sandbox | null> {
  const { getSandboxProvider } = await import("@/lib/sandbox");
  const { acceptsSecret } = await import("@/lib/sandbox/secrets");
  const p = getSandboxProvider();
  if (!p || p.name !== row.provider) return null;
  try {
    if (acceptsSecret(p)) {
      let secret: string | null = null;
      if (row.secretEnc) {
        const { secrets } = await import("@/lib/secrets");
        secret = secrets().decrypt(row.secretEnc);
      }
      return await p.getWithSecret(row.sandboxId, secret);
    }
    return await p.get(row.sandboxId);
  } catch {
    return null;
  }
}

/**
 * Open (or resume) the person's terminal. One live session per person per
 * workspace: an existing one whose sandbox is still alive is returned.
 */
export async function startTerminalSession(actor: TerminalActor): Promise<{ session: TerminalSessionOut; resumed: boolean }> {
  requireEditor(actor);
  const existing = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.terminalSession.findFirst({ where: { workspaceId: actor.workspaceId, userId: actor.userId, status: "active" }, orderBy: { startedAt: "desc" } }),
  );
  if (existing) {
    if (await attach(existing)) return { session: out(existing), resumed: true };
    await markEnded(actor.workspaceId, existing.id, "the sandbox idled out");
  }
  const avail = await terminalAvailability();
  if (!avail.ok) throw new ServiceUnavailableError(avail.reason);
  const { getSandboxProvider } = await import("@/lib/sandbox");
  const provider = getSandboxProvider();
  if (!provider) throw new ServiceUnavailableError("No sandbox provider is configured.");
  const { isPaidSandboxProvider } = await import("@/lib/sandbox/metering");
  if (isPaidSandboxProvider(provider.name)) {
    const { checkCap } = await import("@/lib/metering/service");
    const cap = await checkCap(actor.workspaceId);
    if (!cap.allowed) throw new ConflictError("This workspace reached its credit cap; a hosted sandbox can't start. Raise the cap in Settings → Usage.");
  }
  const pending = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.terminalSession.create({ data: { workspaceId: actor.workspaceId, userId: actor.userId, provider: provider.name, sandboxId: "starting", status: "active" } }),
  );
  let sb: Sandbox;
  try {
    // The sandbox's owner label is the terminal session (it is not an agent run).
    sb = await provider.create({ workspaceId: actor.workspaceId, runId: `terminal-${pending.id}` });
  } catch (err) {
    await withWorkspaceScope(actor.workspaceId, (tx) =>
      tx.terminalSession.update({ where: { id: pending.id, workspaceId: actor.workspaceId }, data: { status: "ended", endedAt: new Date(), endedReason: "the sandbox could not start" } }),
    );
    throw new ServiceUnavailableError(`The sandbox could not start: ${err instanceof Error ? err.message : String(err)}`);
  }
  let secretEnc: string | null = null;
  const { carriesSecret } = await import("@/lib/sandbox/secrets");
  if (carriesSecret(sb)) {
    const plain = sb.persistSecret();
    if (plain) {
      const { secrets } = await import("@/lib/secrets");
      secretEnc = secrets().encrypt(plain);
    }
  }
  const row = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.terminalSession.update({ where: { id: pending.id, workspaceId: actor.workspaceId }, data: { sandboxId: sb.id, secretEnc } }),
  );
  await auditEvent({
    workspaceId: actor.workspaceId,
    projectId: null,
    action: "terminal_session_started",
    summary: `Terminal opened on a ${provider.name} sandbox`,
    actorUserId: actor.userId,
  }).catch(() => undefined);
  return { session: out(row), resumed: false };
}

export interface CommandChunk {
  stream: "stdout" | "stderr";
  data: string;
}

export interface CommandResult {
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  cwd: string;
}

/**
 * Run one command in the person's own session, streaming output to onOutput.
 * Recorded in terminal_commands (the command, exit code and duration).
 */
export async function runTerminalCommand(
  actor: TerminalActor,
  sessionId: string,
  input: { command: unknown; cwd?: unknown },
  onOutput: (c: CommandChunk) => void,
  signal?: AbortSignal,
): Promise<CommandResult> {
  requireEditor(actor);
  const command = checkCommand(input.command);
  const row = await withWorkspaceScope(actor.workspaceId, (tx) => tx.terminalSession.findFirst({ where: { id: sessionId, workspaceId: actor.workspaceId } }));
  if (!row) throw new NotFoundError("Terminal session not found.");
  if (row.userId !== actor.userId) throw new ForbiddenError("This terminal belongs to someone else.");
  if (row.status !== "active") throw new ConflictError("This terminal session has ended. Open a new one.");
  const sb = await attach(row);
  if (!sb) {
    await markEnded(actor.workspaceId, row.id, "the sandbox idled out");
    throw new ConflictError("The sandbox behind this terminal has stopped (idle timeout). Open a new one.");
  }
  const cwd = checkCwd(input.cwd, sb.workdir);
  const cmdRow = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.terminalCommand.create({ data: { workspaceId: actor.workspaceId, sessionId: row.id, userId: actor.userId, command: command.slice(0, TERMINAL_COMMAND_MAX) } }),
  );
  // Hold back the cwd marker: it may arrive split across chunks.
  let pendingOut = "";
  const res = await sb.exec(wrapCommand(command, cwd), {
    timeoutMs: TERMINAL_EXEC_TIMEOUT_MS,
    maxOutputBytes: TERMINAL_OUTPUT_MAX_BYTES,
    signal,
    onOutput: (chunk) => {
      if (chunk.stream === "stderr") {
        onOutput(chunk);
        return;
      }
      pendingOut += chunk.data;
      const i = pendingOut.indexOf("\u001e");
      const safe = i >= 0 ? i : Math.max(0, pendingOut.length - 1);
      if (safe > 0) {
        onOutput({ stream: "stdout", data: pendingOut.slice(0, safe) });
        pendingOut = pendingOut.slice(safe);
      }
    },
  });
  const split = splitCwd(pendingOut || res.stdout.slice(res.stdout.lastIndexOf("\u001e") >= 0 ? res.stdout.lastIndexOf("\u001e") : res.stdout.length));
  if (split.text) onOutput({ stream: "stdout", data: split.text });
  const newCwd = split.cwd ?? splitCwd(res.stdout).cwd ?? cwd;
  await withWorkspaceScope(actor.workspaceId, async (tx) => {
    await tx.terminalCommand.update({ where: { id: cmdRow.id, workspaceId: actor.workspaceId }, data: { exitCode: res.exitCode, timedOut: res.timedOut, durationMs: res.durationMs } });
    await tx.terminalSession.update({ where: { id: row.id, workspaceId: actor.workspaceId }, data: { lastActiveAt: new Date() } });
  });
  return { exitCode: res.exitCode, timedOut: res.timedOut, truncated: res.truncated, durationMs: res.durationMs, cwd: newCwd };
}

async function markEnded(workspaceId: string, id: string, reason: string): Promise<{ provider: string; startedAt: Date; lastActiveAt: Date } | null> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const res = await tx.terminalSession.updateMany({ where: { id, workspaceId, status: "active" }, data: { status: "ended", endedAt: new Date(), endedReason: reason.slice(0, 200) } });
    if (res.count === 0) return null;
    return tx.terminalSession.findFirst({ where: { id, workspaceId }, select: { provider: true, startedAt: true, lastActiveAt: true } });
  });
}

/** End a session: destroy its sandbox, record it, meter paid minutes. Idempotent. */
export async function endTerminalSession(workspaceId: string, id: string, byUserId: string, reason = "closed"): Promise<boolean> {
  const row = await withWorkspaceScope(workspaceId, (tx) => tx.terminalSession.findFirst({ where: { id, workspaceId } }));
  if (!row) throw new NotFoundError("Terminal session not found.");
  if (row.status !== "active") return false;
  const sb = await attach(row);
  if (sb) await sb.destroy().catch(() => undefined);
  const ended = await markEnded(workspaceId, id, reason);
  if (!ended) return false;
  const { meterSandboxLifetime } = await import("@/lib/sandbox/metering");
  const { sandboxConfig } = await import("@/lib/sandbox/config");
  await meterSandboxLifetime({
    id: row.id,
    workspaceId,
    runId: `terminal-${row.id}`,
    provider: ended.provider,
    createdAt: ended.startedAt,
    lastUsedAt: ended.lastActiveAt,
    endedAt: new Date(),
    idleSeconds: sandboxConfig().idleSeconds,
  });
  await auditEvent({ workspaceId, projectId: null, action: "terminal_session_ended", summary: `Terminal closed (${reason})`, actorUserId: byUserId }).catch(() => undefined);
  return true;
}

/** The person's own end (only their session). */
export async function closeOwnTerminal(actor: TerminalActor, id: string): Promise<boolean> {
  const row = await getTerminalSession(actor.workspaceId, id);
  if (!row) throw new NotFoundError("Terminal session not found.");
  if (row.userId !== actor.userId && !roleAtLeast(actor.role, "admin")) throw new ForbiddenError("This terminal belongs to someone else.");
  return endTerminalSession(actor.workspaceId, id, actor.userId, "closed");
}

/** The person's recent commands in a session (their history; never others'). */
export async function terminalHistory(actor: TerminalActor, sessionId: string, limit = 50): Promise<Array<{ command: string; exitCode: number | null; createdAt: string }>> {
  const rows = await withWorkspaceScope(actor.workspaceId, (tx) =>
    tx.terminalCommand.findMany({ where: { workspaceId: actor.workspaceId, sessionId, userId: actor.userId }, orderBy: { createdAt: "desc" }, take: Math.min(Math.max(limit, 1), 200), select: { command: true, exitCode: true, createdAt: true } }),
  );
  return rows.reverse().map((r) => ({ command: r.command, exitCode: r.exitCode, createdAt: r.createdAt.toISOString() }));
}
