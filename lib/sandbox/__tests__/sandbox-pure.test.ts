// ShapesOS — Phase 8: the pure sandbox pieces (paths, edits, globs, tar,
// config, output, previews, CSP routing).
// Run: npx tsx --test lib/sandbox/__tests__/sandbox-pure.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSandboxPath, SandboxPathError, shq } from "../paths";
import { applyExactEdit, countOccurrences, globToRegExp, numberLines } from "../edit";
import { parseProfileOverride } from "../repo-profile";
import { firstFileInTar, readTar, tarSingleFile } from "../tar";
import { DEFAULT_EGRESS_ALLOW, SANDBOX_DEFAULT_IMAGE, dockerSocketPath, hostAllowed, normalizeEgressHost, sandboxConfig } from "../config";
import { DockerDemuxer, OutputCollector, dockerFrame } from "../output";
import {
  forwardRequestHeaders,
  previewPath,
  previewResponseHeaders,
  readCookie,
  signPreviewToken,
  upstreamAllowed,
  verifyPreviewToken,
} from "../preview";
import { SANDBOX_PREVIEW_CSP, contentSecurityPolicyFor, API_CONTENT_SECURITY_POLICY, isSandboxPreviewPath } from "@/lib/security/headers";
import { isSandboxOutputEvent, previewLinks, sandboxRunView } from "../run-view";

const WD = "/home/node/work";

describe("path safety", () => {
  it("resolves relative and absolute paths inside the workdir", () => {
    assert.equal(resolveSandboxPath(WD, "src/a.ts"), `${WD}/src/a.ts`);
    assert.equal(resolveSandboxPath(WD, "./src/../b.ts"), `${WD}/b.ts`);
    assert.equal(resolveSandboxPath(WD, `${WD}/x/y`), `${WD}/x/y`);
    assert.equal(resolveSandboxPath(WD, ""), WD);
    assert.equal(resolveSandboxPath(WD, "."), WD);
    assert.equal(resolveSandboxPath(WD, "dir/"), `${WD}/dir`);
  });

  it("refuses traversal, absolute escapes, sibling prefixes and NUL bytes", () => {
    for (const bad of ["../x", "../../etc/passwd", "a/../../x", "/etc/passwd", "/home/node", "/home/node/workshop/x", `${WD}/../x`, "a\0b"]) {
      assert.throws(() => resolveSandboxPath(WD, bad), SandboxPathError, bad);
    }
  });

  it("shq quotes for /bin/sh", () => {
    assert.equal(shq("it's"), `'it'\\''s'`);
    assert.equal(shq("$(rm -rf /)"), `'$(rm -rf /)'`);
  });
});

describe("edit_file: exact string, exactly once", () => {
  const src = "const a = 1;\nconst b = 2;\nconst a2 = 1;\n";
  it("replaces a unique match", () => {
    const r = applyExactEdit(src, "const b = 2;", "const b = 3;");
    assert.deepEqual(r, { ok: true, content: "const a = 1;\nconst b = 3;\nconst a2 = 1;\n", replacements: 1 });
  });
  it("fails clearly on zero matches", () => {
    const r = applyExactEdit(src, "const c", "x");
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /not found/);
  });
  it("fails clearly on more than one match unless replace_all", () => {
    const r = applyExactEdit(src, "= 1;", "= 9;");
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /matches 2 places/);
    const all = applyExactEdit(src, "= 1;", "= 9;", true);
    assert.deepEqual(all, { ok: true, content: "const a = 9;\nconst b = 2;\nconst a2 = 9;\n", replacements: 2 });
  });
  it("refuses empty / identical strings and treats $ literally", () => {
    assert.equal(applyExactEdit(src, "", "x").ok, false);
    assert.equal(applyExactEdit(src, "const b = 2;", "const b = 2;").ok, false);
    const r = applyExactEdit("price: X", "X", "$&$1");
    assert.deepEqual(r, { ok: true, content: "price: $&$1", replacements: 1 });
    assert.equal(countOccurrences("aaaa", "aa"), 2);
  });
});

describe("glob / numberLines / repo profile", () => {
  it("globToRegExp", () => {
    const ts = globToRegExp("**/*.ts");
    assert.ok(ts.test("a.ts") && ts.test("src/deep/b.ts"));
    assert.ok(!ts.test("a.tsx") && !ts.test("a.js"));
    const src = globToRegExp("src/**/*.{js,jsx}");
    assert.ok(src.test("src/a.js") && src.test("src/x/y/a.jsx"));
    assert.ok(!src.test("lib/a.js"));
    assert.ok(globToRegExp("*.md").test("docs/readme.md"), "slash-less globs match the basename at any depth");
    assert.ok(globToRegExp("file?.[ch]").test("file1.c"));
    assert.ok(!globToRegExp("file?.[ch]").test("file12.c"));
  });

  it("numberLines shows a 1-based range", () => {
    const { view, totalLines, shown } = numberLines("a\nb\nc\nd\n", 2, 2);
    assert.equal(totalLines, 4);
    assert.deepEqual(shown, [2, 3]);
    assert.equal(view, "2\tb\n3\tc");
  });

  it("parseProfileOverride: .shapes/profile.json, both shapes (detection itself: repo-profile.test.ts)", () => {
    assert.deepEqual(parseProfileOverride('{"testCommand":"make check","lintCommand":" ruff . "}'), { test: "make check", lint: "ruff ." });
    assert.deepEqual(parseProfileOverride('{"commands":{"typecheck":"tsc -p .","build":"make"},"testCommand":"t"}'), { test: "t", build: "make", typecheck: "tsc -p ." });
    assert.equal(parseProfileOverride('{"testCommand":"   "}'), null);
    assert.equal(parseProfileOverride("not json"), null);
    assert.equal(parseProfileOverride("[1]"), null);
    assert.equal(parseProfileOverride(null), null);
  });
});

describe("tar", () => {
  it("round-trips a single file (short and PAX long names)", () => {
    const data = Buffer.from("hello\nworld\n");
    const t = tarSingleFile("a.txt", data, { uid: 1000, gid: 1000, mtime: 1 });
    assert.equal(t.length % 512, 0);
    const [e] = readTar(t);
    assert.equal(e!.name, "a.txt");
    assert.equal(e!.type, "file");
    assert.deepEqual(e!.data, data);
    assert.equal(t.subarray(108, 115).toString("ascii"), "0001750"); // uid 1000 octal
    const long = `${"x".repeat(150)}.ts`;
    const t2 = tarSingleFile(long, Buffer.from("y"));
    assert.equal(readTar(t2)[0]!.name, long);
    assert.deepEqual(firstFileInTar(t2), Buffer.from("y"));
  });

  it("checksums are valid ustar", () => {
    const t = tarSingleFile("x", Buffer.from("1"));
    const h = Buffer.from(t.subarray(0, 512));
    const stored = parseInt(h.subarray(148, 154).toString("ascii"), 8);
    h.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    assert.equal(stored, sum);
  });
});

describe("config", () => {
  it("defaults: docker, pinned image, registries + GitHub only", () => {
    const c = sandboxConfig({});
    assert.equal(c.provider, "docker");
    assert.equal(c.docker.socketPath, "/var/run/docker.sock");
    assert.equal(c.docker.image, SANDBOX_DEFAULT_IMAGE);
    assert.match(SANDBOX_DEFAULT_IMAGE, /^node:\d+\.\d+\.\d+-bookworm@sha256:[0-9a-f]{64}$/);
    assert.ok(c.egressAllow.includes("registry.npmjs.org") && c.egressAllow.includes("github.com") && c.egressAllow.includes("pypi.org"));
    assert.equal(c.resources.diskMb, null);
    assert.equal(c.idleSeconds, 30 * 60);
  });

  it("provider switches, invalid values, socket parsing, extra egress", () => {
    assert.equal(sandboxConfig({ SANDBOX_PROVIDER: "e2b" }).provider, "e2b");
    assert.equal(sandboxConfig({ SANDBOX_PROVIDER: "off" }).provider, null);
    const bad = sandboxConfig({ SANDBOX_PROVIDER: "kubernetes" });
    assert.equal(bad.provider, null);
    assert.equal(bad.invalidProvider, "kubernetes");
    assert.equal(dockerSocketPath("unix:///run/user/1000/docker.sock"), "/run/user/1000/docker.sock");
    assert.equal(dockerSocketPath("tcp://10.0.0.1:2375"), "", "plain TCP Docker hosts are refused");
    const c = sandboxConfig({ SANDBOX_EGRESS_ALLOW: "https://crates.io/x, *.example.org ,not a host", SANDBOX_DISK_MB: "4096", SANDBOX_CPUS: "999" });
    assert.ok(c.egressAllow.includes("crates.io") && c.egressAllow.includes("*.example.org"));
    assert.ok(!c.egressAllow.includes("not a host"));
    assert.equal(c.resources.diskMb, 4096);
    assert.equal(c.resources.cpus, 64);
    assert.equal(normalizeEgressHost("GitHub.com:443"), "github.com");
  });

  it("hostAllowed: exact names and *.suffix only", () => {
    assert.ok(hostAllowed("registry.npmjs.org", DEFAULT_EGRESS_ALLOW));
    assert.ok(!hostAllowed("evil.registry.npmjs.org", DEFAULT_EGRESS_ALLOW));
    assert.ok(!hostAllowed("registry.npmjs.org.evil.com", DEFAULT_EGRESS_ALLOW));
    assert.ok(hostAllowed("a.b.example.org", ["*.example.org"]));
    assert.ok(!hostAllowed("example.org", ["*.example.org"]));
  });
});

describe("output", () => {
  it("OutputCollector caps each stream and streams decoded chunks (UTF-8 safe)", () => {
    const seen: string[] = [];
    const c = new OutputCollector({ maxOutputBytes: 5, onOutput: (x) => seen.push(`${x.stream}:${x.data}`) });
    const euro = Buffer.from("€"); // 3 bytes
    c.push("stdout", euro.subarray(0, 2));
    c.push("stdout", euro.subarray(2));
    c.push("stdout", "abcdef");
    c.push("stderr", "err");
    const r = c.result(0, false, Date.now());
    assert.equal(r.stdout, "€ab");
    assert.equal(r.stderr, "err");
    assert.equal(r.truncated, true);
    assert.deepEqual(seen, ["stdout:€", "stdout:ab", "stderr:err"]);
  });

  it("DockerDemuxer splits multiplexed frames across arbitrary chunk boundaries", () => {
    const got: string[] = [];
    const d = new DockerDemuxer((s, b) => got.push(`${s}:${b.toString()}`));
    const stream = Buffer.concat([dockerFrame("stdout", "hello "), dockerFrame("stderr", "oops"), dockerFrame("stdout", "world")]);
    for (let i = 0; i < stream.length; i += 3) d.write(stream.subarray(i, i + 3));
    const joined = (s: string) => got.filter((g) => g.startsWith(s)).map((g) => g.slice(s.length + 1)).join("");
    assert.equal(joined("stdout"), "hello world");
    assert.equal(joined("stderr"), "oops");
  });
});

describe("previews", () => {
  const SECRET = "s".repeat(32);
  it("preview tokens: bound to run, expiry, tamper-proof", () => {
    const now = 1_000_000;
    const t = signPreviewToken({ runId: "r1", userId: "u1", workspaceId: "w1", exp: now + 60 }, SECRET);
    assert.deepEqual(verifyPreviewToken(t, "r1", SECRET, now), { runId: "r1", userId: "u1", workspaceId: "w1", exp: now + 60 });
    assert.equal(verifyPreviewToken(t, "r2", SECRET, now), null, "other run");
    assert.equal(verifyPreviewToken(t, "r1", SECRET, now + 61), null, "expired");
    assert.equal(verifyPreviewToken(t, "r1", "x".repeat(32), now), null, "other key");
    assert.equal(verifyPreviewToken(`${t.slice(0, -2)}AA`, "r1", SECRET, now), null, "tampered");
    assert.equal(readCookie("a=1; shapes_preview=abc%3D; b=2", "shapes_preview"), "abc=");
  });

  it("upstreams: loopback must match exactly; public must be https + pattern", () => {
    const loop = { origin: "http://127.0.0.1:49153", headers: {}, kind: "loopback" as const };
    assert.ok(upstreamAllowed(new URL("http://127.0.0.1:49153/x"), loop));
    assert.ok(!upstreamAllowed(new URL("http://127.0.0.1:5432/x"), loop));
    const pub = { origin: "https://3000-abc.e2b.app", headers: {}, kind: "public" as const, hostPattern: /^3000-abc\.e2b\.app$/ };
    assert.ok(upstreamAllowed(new URL("https://3000-abc.e2b.app/a"), pub));
    assert.ok(!upstreamAllowed(new URL("http://3000-abc.e2b.app/a"), pub));
    assert.ok(!upstreamAllowed(new URL("https://3000-abd.e2b.app/a"), pub));
  });

  it("never forwards the app's credentials; responses can't set app cookies", () => {
    const fwd = forwardRequestHeaders(new Headers({ cookie: "authjs.session-token=x", authorization: "Bearer y", accept: "text/html", "x-shapes-gateway-token": "z" }));
    assert.deepEqual(fwd, { accept: "text/html" });
    const out = previewResponseHeaders(new Headers({ "set-cookie": "a=b", "content-type": "text/html", "content-security-policy": "default-src *" }));
    assert.equal(out.get("set-cookie"), null);
    assert.equal(out.get("content-type"), "text/html");
    assert.equal(out.get("content-security-policy"), SANDBOX_PREVIEW_CSP);
  });

  it("proxy.ts gives preview paths the sandbox CSP (opaque origin), other API paths keep theirs", () => {
    assert.ok(isSandboxPreviewPath("/api/agent-runs/abc/preview/3000/"));
    assert.ok(isSandboxPreviewPath("/api/agent-runs/abc/preview/3000/assets/x.js"));
    assert.ok(!isSandboxPreviewPath("/api/agent-runs/abc/restore"));
    assert.equal(contentSecurityPolicyFor("/api/agent-runs/abc/preview/3000/", { nonce: "n" }), SANDBOX_PREVIEW_CSP);
    assert.equal(contentSecurityPolicyFor("/api/agent-runs/abc/cancel", { nonce: "n" }), API_CONTENT_SECURITY_POLICY);
    assert.match(SANDBOX_PREVIEW_CSP, /^sandbox allow-scripts allow-forms allow-modals allow-downloads;/);
    assert.doesNotMatch(SANDBOX_PREVIEW_CSP, /allow-same-origin|allow-top-navigation|allow-popups/);
    assert.equal(previewPath("r 1", 3000), "/api/agent-runs/r%201/preview/3000/");
  });
});

describe("run view", () => {
  it("collects checkpoints (newest first), restores and the output tail", () => {
    const ev = (seq: number, payload: Record<string, unknown>) => ({ seq, summary: "x", payload, createdAt: new Date(seq * 1000) });
    const v = sandboxRunView(
      [
        ev(1, { kind: "sandbox.checkpoint", snapshotId: "snap-a1b2c3", sandboxId: "s1", files: ["a.ts"] }),
        ev(2, { kind: "sandbox.output", tool: "bash", stream: "stdout", data: "0123456789" }),
        ev(3, { kind: "sandbox.checkpoint", snapshotId: "snap-d4e5f6", sandboxId: "s1", files: [] }),
        ev(4, { kind: "sandbox.restored", snapshotId: "snap-a1b2c3" }),
        ev(5, { kind: "sandbox.output", tool: "run_tests", stream: "stderr", data: "abcdef" }),
      ],
      { maxOutputChars: 8 },
    );
    assert.deepEqual(v.checkpoints.map((c) => c.snapshotId), ["snap-d4e5f6", "snap-a1b2c3"]);
    assert.deepEqual(v.restoredSnapshotIds, ["snap-a1b2c3"]);
    assert.equal(v.output.map((o) => o.text).join(""), "89abcdef");
    assert.ok(isSandboxOutputEvent({ payload: { kind: "sandbox.output" } }));
    assert.ok(!isSandboxOutputEvent({ payload: null }));
    assert.deepEqual(previewLinks("r", [5173, 3000, 3000]), [
      { port: 3000, href: "/api/agent-runs/r/preview/3000/" },
      { port: 5173, href: "/api/agent-runs/r/preview/5173/" },
    ]);
  });
});
