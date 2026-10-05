// ShapesOS — Phase 8 (ship): pure git helpers — push guard, argv building,
// secret scrubbing, parsers, and the review diff parser.
// Run: npx tsx --test lib/ship/__tests__/git.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertPushAllowed,
  authGitConfigArgs,
  capPatch,
  cloneArgs,
  isShipBranch,
  parseNumstat,
  parsePorcelainStatus,
  parseRepoFullName,
  pushArgs,
  scrubSecrets,
  shipBranchName,
} from "../git";
import { parseUnifiedDiff } from "../diff";

const base = { branch: "shapes/run1", defaultBranch: "main", baseBranch: "main" };

describe("push guard", () => {
  it("allows a plain push of the run's own branch", () => {
    assert.doesNotThrow(() => assertPushAllowed({ ...base, args: {} }));
    assert.doesNotThrow(() => assertPushAllowed({ ...base, args: { branch: "shapes/run1", remote: "origin" } }));
  });

  it("refuses force in every spelling", () => {
    for (const args of [{ force: true }, { force: "true" }, { force_with_lease: true }, { forceWithLease: 1 }, { f: "yes" }]) {
      assert.throws(() => assertPushAllowed({ ...base, args }), /Force-pushing is never allowed/, JSON.stringify(args));
    }
  });

  it("refuses any other ref, the default branch, and a branch outside shapes/", () => {
    assert.throws(() => assertPushAllowed({ ...base, args: { branch: "main" } }), /never pushes to main/);
    assert.throws(() => assertPushAllowed({ ...base, args: { refspec: "HEAD:refs/heads/main" } }), /never pushes/);
    assert.throws(() => assertPushAllowed({ ...base, args: { ref: "refs/heads/shapes/other" } }), /never pushes to shapes\/other/);
    assert.throws(() => assertPushAllowed({ ...base, branch: "main", args: {} }), /Refusing to push to main/);
    assert.throws(() => assertPushAllowed({ ...base, branch: "shapes/x", defaultBranch: "shapes/x", args: {} }), /default branch/);
    assert.throws(() => assertPushAllowed({ ...base, args: { remote: "git@evil:x" } }), /only pushes to the repository/);
  });

  it("builds push / clone argv with no force flag, no '+' refspec and no credentials", () => {
    const p = pushArgs("acme/site", "shapes/run1");
    assert.deepEqual(p.slice(-2), ["https://github.com/acme/site.git", "HEAD:refs/heads/shapes/run1"]);
    assert.ok(!p.some((a) => /^--force|^-f$|^\+/.test(a)));
    assert.throws(() => pushArgs("acme/site", "main"), /Refusing/);
    const c = cloneArgs("acme/site", "main", "/w/site");
    assert.ok(c.includes("https://github.com/acme/site.git"));
    for (const a of [...p, ...c]) assert.ok(!/@github\.com|x-access-token:/.test(a));
    const cfg = authGitConfigArgs();
    assert.equal(cfg[1], "credential.helper=", "repo/global helpers are reset first");
    assert.ok(cfg.includes("core.hooksPath=/dev/null"), "no repo hook sees the token env");
  });

  it("names the branch after the run and recognises only that shape", () => {
    assert.equal(shipBranchName("cmabc123"), "shapes/cmabc123");
    assert.throws(() => shipBranchName("../main"));
    assert.ok(isShipBranch("shapes/cm1"));
    assert.ok(!isShipBranch("shapes/../main"));
    assert.ok(!isShipBranch("main"));
  });
});

describe("helpers", () => {
  it("parses owner/name (and github URLs), refusing anything else", () => {
    assert.deepEqual(parseRepoFullName("acme/site"), { owner: "acme", repo: "site", fullName: "acme/site" });
    assert.equal(parseRepoFullName("https://github.com/acme/site.git").fullName, "acme/site");
    for (const bad of ["acme", "acme/site/x", "-x/site", "acme/..", "https://evil.example/acme/site", 42]) {
      assert.throws(() => parseRepoFullName(bad), Error, String(bad));
    }
  });

  it("scrubs exact secrets and GitHub-token shapes", () => {
    const s = scrubSecrets("token abcdef123456 and ghs_ABCDEFGHIJKLMNOPQRSTUV here", ["abcdef123456"]);
    assert.equal(s, "token [redacted] and [redacted] here");
  });

  it("parses numstat and porcelain status", () => {
    assert.deepEqual(parseNumstat("1\t2\ta.js\n-\t-\timg.png\n"), [
      { path: "a.js", additions: 1, deletions: 2 },
      { path: "img.png", additions: null, deletions: null },
    ]);
    const st = parsePorcelainStatus("## shapes/r1...origin/main [ahead 2]\n M a.js\n?? b.js\n");
    assert.equal(st.branch, "shapes/r1");
    assert.equal(st.ahead, 2);
    assert.deepEqual(st.files.map((f) => f.path), ["a.js", "b.js"]);
  });

  it("caps a stored patch at a line boundary", () => {
    const big = "x".repeat(50) + "\n" + "y".repeat(100) + "\n";
    const c = capPatch(big, 80);
    assert.equal(c.truncated, true);
    assert.equal(c.patch, "x".repeat(50) + "\n");
    assert.deepEqual(capPatch("small\n", 80), { patch: "small\n", truncated: false });
  });
});

describe("review diff parser", () => {
  it("turns a git patch into files, hunks and numbered lines", () => {
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "index 1..2 100644",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+c",
      "diff --git a/n.txt b/n.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/n.txt",
      "@@ -0,0 +1 @@",
      "+new",
      "diff --git a/bin.dat b/bin.dat",
      "new file mode 100644",
      "Binary files /dev/null and b/bin.dat differ",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    assert.deepEqual(files.map((f) => [f.path, f.status, f.additions, f.deletions]), [
      ["f.txt", "modified", 1, 1],
      ["n.txt", "added", 1, 0],
      ["bin.dat", "binary", 0, 0],
    ]);
    assert.deepEqual(files[0]!.hunks[0]!.lines, [
      { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
      { kind: "del", text: "b", oldNo: 2 },
      { kind: "add", text: "c", newNo: 2 },
    ]);
    assert.deepEqual(parseUnifiedDiff(""), []);
  });
});
