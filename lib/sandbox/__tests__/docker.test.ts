// ShapesOS — Phase 8: the Docker provider against a FAKE Docker Engine API
// served on a temp unix socket (no Docker daemon here; the live daemon path
// is UNVERIFIED-LIVE). The fake implements exactly the endpoints docker.ts
// uses and records every request, so the tests pin the request shapes:
// create (network / volume / gateway / sandbox), the security options
// (cap-drop, no-new-privileges, read-only rootfs, limits, no binds, no
// published sandbox ports), exec + demux + timeout/stop, archive I/O,
// checkpoints and destroy.
// Run: npx tsx --test lib/sandbox/__tests__/docker.test.ts

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerClient } from "../docker-api";
import { DOCKER_WORKDIR, DockerSandbox, DockerSandboxProvider, watchdogScript } from "../docker";
import { sandboxConfig } from "../config";
import { dockerFrame } from "../output";
import { readTar, tarSingleFile } from "../tar";
import { SandboxPathError } from "../paths";
import { GATEWAY_SOURCE } from "../egress-gateway";

interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Buffer;
  json: Record<string, unknown> | null;
}

interface FakeContainer {
  name: string;
  spec: Record<string, unknown>;
  running: boolean;
}

interface FakeExec {
  id: string;
  container: string;
  body: Record<string, unknown>;
  exitCode: number | null;
  running: boolean;
  res?: ServerResponse;
  tag?: string;
}

class FakeDocker {
  readonly reqs: Req[] = [];
  readonly containers = new Map<string, FakeContainer>();
  readonly networks = new Map<string, Record<string, unknown>>();
  readonly volumes = new Map<string, Record<string, unknown>>();
  readonly execs = new Map<string, FakeExec>();
  readonly files = new Map<string, Buffer>();
  missingImageOnce = new Set<string>();
  archiveForWorkdir = tarSingleFile("work", Buffer.alloc(0));
  server: Server;
  private n = 0;

  constructor(readonly socket: string) {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  listen() {
    return new Promise<void>((r) => this.server.listen(this.socket, () => r()));
  }

  close() {
    this.server.closeAllConnections?.();
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  reset() {
    this.reqs.length = 0;
  }

  find(method: string, re: RegExp) {
    return this.reqs.filter((r) => r.method === method && re.test(r.path));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const u = new URL(req.url ?? "/", "http://docker");
    assert.match(u.pathname, /^\/v1\.41\//, "every call is pinned to API v1.41");
    const path = u.pathname.replace(/^\/v1\.41/, "");
    let json: Record<string, unknown> | null = null;
    if ((req.headers["content-type"] ?? "").includes("json") && body.length) json = JSON.parse(body.toString());
    const r: Req = { method: req.method ?? "GET", path, query: u.searchParams, body, json };
    this.reqs.push(r);
    const send = (status: number, data?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(data === undefined ? "" : JSON.stringify(data));
    };
    let m: RegExpMatchArray | null;
    if (path === "/_ping") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("OK");
    }
    if (r.method === "POST" && path === "/networks/create") {
      this.networks.set(String(json!.Name), json!);
      return send(201, { Id: `net${++this.n}` });
    }
    if (r.method === "POST" && path === "/volumes/create") {
      this.volumes.set(String(json!.Name), json!);
      return send(201, { Name: json!.Name });
    }
    if (r.method === "POST" && path === "/images/create") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"status":"Pulling"}\n{"status":"Done"}\n');
    }
    if (r.method === "POST" && path === "/containers/create") {
      const name = u.searchParams.get("name")!;
      const image = String(json!.Image);
      if (this.missingImageOnce.has(image)) {
        this.missingImageOnce.delete(image);
        return send(404, { message: `No such image: ${image}` });
      }
      this.containers.set(name, { name, spec: json!, running: false });
      return send(201, { Id: `c${++this.n}` });
    }
    if ((m = path.match(/^\/networks\/([^/]+)\/connect$/))) return send(200);
    if ((m = path.match(/^\/containers\/([^/]+)\/start$/))) {
      const c = this.containers.get(m[1]!);
      if (!c) return send(404, { message: "no such container" });
      c.running = true;
      return send(204);
    }
    if (r.method === "GET" && (m = path.match(/^\/containers\/([^/]+)\/json$/))) {
      const c = this.containers.get(m[1]!);
      if (!c) return send(404, { message: "no such container" });
      return send(200, {
        State: { Running: c.running },
        Config: { Labels: c.spec.Labels, Env: c.spec.Env },
        NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "49153" }] } },
      });
    }
    if (r.method === "POST" && (m = path.match(/^\/containers\/([^/]+)\/exec$/))) {
      if (!this.containers.get(m[1]!)?.running) return send(409, { message: "not running" });
      const id = `e${++this.n}`;
      const cmd = (json!.Cmd as string[]) ?? [];
      this.execs.set(id, { id, container: m[1]!, body: json!, exitCode: null, running: false, tag: cmd[3] === "shapes-exec" ? cmd[4] : undefined });
      return send(201, { Id: id });
    }
    if (r.method === "POST" && (m = path.match(/^\/exec\/([^/]+)\/start$/))) return this.startExec(m[1]!, json ?? {}, res);
    if (r.method === "GET" && (m = path.match(/^\/exec\/([^/]+)\/json$/))) {
      const e = this.execs.get(m[1]!);
      return send(200, { Running: e?.running ?? false, ExitCode: e?.exitCode ?? null });
    }
    if ((m = path.match(/^\/containers\/([^/]+)\/archive$/))) {
      const p = u.searchParams.get("path")!;
      if (r.method === "PUT") {
        for (const e of readTar(body)) if (e.type === "file") this.files.set(`${p}/${e.name}`, e.data!);
        this.files.set(`__put__${p}`, body);
        return send(200);
      }
      if (p === DOCKER_WORKDIR) {
        res.writeHead(200, { "content-type": "application/x-tar" });
        return res.end(this.archiveForWorkdir);
      }
      const f = this.files.get(p);
      if (!f) return send(404, { message: "Could not find the file" });
      res.writeHead(200, { "content-type": "application/x-tar" });
      return res.end(tarSingleFile(p.split("/").pop()!, f));
    }
    if (r.method === "DELETE" && (m = path.match(/^\/containers\/([^/]+)$/))) {
      return send(this.containers.delete(m[1]!) ? 204 : 404, {});
    }
    if (r.method === "DELETE" && (m = path.match(/^\/networks\/([^/]+)$/))) return send(this.networks.delete(m[1]!) ? 204 : 404, {});
    if (r.method === "DELETE" && (m = path.match(/^\/volumes\/([^/]+)$/))) return send(this.volumes.delete(m[1]!) ? 204 : 404, {});
    if (r.method === "GET" && path === "/containers/json") {
      return send(200, [...this.containers.values()].map((c) => ({ Labels: c.spec.Labels, State: c.running ? "running" : "exited" })));
    }
    if (r.method === "GET" && path === "/networks") return send(200, [...this.networks.values()].map((n) => ({ Labels: n.Labels })));
    if (r.method === "GET" && path === "/volumes") return send(200, { Volumes: [...this.volumes.values()].map((v) => ({ Labels: v.Labels })) });
    return send(500, { message: `fake docker: unhandled ${r.method} ${path}` });
  }

  private startExec(id: string, body: Record<string, unknown>, res: ServerResponse) {
    const e = this.execs.get(id);
    if (!e) {
      res.writeHead(404);
      return res.end();
    }
    const cmd = (e.body.Cmd as string[]) ?? [];
    if (body.Detach) {
      // A kill helper: `kill -TERM "$p"` for /tmp/.shapes-exec-<tag>.pid
      const script = cmd[2] ?? "";
      const tag = /shapes-exec-([0-9a-f]+)\.pid/.exec(script)?.[1];
      const sig = /kill -(TERM|KILL)/.exec(script)?.[1];
      for (const x of this.execs.values()) {
        if (x.tag === tag && x.running && x.res) {
          x.exitCode = sig === "KILL" ? 137 : 143;
          x.running = false;
          x.res.end();
        }
      }
      e.exitCode = 0;
      res.writeHead(200);
      return res.end();
    }
    const argv = cmd[3] === "shapes-exec" ? cmd.slice(6) : cmd;
    const script = argv[0] === "/bin/sh" && argv[1] === "-lc" ? argv[2]! : argv.join(" ");
    res.writeHead(200, { "content-type": "application/vnd.docker.multiplexed-stream" });
    e.running = true;
    if (script.includes("sleep-forever")) {
      e.res = res;
      res.write(dockerFrame("stdout", "started\n"));
      return;
    }
    if (script.includes("say-hello")) {
      const all = Buffer.concat([dockerFrame("stdout", "hel"), dockerFrame("stderr", "warn\n"), dockerFrame("stdout", "lo\n")]);
      // Split mid-header and mid-payload to exercise the demuxer.
      res.write(all.subarray(0, 5));
      res.write(all.subarray(5, 13));
      res.write(all.subarray(13));
      e.exitCode = 3;
    } else {
      e.exitCode = 0;
    }
    e.running = false;
    res.end();
  }
}

const dir = mkdtempSync(join(tmpdir(), "shapes-fake-docker-"));
const socket = join(dir, "docker.sock");
const snapDir = join(dir, "snaps");
const fake = new FakeDocker(socket);
const cfg = sandboxConfig({ DOCKER_HOST: `unix://${socket}`, SANDBOX_SNAPSHOT_DIR: snapDir, SANDBOX_CPUS: "1.5", SANDBOX_MEMORY_MB: "1024", SANDBOX_PIDS: "256", SANDBOX_IDLE_MINUTES: "10" });
const provider = () => new DockerSandboxProvider({ config: cfg, client: new DockerClient(socket), reap: false });

before(() => fake.listen());
after(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => fake.reset());

async function createOne(): Promise<DockerSandbox> {
  return (await provider().create({ workspaceId: "ws1", runId: "run1" })) as DockerSandbox;
}

describe("DockerSandboxProvider.available", () => {
  it("ok when the daemon answers /_ping", async () => {
    assert.deepEqual(await provider().available(), { ok: true });
  });
  it("explains a missing socket and refuses tcp:// hosts", async () => {
    const missing = new DockerSandboxProvider({ config: sandboxConfig({ DOCKER_HOST: `unix://${join(dir, "nope.sock")}` }) });
    const a = await missing.available();
    assert.equal(a.ok, false);
    assert.match((a as { reason: string }).reason, /No Docker socket/);
    const tcp = await new DockerSandboxProvider({ config: sandboxConfig({ DOCKER_HOST: "tcp://10.0.0.1:2375" }) }).available();
    assert.match((tcp as { reason: string }).reason, /unix socket/);
  });
});

describe("DockerSandboxProvider.create — request shapes and security options", () => {
  it("creates an internal network, a labelled volume, the gateway and the sandbox", async () => {
    const sb = await createOne();
    assert.match(sb.id, /^shapes-sbx-[0-9a-f]{12}$/);
    assert.equal(sb.workdir, "/home/node/work");

    const order = fake.reqs.map((r) => `${r.method} ${r.path.replace(/shapes-sbx-[0-9a-f]+/, "X")}`);
    assert.deepEqual(order.slice(0, 7), [
      "POST /networks/create",
      "POST /volumes/create",
      "POST /containers/create",
      "POST /containers/create",
      "POST /networks/X-net/connect",
      "POST /containers/X-gw/start",
      "POST /containers/X/start",
    ]);

    const net = fake.find("POST", /^\/networks\/create$/)[0]!.json!;
    assert.equal(net.Internal, true, "the sandbox network has no route off the box");
    assert.equal(net.Driver, "bridge");
    const vol = fake.find("POST", /^\/volumes\/create$/)[0]!.json!;
    assert.deepEqual(vol.DriverOpts, {}, "no disk cap configured → plain volume");
    assert.equal((vol.Labels as Record<string, string>)["shapes.run"], "run1");

    const creates = fake.find("POST", /^\/containers\/create$/);
    const sandboxReq = creates.find((r) => !r.query.get("name")!.endsWith("-gw"))!;
    const s = sandboxReq.json!;
    const hc = s.HostConfig as Record<string, unknown>;
    assert.equal(s.Image, cfg.docker.image);
    assert.equal(s.User, "1000:1000", "never root");
    assert.deepEqual(hc.CapDrop, ["ALL"]);
    assert.deepEqual(hc.CapAdd, []);
    assert.deepEqual(hc.SecurityOpt, ["no-new-privileges:true"]);
    assert.equal(hc.ReadonlyRootfs, true);
    assert.equal(hc.Privileged, false);
    assert.deepEqual(hc.Binds, [], "no host mounts");
    const mounts = hc.Mounts as Array<Record<string, unknown>>;
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0]!.Type, "volume", "only the named volume — never a bind");
    assert.equal(mounts[0]!.Target, "/home/node");
    assert.deepEqual(Object.keys(hc.Tmpfs as object), ["/tmp"]);
    assert.equal(hc.NanoCpus, 1_500_000_000);
    assert.equal(hc.Memory, 1024 * 1024 * 1024);
    assert.equal(hc.MemorySwap, hc.Memory, "no swap beyond the memory limit");
    assert.equal(hc.PidsLimit, 256);
    assert.equal(hc.AutoRemove, true);
    assert.equal(hc.Init, true);
    assert.deepEqual(hc.PortBindings, {}, "the sandbox publishes no ports");
    assert.equal(hc.PublishAllPorts, false);
    assert.match(String(hc.NetworkMode), /^shapes-sbx-[0-9a-f]{12}-net$/);
    const env = s.Env as string[];
    assert.ok(env.includes("HTTPS_PROXY=http://egress:3128") && env.includes("HTTP_PROXY=http://egress:3128"));
    const labels = s.Labels as Record<string, string>;
    assert.equal(labels["shapes.workspace"], "ws1");
    assert.equal(labels["shapes.run"], "run1");
    assert.equal(labels["shapes.sandbox.role"], "sandbox");
    assert.match((s.Cmd as string[])[2]!, /-ge 600 \] && exit 0/, "idle watchdog uses SANDBOX_IDLE_MINUTES");

    const g = creates.find((r) => r.query.get("name")!.endsWith("-gw"))!.json!;
    const ghc = g.HostConfig as Record<string, unknown>;
    assert.deepEqual(ghc.CapDrop, ["ALL"]);
    assert.equal(ghc.ReadonlyRootfs, true);
    assert.deepEqual(ghc.Binds, []);
    assert.equal(g.User, "1000:1000");
    assert.deepEqual(ghc.PortBindings, { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] }, "preview port on loopback only");
    assert.equal((g.Cmd as string[])[2], GATEWAY_SOURCE);
    const genv = g.Env as string[];
    assert.ok(genv.some((e) => e.startsWith("ALLOW=") && e.includes("registry.npmjs.org") && e.includes("github.com")));
    assert.ok(genv.some((e) => /^GATEWAY_TOKEN=[0-9a-f]{48}$/.test(e)));

    const mk = [...fake.execs.values()].find((e) => (e.body.Cmd as string[]).includes("mkdir"))!;
    assert.equal(mk.body.User, "1000:1000");
    assert.deepEqual((mk.body.Cmd as string[]).slice(-3), ["mkdir", "-p", "/home/node/work"]);
  });

  it("caps the workdir with a tmpfs-backed volume when SANDBOX_DISK_MB is set", async () => {
    const p = new DockerSandboxProvider({ config: { ...cfg, resources: { ...cfg.resources, diskMb: 2048 } }, client: new DockerClient(socket), reap: false });
    await p.create({ workspaceId: "ws1", runId: "run1" });
    const vol = fake.find("POST", /^\/volumes\/create$/)[0]!.json!;
    assert.deepEqual(vol.DriverOpts, { type: "tmpfs", device: "tmpfs", o: "size=2048m,uid=1000,gid=1000,mode=0755" });
  });

  it("pulls a missing image, then creates", async () => {
    const image = "example/missing:1";
    fake.missingImageOnce.add(image);
    await provider().create({ workspaceId: "ws1", runId: "run1", image });
    const pull = fake.find("POST", /^\/images\/create$/);
    assert.equal(pull.length, 1);
    assert.equal(pull[0]!.query.get("fromImage"), image);
  });

  it("the watchdog keeps a sandbox alive while a command runs", () => {
    const w = watchdogScript(30);
    assert.match(w, /-ge 60 \]/, "never below one minute");
    assert.match(w, /kill -0/);
  });
});

describe("DockerSandbox.exec", () => {
  it("demuxes stdout/stderr, streams chunks and reads the exit code", async () => {
    const sb = await createOne();
    const seen: string[] = [];
    const r = await sb.exec("say-hello", { onOutput: (c) => seen.push(`${c.stream}:${c.data}`), env: { FOO: "bar", "bad key": "x" }, cwd: "src", timeoutMs: 5000 });
    assert.equal(r.stdout, "hello\n");
    assert.equal(r.stderr, "warn\n");
    assert.equal(r.exitCode, 3);
    assert.equal(r.timedOut, false);
    assert.ok(seen.length >= 3 && seen.some((s) => s.startsWith("stderr:")));
    const e = [...fake.execs.values()].find((x) => (x.body.Cmd as string[]).includes("say-hello"))!;
    const cmd = e.body.Cmd as string[];
    assert.deepEqual(cmd.slice(0, 2), ["/bin/sh", "-c"]);
    assert.match(cmd[2]!, /exec timeout -k 5 "\$t" "\$@"/);
    assert.equal(cmd[5], "10", "timeout seconds = ceil(timeoutMs) + 5");
    assert.deepEqual(cmd.slice(6), ["/bin/sh", "-lc", "say-hello"]);
    assert.deepEqual(e.body.Env, ["FOO=bar"], "invalid env names dropped");
    assert.equal(e.body.WorkingDir, "/home/node/work/src");
    assert.equal(e.body.Tty, false);
    assert.equal(e.body.AttachStdin, false);
  });

  it("refuses a cwd outside the workdir", async () => {
    const sb = await createOne();
    await assert.rejects(sb.exec("ls", { cwd: "../.." }), SandboxPathError);
  });

  it("a time-out signals the process group and reports timedOut", async () => {
    const sb = await createOne();
    const r = await sb.exec("sleep-forever", { timeoutMs: 150 });
    assert.equal(r.timedOut, true);
    assert.equal(r.stdout, "started\n");
    const kills = [...fake.execs.values()].filter((x) => /kill -TERM/.test((x.body.Cmd as string[])[2] ?? ""));
    assert.equal(kills.length, 1);
  });

  it("Stop (abort signal) kills the command and rejects", async () => {
    const sb = await createOne();
    const ac = new AbortController();
    const p = sb.exec("sleep-forever", { signal: ac.signal });
    setTimeout(() => ac.abort(new Error("Stopped by the user")), 100);
    await assert.rejects(p, /Stopped by the user/);
  });
});

describe("DockerSandbox files, checkpoints, previews, destroy", () => {
  it("writeFile: mkdir -p the parent, then PUT a one-file tar (uid 1000) into it", async () => {
    const sb = await createOne();
    fake.reset();
    await sb.writeFile("src/app.ts", "export const x = 1;\n");
    const put = fake.find("PUT", /\/archive$/)[0]!;
    assert.equal(put.query.get("path"), "/home/node/work/src");
    const [entry] = readTar(put.body);
    assert.equal(entry!.name, "app.ts");
    assert.equal(entry!.data!.toString(), "export const x = 1;\n");
    assert.equal(put.body.subarray(108, 115).toString("ascii"), "0001750");
    assert.ok(fake.files.has("/home/node/work/src/app.ts"));
    // read it back through GET archive
    assert.equal((await sb.readFile("src/app.ts")).toString(), "export const x = 1;\n");
  });

  it("refuses traversal before any request is made", async () => {
    const sb = await createOne();
    fake.reset();
    await assert.rejects(sb.writeFile("../../etc/passwd", "x"), SandboxPathError);
    await assert.rejects(sb.readFile("/etc/shadow"), SandboxPathError);
    assert.equal(fake.reqs.length, 0);
  });

  it("checkpoint = GET archive of the workdir to disk; restore clears it and PUTs the tar back under /home/node", async () => {
    const sb = await createOne();
    fake.archiveForWorkdir = tarSingleFile("work/a.txt", Buffer.from("v1"));
    const snap = await sb.snapshot("edits");
    assert.match(snap.id, /^snap-[a-z0-9]+$/);
    const files = readdirSync(join(snapDir, sb.id));
    assert.deepEqual(files, [`${snap.id}.tar`]);
    fake.reset();
    await sb.restore(snap.id);
    const clear = [...fake.execs.values()].find((x) => (x.body.Cmd as string[]).includes("-delete"))!;
    assert.deepEqual((clear.body.Cmd as string[]).slice(-5), ["find", "/home/node/work", "-mindepth", "1", "-delete"]);
    const put = fake.find("PUT", /\/archive$/)[0]!;
    assert.equal(put.query.get("path"), "/home/node");
    assert.deepEqual(put.body, fake.archiveForWorkdir);
    await assert.rejects(sb.restore("../../etc"), /Unknown checkpoint/);
    await assert.rejects(sb.restore("snap-doesnotexist"), /Unknown checkpoint/);
  });

  it("exposePort returns the app's authenticated route; previewUpstream names the gateway on loopback", async () => {
    const sb = await createOne();
    assert.deepEqual(await sb.exposePort(5173), { url: "/api/agent-runs/run1/preview/5173/" });
    await assert.rejects(sb.exposePort(22), /between 1024/);
    const up = await sb.previewUpstream(5173);
    assert.equal(up.origin, "http://127.0.0.1:49153");
    assert.equal(up.kind, "loopback");
    assert.equal(up.headers["x-shapes-preview-port"], "5173");
    assert.match(up.headers["x-shapes-gateway-token"]!, /^[0-9a-f]{48}$/);
  });

  it("destroy removes the container, gateway, network, volume and checkpoints", async () => {
    const sb = await createOne();
    fake.archiveForWorkdir = tarSingleFile("work/a.txt", Buffer.from("v1"));
    await sb.snapshot();
    fake.reset();
    await sb.destroy();
    const dels = fake.reqs.filter((r) => r.method === "DELETE").map((r) => r.path.replace(/shapes-sbx-[0-9a-f]+/, "X"));
    assert.deepEqual(dels, ["/containers/X", "/containers/X-gw", "/networks/X-net", "/volumes/X-home"]);
    assert.equal(fake.reqs.find((r) => r.method === "DELETE")!.query.get("force"), "true");
    assert.equal(existsSync(join(snapDir, sb.id)), false);
  });

  it("get() reattaches a running, labelled sandbox; unknown or malformed ids are null", async () => {
    const sb = await createOne();
    const again = (await provider().get(sb.id)) as DockerSandbox;
    assert.ok(again);
    assert.equal(again.runId, "run1");
    assert.equal(again.workspaceId, "ws1");
    assert.equal(await provider().get("shapes-sbx-000000000000"), null);
    fake.reset();
    assert.equal(await provider().get("../../containers/x"), null);
    assert.equal(fake.reqs.length, 0);
  });

  it("reapOrphans removes the leftovers of a sandbox that idled out", async () => {
    const sb = await createOne();
    fake.containers.delete(sb.id); // the watchdog exited; AutoRemove deleted it
    fake.reset();
    const n = await provider().reapOrphans();
    assert.ok(n >= 1);
    const dels = fake.reqs.filter((r) => r.method === "DELETE").map((r) => r.path);
    assert.ok(dels.includes(`/networks/${sb.id}-net`) && dels.includes(`/volumes/${sb.id}-home`) && dels.includes(`/containers/${sb.id}-gw`));
  });
});
