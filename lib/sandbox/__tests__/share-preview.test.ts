// ShapesOS — share_preview tool (in-product browser "Dev preview" v1):
// fails closed without the spend gate; syncs the run workdir into the
// project's dev sandbox, starts the server, records the port, returns the
// browser tab link. Run + dev sandboxes are stubbed; DB is module-mocked.
// Run: npx tsx --test --experimental-test-module-mocks lib/sandbox/__tests__/share-preview.test.ts

import { before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { Sandbox } from "../types";

let spendAllowed = true;
let devSandbox: StubSandbox;
let runSandbox: StubSandbox;
const portsRecorded: number[][] = [];

mock.module("../dev-sandbox", {
  namedExports: {
    devSandboxSpendAllowed: () =>
      spendAllowed
        ? { allowed: true, bounds: { mode: "test", maxConcurrentPerWorkspace: 1, absoluteCeilingMs: 1_000, ttlSeconds: 300 }, mode: "test" }
        : { allowed: false, bounds: null, mode: "off", reason: "The authorized test window has ended." },
    ensureDevSandbox: async () => ({ ok: true, sandbox: devSandbox, row: { exposedPorts: [] }, woke: "created" }),
    getDevSandboxRow: async () => ({ exposedPorts: [] }),
    touchDevSandboxPorts: async (_ws: string, _p: string, ports: number[]) => { portsRecorded.push(ports); },
  },
});
mock.module("../index", {
  namedExports: {
    sandboxForRun: async () => runSandbox,
  },
});

let share_preview: typeof import("../share-preview").share_preview;
before(async () => {
  ({ share_preview } = await import("../share-preview"));
});

interface ExecRec { cmd: string }
class StubSandbox {
  id = "sb";
  provider = "e2b" as const;
  workdir = "/home/user/app";
  execs: ExecRec[] = [];
  written: string[] = [];
  exposed: number[] = [];
  failCurl = false;
  packageJson: string | null = JSON.stringify({ scripts: { dev: "vite" } });
  async exec(cmd: string | string[]) {
    const c = Array.isArray(cmd) ? cmd.join(" ") : cmd;
    this.execs.push({ cmd: c });
    if (c.startsWith("cat ")) return { exitCode: this.packageJson ? 0 : 1, stdout: this.packageJson ?? "", stderr: "" };
    if (c.includes("curl -sf")) return { exitCode: this.failCurl ? 1 : 0, stdout: "", stderr: "" };
    if (c.startsWith("tail")) return { exitCode: 0, stdout: "Error: EADDRINUSE", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  async readFile() { return Buffer.from("tarball"); }
  async writeFile(p: string) { this.written.push(p); }
  async listFiles() { return []; }
  async snapshot() { return { id: "s1", createdAt: "" }; }
  async restore() { /* noop */ }
  async exposePort(port: number) { this.exposed.push(port); return { url: `https://sb-${port}.e2b.dev` }; }
  async destroy() { /* noop */ }
  async pause() { /* noop */ }
  async resume() { /* noop */ }
}

const ctx = { workspaceId: "ws1", projectId: "p1", userId: "u1", role: "editor", confirmed: true } as never;

describe("share_preview", () => {
  beforeEach(() => {
    spendAllowed = true;
    devSandbox = new StubSandbox();
    runSandbox = new StubSandbox();
    portsRecorded.length = 0;
  });

  it("fails closed when the spend gate is off (no sandbox touched)", async () => {
    spendAllowed = false;
    const r = await share_preview.execute(ctx, { port: 3000 });
    assert.match(r.summary, /test window has ended/);
    assert.equal(devSandbox.execs.length, 0, "no command ran");
  });

  it("rejects an invalid port", async () => {
    const r = await share_preview.execute(ctx, { port: 99999 });
    assert.match(r.summary, /valid port/);
  });

  it("syncs, starts, records the port and returns the browser tab link", async () => {
    const r = await share_preview.execute(ctx, { port: 3000 });
    const cmds = devSandbox.execs.map((e) => e.cmd).join("\n");
    assert.match(cmds, /tar xzf \/tmp\/share-preview\.tgz/, "unpacked into the dev sandbox");
    assert.match(cmds, /npm run dev/, "detected dev script started");
    assert.match(cmds, /PORT=3000/, "port passed to the server");
    assert.match(cmds, /BASE_PATH=\/api\/projects\/p1\/dev-preview\/3000\//, "preview base path set");
    assert.deepEqual(devSandbox.exposed, [3000]);
    assert.deepEqual(portsRecorded, [[3000]], "port recorded on the row for the proxy allowlist");
    const url = (r.details as { url?: string })?.url;
    assert.equal(url, "/api/projects/p1/dev-preview/3000/");
    const runCmds = runSandbox.execs.map((e) => e.cmd).join("\n");
    assert.match(runCmds, /tar czf/, "workdir packaged from the run sandbox");
  });

  it("uses an explicit command over detection", async () => {
    await share_preview.execute(ctx, { port: 8080, command: "python3 -m http.server 8080" });
    const cmds = devSandbox.execs.map((e) => e.cmd).join("\n");
    assert.match(cmds, /python3 -m http\.server 8080/);
    assert.ok(!cmds.includes("npm run dev"));
  });

  it("reports plainly when the server never answers", async () => {
    devSandbox.failCurl = true;
    const r = await share_preview.execute(ctx, { port: 3000 });
    assert.match(r.summary, /didn't come up/);
    assert.match(r.summary, /EADDRINUSE/, "log tail surfaced");
    assert.deepEqual(devSandbox.exposed, [], "nothing exposed on failure");
  }, { timeout: 30_000 });
});
