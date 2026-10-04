// ShapesOS — Phase 8: the code tools through the real tool layer, on a
// LocalDirSandbox TEST DOUBLE (fakes.ts — a temp dir on the test machine,
// standing in for a provider; production never uses it). Also: the tool
// group / automation-action entries, the safety tiers, and "code" becoming
// available exactly when a sandbox provider is.
// Run: npx tsx --test lib/sandbox/__tests__/code-tools.test.ts

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { allTools, getTool, TOOL_ACTION, TOOL_GROUP, toolCatalogForPrompt, toolGranted, type ToolContext } from "@/lib/chat/tools";
import { isToolGroup, unavailableGroups, computeGrant } from "@/lib/agents/grants";
import { evaluateTier } from "@/lib/orchestrator/authority";
import { decideAutoApproval, KNOWN_ACTIONS } from "@/lib/automation/policy";
import { CODE_TOOLS, CODE_TOOL_NAMES, registerCodeTools, setCodeToolEventsForTests, setCodeToolSandboxForTests, OutputStreamer, forgetCheckpoints, CHECKPOINT_MIN_INTERVAL_MS } from "../tools";
import { sandboxAvailability, setSandboxProviderForTests, SandboxUnavailableError } from "../index";
import { toolGroupAvailability } from "../availability";
import { FakeProvider, LocalDirSandbox } from "./fakes";

let sb: LocalDirSandbox;
const notes: Array<{ summary: string; payload: Record<string, unknown> }> = [];
let runN = 0;

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { projectId: "p", workspaceId: "ws", userId: "u", role: "editor", confirmed: true, runId: `run-${runN}`, ...over };
}

async function call(name: string, args: Record<string, unknown>, c = ctx()) {
  const t = getTool(name);
  assert.ok(t, `${name} is registered`);
  return t!.execute(c, args);
}

before(() => {
  registerCodeTools();
  setCodeToolEventsForTests((summary, payload) => notes.push({ summary, payload }));
});
after(() => {
  setCodeToolSandboxForTests(null);
  setCodeToolEventsForTests(null);
  setSandboxProviderForTests(undefined);
});
beforeEach(() => {
  runN++;
  sb = new LocalDirSandbox(`run-${runN}`);
  setCodeToolSandboxForTests(async () => sb);
  notes.length = 0;
});

describe("tool groups, actions and tiers", () => {
  it("every code tool is registered in group `code` with an action for every write", () => {
    registerCodeTools();
    for (const name of CODE_TOOL_NAMES) {
      assert.equal(TOOL_GROUP[name], "code", name);
      assert.ok(isToolGroup(TOOL_GROUP[name]));
      assert.ok(allTools().some((t) => t.name === name), `${name} in allTools()`);
    }
    for (const t of CODE_TOOLS.filter((t) => t.kind !== "safe")) assert.ok(TOOL_ACTION[t.name], `${t.name} names its action`);
    assert.deepEqual(
      CODE_TOOLS.map((t) => [t.name, t.kind]),
      [
        ["read_file", "safe"],
        ["glob", "safe"],
        ["grep", "safe"],
        ["write_file", "spend"],
        ["edit_file", "spend"],
        ["bash", "spend"],
        ["run_tests", "spend"],
      ],
    );
    assert.equal(TOOL_ACTION.write_file, "edit_sandbox_files");
    assert.equal(TOOL_ACTION.edit_file, "edit_sandbox_files");
    assert.equal(TOOL_ACTION.bash, "run_sandbox_command");
    assert.equal(TOOL_ACTION.run_tests, "run_sandbox_command");
    for (const a of ["edit_sandbox_files", "run_sandbox_command"]) assert.ok(KNOWN_ACTIONS.some((k) => k.action === a), `${a} in the automation catalog`);
  });

  it("sandbox edits are Tier 0 (a per-agent auto rule applies); commands always ask", () => {
    const settings = { smallActionThresholdCents: 10_000, automationAllows: true };
    assert.equal(evaluateTier({ kind: "edit_sandbox_files" }, settings), 0);
    assert.equal(evaluateTier({ kind: "run_sandbox_command" }, settings), 2);
    // "edit" alone is NOT a Tier-0 verb — only the exact sandbox kind is.
    assert.equal(evaluateTier({ kind: "edit_published_page" }, settings), 2);
    const rule = [{ agentKey: "actor", action: "edit_sandbox_files", behavior: "auto" as const }];
    for (const name of ["write_file", "edit_file"]) {
      const t = getTool(name)!;
      const d = decideAutoApproval(rule as never, { agentKey: "actor", action: TOOL_ACTION[name]!, description: `${t.name}: ${t.description}` });
      assert.equal(d.auto, true, `${name}: ${d.reason}`);
    }
    const bashRule = [{ agentKey: "actor", action: "run_sandbox_command", behavior: "auto" as const }];
    const b = getTool("bash")!;
    assert.equal(decideAutoApproval(bashRule as never, { agentKey: "actor", action: "run_sandbox_command", description: `bash: ${b.description}` }).auto, false);
  });

  it("the grant gates the code tools like any other group", () => {
    assert.equal(toolGranted("bash", ["workspace", "web"]), false);
    assert.equal(toolGranted("bash", ["workspace", "code"]), true);
    assert.doesNotMatch(toolCatalogForPrompt(["workspace"]), /- read_file \[/);
    assert.match(toolCatalogForPrompt(["workspace", "code"]), /- edit_file \[spend/);
    assert.deepEqual(computeGrant({ agentKey: "actor", requested: ["code"] }).groups, ["workspace", "code"]);
  });
});

describe("availability: code is available exactly when a provider is", () => {
  it("unavailableGroups is pure and fails closed", () => {
    assert.ok(unavailableGroups().has("code"));
    assert.equal(unavailableGroups({ code: { ok: false, reason: "down" } }).get("code"), "down");
    assert.equal(unavailableGroups({ code: { ok: true } }).size, 0);
  });

  it("toolGroupAvailability follows the provider", async () => {
    const p = new FakeProvider();
    setSandboxProviderForTests(p);
    assert.deepEqual((await toolGroupAvailability()).code, { ok: true });
    p.ok = false;
    assert.deepEqual((await sandboxAvailability({ fresh: true })), { ok: false, provider: "docker", reason: "fake provider is down" });
    setSandboxProviderForTests(null);
    const none = await toolGroupAvailability();
    assert.equal(none.code?.ok, false);
    assert.equal(none.codeProvider, null);
  });

  it("without a provider the tools say why and do nothing", async () => {
    setCodeToolSandboxForTests(async () => {
      throw new SandboxUnavailableError("No Docker socket at /var/run/docker.sock.");
    });
    const r = await call("bash", { command: "echo hi" });
    assert.match(r.summary, /not available: No Docker socket/);
    assert.deepEqual(r.details, { unavailable: true, reason: "No Docker socket at /var/run/docker.sock." });
  });
});

describe("the tools on a sandbox", () => {
  it("write_file → read_file with line ranges; traversal refused", async () => {
    const w = await call("write_file", { path: "src/app.ts", content: "a\nb\nc\nd\n" });
    assert.match(w.summary, /Wrote src\/app\.ts \(8 bytes\)/);
    assert.equal(readFileSync(join(sb.workdir, "src/app.ts"), "utf8"), "a\nb\nc\nd\n");
    const r = await call("read_file", { path: "src/app.ts", offset: 2, limit: 2 });
    assert.match(r.summary, /lines 2–3 of 4/);
    assert.match(r.summary, /2\tb\n3\tc$/);
    const bad = await call("read_file", { path: "../../etc/passwd" });
    assert.match(bad.summary, /outside the sandbox workdir/);
    const bad2 = await call("write_file", { path: "/etc/x", content: "x" });
    assert.match(bad2.summary, /outside the sandbox workdir/);
  });

  it("read_file refuses binaries and oversize files", async () => {
    writeFileSync(join(sb.workdir, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    assert.match((await call("read_file", { path: "bin.dat" })).summary, /binary file/);
    writeFileSync(join(sb.workdir, "big.txt"), Buffer.alloc(3 * 1024 * 1024, 97));
    assert.match((await call("read_file", { path: "big.txt" })).summary, /over the 2 MB read limit/);
  });

  it("edit_file: exactly-once rule, replace_all, clear failures", async () => {
    writeFileSync(join(sb.workdir, "f.js"), "let x = 1;\nlet y = 1;\n");
    const many = await call("edit_file", { path: "f.js", old_string: "= 1;", new_string: "= 2;" });
    assert.match(many.summary, /matches 2 places/);
    assert.equal(readFileSync(join(sb.workdir, "f.js"), "utf8"), "let x = 1;\nlet y = 1;\n", "nothing written on failure");
    const none = await call("edit_file", { path: "f.js", old_string: "let z", new_string: "q" });
    assert.match(none.summary, /not found/);
    const one = await call("edit_file", { path: "f.js", old_string: "let y = 1;", new_string: "let y = 3;" });
    assert.match(one.summary, /Edited f\.js \(1 replacement\)/);
    const all = await call("edit_file", { path: "f.js", old_string: "let", new_string: "const", replace_all: true });
    assert.match(all.summary, /2 replacements/);
    assert.equal(readFileSync(join(sb.workdir, "f.js"), "utf8"), "const x = 1;\nconst y = 3;\n");
  });

  it("glob and grep", async () => {
    mkdirSync(join(sb.workdir, "src/deep"), { recursive: true });
    mkdirSync(join(sb.workdir, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(sb.workdir, "src/a.ts"), "export const needle = 1;\n");
    writeFileSync(join(sb.workdir, "src/deep/b.ts"), "// NEEDLE here\n");
    writeFileSync(join(sb.workdir, "src/c.js"), "needle\n");
    writeFileSync(join(sb.workdir, "node_modules/pkg/x.ts"), "needle\n");
    const g = await call("glob", { pattern: "**/*.ts" });
    assert.deepEqual((g.details as { files: string[] }).files, ["src/a.ts", "src/deep/b.ts"]);
    const gr = await call("grep", { pattern: "needle", ignore_case: true, glob: "*.ts" });
    assert.match(gr.summary, /2 matches/);
    assert.match(gr.summary, /src\/a\.ts:1:export const needle/);
    assert.match(gr.summary, /src\/deep\/b\.ts:1:\/\/ NEEDLE here/);
    assert.doesNotMatch(gr.summary, /node_modules/);
    assert.match((await call("grep", { pattern: "absent-token" })).summary, /No matches/);
  });

  it("bash: streamed to the run timeline, exit code, time-out, Stop", async () => {
    const r = await call("bash", { command: "echo out; echo err 1>&2; exit 4" });
    assert.match(r.summary, /→ exit 4/);
    assert.match(r.summary, /stdout:\nout/);
    assert.match(r.summary, /stderr:\nerr/);
    const streamed = notes.filter((n) => n.payload.kind === "sandbox.output");
    assert.ok(streamed.some((n) => n.payload.stream === "stdout" && String(n.payload.data).includes("out")));
    assert.ok(streamed.some((n) => n.payload.stream === "stderr" && String(n.payload.data).includes("err")));
    const slow = await call("bash", { command: "sleep 5", timeout_ms: 1000 });
    assert.match(slow.summary, /timed out after 1 s/);
    assert.equal((slow.details as { timedOut: boolean }).timedOut, true);
    const ac = new AbortController();
    const p = call("bash", { command: "sleep 5" }, ctx({ signal: ac.signal }));
    setTimeout(() => ac.abort(new Error("Stopped by the user")), 100);
    await assert.rejects(p, /Stopped by the user/);
    assert.match((await call("bash", { command: "pwd", cwd: "../.." })).summary, /outside the sandbox workdir/);
  });

  it("run_tests: repo profile command; testsFailed on failure", async () => {
    writeFileSync(join(sb.workdir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }));
    const fail = await call("run_tests", {});
    assert.match(fail.summary, /Tests FAILED \(exit 1\): npm test \(from package\.json scripts\)/);
    assert.equal((fail.details as { testsFailed: boolean }).testsFailed, true);
    mkdirSync(join(sb.workdir, ".shapes"), { recursive: true });
    writeFileSync(join(sb.workdir, ".shapes/profile.json"), JSON.stringify({ testCommand: "echo all good" }));
    const pass = await call("run_tests", {});
    assert.match(pass.summary, /Tests passed: echo all good \(from \.shapes\/profile\.json\)/);
    assert.equal((pass.details as { testsFailed: boolean }).testsFailed, false);
    const none = new LocalDirSandbox();
    setCodeToolSandboxForTests(async () => none);
    assert.match((await call("run_tests", {})).summary, /No test command found/);
  });
});

describe("checkpoints", () => {
  it("a write checkpoints (snapshot + run event); a burst is batched and flushed before a command", async () => {
    await call("write_file", { path: "a.txt", content: "1" });
    let cps = notes.filter((n) => n.payload.kind === "sandbox.checkpoint");
    assert.equal(cps.length, 1, "the first write checkpoints at once");
    assert.deepEqual(cps[0]!.payload.files, ["a.txt"]);
    assert.equal(cps[0]!.payload.sandboxId, sb.id);
    const first = String(cps[0]!.payload.snapshotId);
    assert.ok(sb.snapshots.has(first));
    // A burst within the interval is batched…
    await call("write_file", { path: "b.txt", content: "2" });
    await call("edit_file", { path: "a.txt", old_string: "1", new_string: "one" });
    assert.equal(notes.filter((n) => n.payload.kind === "sandbox.checkpoint").length, 1);
    assert.ok(CHECKPOINT_MIN_INTERVAL_MS >= 1000);
    // …and closed before the next command runs.
    await call("bash", { command: "true" });
    cps = notes.filter((n) => n.payload.kind === "sandbox.checkpoint");
    assert.equal(cps.length, 2);
    assert.deepEqual(cps[1]!.payload.files, ["b.txt", "a.txt"]);
    // Restoring the first checkpoint puts the workdir back.
    await sb.restore(first);
    assert.equal(readFileSync(join(sb.workdir, "a.txt"), "utf8"), "1");
    assert.equal(existsSync(join(sb.workdir, "b.txt")), false);
    forgetCheckpoints(`run-${runN}`);
  });
});

describe("OutputStreamer", () => {
  it("batches chunks and caps what it streams", async () => {
    const sent: string[] = [];
    const s = new OutputStreamer(async (stream, data) => void sent.push(`${stream}:${data}`), { flushBytes: 10, maxBytes: 25, flushMs: 5 });
    s.push({ stream: "stdout", data: "abc" });
    s.push({ stream: "stdout", data: "defghijk" }); // crosses flushBytes → flush
    s.push({ stream: "stderr", data: "x".repeat(30) });
    await s.flush();
    assert.equal(sent[0], "stdout:abcdefghijk");
    assert.match(sent[1]!, /^stderr:x{14}\n…\[more output not streamed\]$/);
    s.push({ stream: "stdout", data: "ignored" });
    await s.flush();
    assert.equal(sent.length, 2);
  });
});
