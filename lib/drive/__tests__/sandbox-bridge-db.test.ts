// ShapesOS — Phase 21B (WS=drive): the Drive <-> sandbox bridge against Postgres (app
// role) and the FAKE sandbox engine (LocalDirSandbox runs commands in a temp dir on this
// machine; there is no Docker here, so real container runs are UNVERIFIED-LIVE).
//   - mount copies a folder into <workdir>/workspace; sync-out brings back new files
//   - an agent's sync never overwrites: changed files are staged for a person
//   - a person's sync writes new versions; nothing is ever deleted
//   - symlinks, bad names, big files and tampered markers are refused / skipped
//   - the Terminal's upload / download bridge uses the person's own rights
// Run: DATABASE_URL=<app role url> npx tsx --test lib/drive/__tests__/sandbox-bridge-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "p21b-bridge-"));
process.env.MARKETR_STORAGE = "local";
process.env.MARKETR_STORAGE_DIR = DIR;
delete process.env.DEPLOYMENT_MODE;
delete process.env.CLAMAV_HOST;

import { prisma } from "@/lib/prisma";
import { writeFile } from "@/lib/filesystem/service";
import { listFileVersions } from "@/lib/filesystem/versions";
import { resetStorageAdapterForTests } from "@/lib/filesystem/storage";
import { LocalDirSandbox } from "@/lib/sandbox/__tests__/fakes";
import { createFolderAs } from "@/lib/drive/ops";
import { MOUNT_DIR, applyStaged, downloadFromSandbox, mountFolder, syncOut, uploadToSandbox } from "@/lib/drive/sandbox-bridge";

const RUN = randomUUID().slice(0, 8);
const WS = `p21s-${RUN}`;
const ED = `p21s-ed-${RUN}`;
const OTHER = `p21s-other-${RUN}`;
const ed = { workspaceId: WS, userId: ED, role: "editor" as const };
const grant = { runId: `run-${RUN}`, folders: ["/shared/Project"] };

const text = (s: string) => Buffer.from(s, "utf8");
const mk = (p: string, body: string) => writeFile({ workspaceId: WS, logicalPath: p, kind: "file", bytes: text(body), createdBy: ED, mimeType: "text/plain" });

let sb: LocalDirSandbox;
const mountDir = () => join(sb.workdir, MOUNT_DIR);

before(async () => {
  resetStorageAdapterForTests();
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ED } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ED, role: "editor", email: `ed-${RUN}@example.test`, name: "Ed" },
      { workspaceId: WS, userId: OTHER, role: "editor", email: `ot-${RUN}@example.test`, name: "Other" },
    ],
  });
  await createFolderAs(ed, "/shared/Project");
  await createFolderAs(ed, "/shared/Elsewhere");
  await mk("/shared/Project/readme.md", "# project\n");
  await mk("/shared/Project/data/numbers.csv", "a,b\n1,2\n");
  await mk("/shared/Elsewhere/secret.txt", "not in the grant");
  await mk(`/home/${OTHER}/private.txt`, "someone else's");
});
after(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
  rmSync(DIR, { recursive: true, force: true });
});

describe("mount", () => {
  it("copies a Drive folder into <workdir>/workspace, nested files included, and records the starting hashes", async () => {
    sb = new LocalDirSandbox("run-bridge");
    const m = await mountFolder({ sandbox: sb, actor: ed, folder: "/shared/Project", grant });
    assert.equal(m.files, 2);
    assert.equal(readFileSync(join(mountDir(), "readme.md"), "utf8"), "# project\n");
    assert.equal(readFileSync(join(mountDir(), "data/numbers.csv"), "utf8"), "a,b\n1,2\n");
    const marker = JSON.parse(readFileSync(join(mountDir(), ".shapes-mount.json"), "utf8"));
    assert.equal(marker.folder, "/shared/Project");
    assert.deepEqual(Object.keys(marker.baseline).sort(), ["data/numbers.csv", "readme.md"]);
  });

  it("refuses a folder outside the run's grant, someone else's home, and a folder the person cannot see", async () => {
    const other = new LocalDirSandbox("run-x");
    await assert.rejects(() => mountFolder({ sandbox: other, actor: ed, folder: "/shared/Elsewhere", grant }), /outside the folders/);
    await assert.rejects(() => mountFolder({ sandbox: other, actor: ed, folder: `/home/${OTHER}`, grant: { runId: "r", folders: [`/home/${OTHER}`] } }), /not found/i);
    await other.destroy();
  });
});

describe("agent sync: creates freely inside its grant, never overwrites", () => {
  it("creates new files, stages changed ones for a person, skips unchanged, symlinks and bad names", async () => {
    writeFileSync(join(mountDir(), "readme.md"), "# project, edited by the agent\n"); // changed
    mkdirSync(join(mountDir(), "out"), { recursive: true });
    writeFileSync(join(mountDir(), "out/result.txt"), "result\n"); // new
    writeFileSync(join(mountDir(), "CON.txt"), "reserved"); // bad name
    writeFileSync(join(mountDir(), "bad:name.txt"), "bad char");
    symlinkSync("/etc/passwd", join(mountDir(), "link-to-passwd")); // symlink
    const rep = await syncOut({ sandbox: sb, actor: ed, mode: "agent", grant });
    assert.deepEqual(rep.created.map((c) => c.path), ["/shared/Project/out/result.txt"]);
    assert.deepEqual(rep.updated, [], "an agent's sync never writes over an existing file");
    assert.equal(rep.staged.length, 1);
    assert.equal(rep.staged[0]!.path, "/shared/Project/readme.md");
    assert.match(rep.staged[0]!.stagedPath, new RegExp(`^/agents/run-${RUN}/proposed/`));
    assert.equal(rep.unchanged, 1);
    const skippedNames = rep.skipped.map((s) => s.path).sort();
    assert.deepEqual(skippedNames, ["CON.txt", "bad:name.txt", "link-to-passwd"].sort());
    assert.match(rep.skipped.find((s) => s.path === "link-to-passwd")!.reason, /symbolic links/);
    // The original is untouched.
    const orig = await prisma.workspaceFile.findFirstOrThrow({ where: { workspaceId: WS, logicalPath: "/shared/Project/readme.md" } });
    assert.equal(orig.version, 1);
    assert.deepEqual(rep.touched.map((t) => [t.op, t.id]), [["create", rep.created[0]!.fileId]]);
  });

  it("a person applies the staged proposal: the original gets a new version, the staging copy goes to the Trash", async () => {
    const staged = await prisma.workspaceFile.findFirstOrThrow({ where: { workspaceId: WS, logicalPath: { startsWith: `/agents/run-${RUN}/proposed/` } } });
    const r = await applyStaged(ed, staged.id);
    assert.equal(r.version, 2);
    const orig = await prisma.workspaceFile.findFirstOrThrow({ where: { workspaceId: WS, logicalPath: "/shared/Project/readme.md" } });
    assert.deepEqual((await listFileVersions(WS, orig.id))!.map((v) => v.version), [2, 1]);
    assert.ok((await prisma.workspaceFile.findFirstOrThrow({ where: { id: staged.id } })).trashedAt);
    await assert.rejects(() => applyStaged(ed, staged.id), /not a staged proposal/i);
  });

  it("a tampered marker cannot point the sync at a folder outside the grant", async () => {
    writeFileSync(join(mountDir(), ".shapes-mount.json"), JSON.stringify({ v: 1, folder: "/shared/Elsewhere", baseline: {} }));
    writeFileSync(join(mountDir(), "evil.txt"), "should not land");
    const rep = await syncOut({ sandbox: sb, actor: ed, mode: "agent", grant });
    assert.deepEqual(rep.created, []);
    assert.match(rep.skipped[0]!.reason, /not inside what the run was given/);
    assert.equal(await prisma.workspaceFile.count({ where: { workspaceId: WS, logicalPath: "/shared/Elsewhere/evil.txt" } }), 0);
  });

  it("an agent sync with no grant is refused outright", async () => {
    await assert.rejects(() => syncOut({ sandbox: sb, actor: ed, mode: "agent" }), /needs the run's grant/);
  });
});

describe("person sync", () => {
  it("writes changed files as new versions and never deletes what was removed in the sandbox", async () => {
    const p = new LocalDirSandbox("run-person");
    await mountFolder({ sandbox: p, actor: ed, folder: "/shared/Project" });
    const dir = join(p.workdir, MOUNT_DIR);
    writeFileSync(join(dir, "data/numbers.csv"), "a,b\n1,2\n3,4\n");
    rmSync(join(dir, "readme.md"));
    const rep = await syncOut({ sandbox: p, actor: ed, mode: "person" });
    assert.deepEqual(rep.updated.map((u) => [u.path, u.version]), [["/shared/Project/data/numbers.csv", 2]]);
    assert.deepEqual(rep.removedInSandbox, ["readme.md"]);
    assert.ok(await prisma.workspaceFile.findFirst({ where: { workspaceId: WS, logicalPath: "/shared/Project/readme.md", trashedAt: null } }), "left in Drive");
    assert.equal(rep.touched[0]!.op, "update");
    await p.destroy();
  });

  it("a person cannot sync into a folder they cannot write (the sync uses their rights)", async () => {
    const o = new LocalDirSandbox("run-other");
    await prisma.workspaceFolder.findFirst({ where: { workspaceId: WS } }).catch(() => null);
    // OTHER is an editor, but the marker points at ED's private home.
    await o.exec(["mkdir", "-p", join(o.workdir, MOUNT_DIR)]);
    writeFileSync(join(o.workdir, MOUNT_DIR, ".shapes-mount.json"), JSON.stringify({ v: 1, folder: `/home/${ED}`, baseline: {} }));
    writeFileSync(join(o.workdir, MOUNT_DIR, "x.txt"), "x");
    const rep = await syncOut({ sandbox: o, actor: { workspaceId: WS, userId: OTHER, role: "editor" }, mode: "person" });
    assert.deepEqual(rep.created, []);
    assert.equal(rep.skipped.length, 1);
    await o.destroy();
  });
});

describe("terminal upload / download", () => {
  it("uploads a Drive file the person can read, and refuses ones they cannot see", async () => {
    const t = new LocalDirSandbox("run-term");
    const up = await uploadToSandbox({ sandbox: t, actor: ed, drivePath: "/shared/Project/data/numbers.csv" });
    assert.equal(readFileSync(up.sandboxPath, "utf8"), "a,b\n1,2\n3,4\n");
    await assert.rejects(() => uploadToSandbox({ sandbox: t, actor: ed, drivePath: `/home/${OTHER}/private.txt` }), /not found/i);
    await t.destroy();
  });

  it("downloads a sandbox file into Drive as the person: a new file, then a version with overwrite; symlinks refused", async () => {
    const t = new LocalDirSandbox("run-term2");
    writeFileSync(join(t.workdir, "report.txt"), "from the terminal");
    const first = await downloadFromSandbox({ sandbox: t, actor: ed, sandboxPath: "report.txt", driveDir: "/shared/Project" });
    assert.equal(first.created, true);
    await assert.rejects(() => downloadFromSandbox({ sandbox: t, actor: ed, sandboxPath: "report.txt", driveDir: "/shared/Project" }), /already exists/);
    writeFileSync(join(t.workdir, "report.txt"), "second run");
    const again = await downloadFromSandbox({ sandbox: t, actor: ed, sandboxPath: "report.txt", driveDir: "/shared/Project", overwrite: true });
    assert.deepEqual([again.created, again.version], [false, 2]);
    symlinkSync("/etc/passwd", join(t.workdir, "pw"));
    await assert.rejects(() => downloadFromSandbox({ sandbox: t, actor: ed, sandboxPath: "pw", driveDir: "/shared/Project" }), /not a regular file/);
    await assert.rejects(() => downloadFromSandbox({ sandbox: t, actor: ed, sandboxPath: "../../etc/passwd", driveDir: "/shared/Project" }), /outside the sandbox/);
    await t.destroy();
  });
});
