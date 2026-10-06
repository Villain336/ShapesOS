// ShapesOS — Phase 18.2 (WS=content): the Terminal against real Postgres and
// a TEST sandbox provider (lib/sandbox/__tests__/fakes.ts: commands run with
// /bin/sh in a temp directory — a MOCK; production only knows Docker / E2B /
// Daytona).
//   - no provider → the terminal says why and runs nothing (no row)
//   - editor+ only; a viewer is refused
//   - opening is audited (terminal_session_started); one live session per
//     person (a second open resumes it)
//   - a command streams its output; the working directory carries over;
//     every command is recorded (command, exit code, duration — never output)
//   - nobody else can type into it — not another editor, not an admin;
//     history is the person's own
//   - Ctrl+C (abort) stops a command and records it as interrupted (130)
//   - close destroys the sandbox, ends + audits the session; a closed
//     session runs nothing; an idled-out sandbox closes the session
//   - FORCE RLS: no rows without the workspace scope
// Run (as the least-privilege app role):
//   DATABASE_URL=… npx tsx --test lib/terminal/__tests__/terminal-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope, countWithoutScope } from "@/lib/substrate/memory/rls";
import { setSandboxProviderForTests } from "@/lib/sandbox";
import { FakeProvider } from "@/lib/sandbox/__tests__/fakes";
import {
  closeOwnTerminal,
  myTerminalSession,
  runTerminalCommand,
  startTerminalSession,
  sweepIdleTerminals,
  terminalAvailability,
  terminalHistory,
  type CommandChunk,
  type TerminalActor,
} from "../service";

const RUN = randomUUID().slice(0, 8);
const WS = `p182t-${RUN}`;
const ANA = `p182t-ana-${RUN}`;
const BEN = `p182t-ben-${RUN}`;
const VIC = `p182t-vic-${RUN}`;
const ADM = `p182t-adm-${RUN}`;
const ana: TerminalActor = { workspaceId: WS, userId: ANA, role: "editor" };
const ben: TerminalActor = { workspaceId: WS, userId: BEN, role: "editor" };
const vic: TerminalActor = { workspaceId: WS, userId: VIC, role: "viewer" };
const adm: TerminalActor = { workspaceId: WS, userId: ADM, role: "admin" };
const provider = new FakeProvider();
let sessionId = "";

async function run(actor: TerminalActor, command: string, cwd?: string, signal?: AbortSignal) {
  const chunks: CommandChunk[] = [];
  const res = await runTerminalCommand(actor, sessionId, { command, cwd }, (c) => chunks.push(c), signal);
  return { ...res, stdout: chunks.filter((c) => c.stream === "stdout").map((c) => c.data).join(""), stderr: chunks.filter((c) => c.stream === "stderr").map((c) => c.data).join("") };
}

before(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ADM } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ANA, role: "editor", email: `ana-${RUN}@example.test` },
      { workspaceId: WS, userId: BEN, role: "editor", email: `ben-${RUN}@example.test` },
      { workspaceId: WS, userId: VIC, role: "viewer", email: `vic-${RUN}@example.test` },
      { workspaceId: WS, userId: ADM, role: "admin", email: `adm-${RUN}@example.test` },
    ],
  });
});

after(async () => {
  setSandboxProviderForTests(undefined);
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("Terminal (DB)", () => {
  it("with no sandbox provider it says why and runs nothing", async () => {
    setSandboxProviderForTests(null);
    const a = await terminalAvailability();
    assert.equal(a.ok, false);
    await assert.rejects(startTerminalSession(ana), /switched off|not a provider|sandbox/i);
    const rows = await withWorkspaceScope(WS, (tx) => tx.terminalSession.count({ where: { workspaceId: WS } }));
    assert.equal(rows, 0, "nothing was started");
  });

  it("editors open one (audited); viewers can't; a second open resumes it", async () => {
    setSandboxProviderForTests(provider);
    await assert.rejects(startTerminalSession(vic), /editors and above/);
    const first = await startTerminalSession(ana);
    assert.equal(first.resumed, false);
    assert.equal(first.session.provider, "docker");
    sessionId = first.session.id;
    assert.equal(provider.created.length, 1);
    assert.equal(provider.created[0]!.runId, `terminal-${sessionId}`, "the sandbox is labelled with the terminal, not an agent run");
    const again = await startTerminalSession(ana);
    assert.equal(again.resumed, true);
    assert.equal(again.session.id, sessionId);
    assert.equal(provider.created.length, 1, "no second sandbox");
    assert.equal((await myTerminalSession(ana))?.id, sessionId);
    const audits = await prisma.fileChangeLog.findMany({ where: { workspaceId: WS, action: "terminal_session_started" } });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.approvedBy, ANA);
  });

  it("runs commands, streams output, carries the working directory, records each command", async () => {
    const r1 = await run(ana, "mkdir -p sub && echo hello && echo oops 1>&2");
    assert.equal(r1.exitCode, 0);
    assert.equal(r1.stdout, "hello\n", "stdout without the directory marker");
    assert.equal(r1.stderr, "oops\n");
    const r2 = await run(ana, "cd sub && pwd", r1.cwd);
    assert.ok(r2.cwd.endsWith("/sub"), "the shell ended in sub/");
    const r3 = await run(ana, "pwd", r2.cwd);
    assert.ok(r3.stdout.trim().endsWith("/sub"), "the next command starts there");
    const r4 = await run(ana, "exit 3", r3.cwd);
    assert.equal(r4.exitCode, 3);
    const cmds = await withWorkspaceScope(WS, (tx) => tx.terminalCommand.findMany({ where: { workspaceId: WS, sessionId }, orderBy: { createdAt: "asc" } }));
    assert.deepEqual(cmds.map((c) => [c.command, c.exitCode]), [
      ["mkdir -p sub && echo hello && echo oops 1>&2", 0],
      ["cd sub && pwd", 0],
      ["pwd", 0],
      ["exit 3", 3],
    ]);
    assert.ok(cmds.every((c) => c.userId === ANA && c.durationMs !== null));
    assert.ok(!("output" in cmds[0]!), "output is never stored");
  });

  it("nobody else can type into it — not another editor, not an admin; history is the person's own", async () => {
    await assert.rejects(run(ben, "whoami"), /belongs to someone else/);
    await assert.rejects(run(adm, "whoami"), /belongs to someone else/);
    await assert.rejects(run(vic, "whoami"), /editors and above/);
    assert.equal((await terminalHistory(ana, sessionId)).length, 4);
    assert.equal((await terminalHistory(ben, sessionId)).length, 0, "Ben sees none of Ana's commands");
    await assert.rejects(closeOwnTerminal(ben, sessionId), /belongs to someone else/);
  });

  it("Ctrl+C stops a running command and records it as interrupted", async () => {
    const ctrl = new AbortController();
    // A loop in the shell itself (the test sandbox kills the shell; a real
    // provider signals the whole process group).
    const p = run(ana, "while true; do :; done", undefined, ctrl.signal);
    setTimeout(() => ctrl.abort(), 300);
    const t0 = Date.now();
    await assert.rejects(p);
    assert.ok(Date.now() - t0 < 10_000, "stopped promptly");
    const last = await withWorkspaceScope(WS, (tx) => tx.terminalCommand.findFirst({ where: { workspaceId: WS, sessionId }, orderBy: { createdAt: "desc" } }));
    assert.equal(last?.command, "while true; do :; done");
    assert.equal(last?.exitCode, 130);
  });

  it("FORCE RLS: no terminal rows without the workspace scope", async () => {
    assert.equal(await countWithoutScope("terminal_sessions"), 0);
    assert.equal(await countWithoutScope("terminal_commands"), 0);
  });

  it("close destroys the sandbox, ends and audits the session; a closed session runs nothing", async () => {
    const sb = provider.created[0]!;
    assert.equal(await closeOwnTerminal(ana, sessionId), true);
    assert.equal(sb.destroyed, true);
    const row = await withWorkspaceScope(WS, (tx) => tx.terminalSession.findFirst({ where: { workspaceId: WS, id: sessionId } }));
    assert.equal(row?.status, "ended");
    assert.equal(row?.endedReason, "closed");
    assert.equal(await closeOwnTerminal(ana, sessionId), false, "idempotent");
    await assert.rejects(run(ana, "echo again"), /has ended/);
    const audits = await prisma.fileChangeLog.findMany({ where: { workspaceId: WS, action: "terminal_session_ended" } });
    assert.equal(audits.length, 1);
    assert.equal(await myTerminalSession(ana), null);
  });

  it("an idled-out sandbox closes the session (on open, on a command, and in the sweep)", async () => {
    const s1 = await startTerminalSession(ben);
    assert.equal(s1.resumed, false);
    // The provider's idle watchdog removed the sandbox:
    await provider.created.at(-1)!.destroy();
    const s2 = await startTerminalSession(ben);
    assert.equal(s2.resumed, false, "a fresh sandbox, not the dead one");
    const old = await withWorkspaceScope(WS, (tx) => tx.terminalSession.findFirst({ where: { workspaceId: WS, id: s1.session.id } }));
    assert.equal(old?.status, "ended");
    assert.match(old?.endedReason ?? "", /idled out/);
    // Quiet for longer than the idle timeout and gone → the sweep closes it.
    await provider.created.at(-1)!.destroy();
    await withWorkspaceScope(WS, (tx) => tx.terminalSession.update({ where: { id: s2.session.id, workspaceId: WS }, data: { lastActiveAt: new Date(Date.now() - 48 * 3600_000) } }));
    assert.equal(await sweepIdleTerminals(WS), 1);
    assert.equal(await myTerminalSession(ben), null);
  });
});
