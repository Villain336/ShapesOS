// Marketr — workspace filesystem adversarial battery (Phase B, W3, track B1).
//
// Run: DATABASE_URL=... MARKETR_STORAGE_DIR=$(mktemp -d) npx tsx scripts/verify-filesystem.mts
// Run 3x green before calling this done.
//
// Covers THREAT-MODEL.md abuse cases:
//   1. path traversal (encoded, double-encoded, absolute, NUL, backslash)
//   2. IDOR via workspace_id confusion (every op, both directions)
//   3. quota bypass incl. 20-way concurrent upload race
//   4. symlink / storage-key shape attacks on the local adapter
//   5. storage-key guessing (no key-addressed endpoint, no key in serializers)
//   6. trash/restore races + purge-of-live refusal
//   7. XSS on serve (CSP sandbox / nosniff / attachment for active types)
//   8. content-type confusion (polyglot rejected; sniffed mime served)
//   9. /skills write reservation (API allow-list is static-checked)
//  10. quota accounting (write/trash/purge) + purgeExpiredTrash
//  11. upload-safety gate inside writeFile (EICAR, scripted SVG)
//  12. compat read path (legacy .data/attachments + fs: registry refs)

process.env.MARKETR_STORAGE_DIR =
  process.env.MARKETR_STORAGE_DIR ?? `/tmp/marketr-fs-battery-${process.pid}`;
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const { normalizeLogicalPath } = await import("@/lib/filesystem/paths");
const svc = await import("@/lib/filesystem/service");
const { LocalDiskAdapter } = await import("@/lib/filesystem/storage");
const { buildDownloadHeaders, isInlineSafeMime } = await import("@/lib/filesystem/download");
const { validateUploadBuffer } = await import("@/lib/security/upload-safety");
const { prisma } = await import("@/lib/prisma");
const { readAttachmentBytes, deleteAttachmentBytes } = await import("@/lib/filesystem/compat");
const { readFileSync } = await import("node:fs");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function expectFsError(name: string, code: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(name, false, "expected FsError, got success");
  } catch (err) {
    check(name, err instanceof svc.FsError && err.code === code, `got ${err instanceof Error ? err.message : err}`);
  }
}

const txt = (s: string) => Buffer.from(s, "utf8");
const W = { a: "", b: "" };

// ---------------------------------------------------------------- fixtures
async function setup() {
  W.a = (await prisma.workspace.create({ data: { name: `fs-battery-a-${process.pid}`, ownerUserId: "battery" } })).id;
  W.b = (await prisma.workspace.create({ data: { name: `fs-battery-b-${process.pid}`, ownerUserId: "battery" } })).id;
}
async function teardown() {
  await prisma.workspace.deleteMany({ where: { id: { in: [W.a, W.b] } } });
  rmSync(process.env.MARKETR_STORAGE_DIR!, { recursive: true, force: true });
  rmSync(join(process.cwd(), ".data", "attachments", "battery-proj"), { recursive: true, force: true });
  await prisma.$disconnect();
}

// ------------------------------------------------- 1. path traversal (pure)
function sectionTraversal() {
  console.log("1. path traversal");
  const bad = [
    "/files/../../etc/passwd",
    "/files/..%2f..%2fetc%2fpasswd",
    "/files/%252e%252e%252fetc",
    "/etc/shadow",
    "files/relative.txt",
    "/files/..\\windows\\system32",
    "/files/a.txt\0.png",
    "/evil/root.txt",
    "/files/",
    "/files",
    "/files//",
    "/" + "a/".repeat(20) + "deep.txt",
    "/files/" + "x".repeat(600) + ".txt",
    "/files/valid/../../traversal.txt",
  ];
  for (const p of bad) {
    const r = normalizeLogicalPath(p);
    check(`reject ${JSON.stringify(p.slice(0, 40))}`, !r.ok);
  }
  const good = normalizeLogicalPath("/files/reports/q3-2026.pdf");
  check("accept normal path", good.ok && good.kind === "file" && good.path === "/files/reports/q3-2026.pdf");
  check("double-encoded stays inert", (() => {
    const r = normalizeLogicalPath("/files/%252e%252e%252fpwn.txt");
    return !r.ok || !r.path.includes("..");
  })());
  check("double slashes canonicalized", normalizeLogicalPath("/files//a.txt").ok === true);
}

// ------------------------------------------------- 2. IDOR
async function sectionIdor() {
  console.log("2. IDOR via workspace_id confusion");
  const f = await svc.writeFile({
    workspaceId: W.a, logicalPath: "/files/secret.txt", kind: "file",
    bytes: txt("top secret contents"), createdBy: "battery",
  });
  for (const [label, fn] of [
    ["readFile", () => svc.readFile({ workspaceId: W.b, fileId: f.id })],
    ["getFile", () => svc.getFile({ workspaceId: W.b, fileId: f.id })],
    ["renameFile", () => svc.renameFile({ workspaceId: W.b, fileId: f.id, filename: "x.txt" })],
    ["moveFile", () => svc.moveFile({ workspaceId: W.b, fileId: f.id, newPath: "/files/x.txt" })],
    ["trashFile", () => svc.trashFile({ workspaceId: W.b, fileId: f.id })],
    ["restoreFile", () => svc.restoreFile({ workspaceId: W.b, fileId: f.id })],
    ["deleteFile", () => svc.deleteFile({ workspaceId: W.b, fileId: f.id })],
  ] as const) {
    const res = await (async () => {
      try { const v = await fn(); return { ok: true, v }; }
      catch (e) { return { ok: false, e }; }
    })();
    const notFound = res.ok ? res.v === null : res.e instanceof svc.FsError && res.e.code === "not_found";
    check(`cross-workspace ${label} → 404`, notFound);
  }
  const listing = await svc.listDir({ workspaceId: W.b, prefix: "/" });
  check("cross-workspace listDir hides file", listing.files.length === 0 && listing.dirs.length === 0);
  // And the owner's own access still works.
  const own = await svc.readFile({ workspaceId: W.a, fileId: f.id });
  check("owner read works", !!own && own.bytes.toString() === "top secret contents");
  await svc.trashFile({ workspaceId: W.a, fileId: f.id });
  await svc.deleteFile({ workspaceId: W.a, fileId: f.id });
}

// ------------------------------------------------- 3. quota race
async function sectionQuotaRace() {
  console.log("3. quota bypass (20-way concurrent race)");
  await svc.setQuotaLimit({ workspaceId: W.a, limitBytes: 100 });
  const payload = txt("x".repeat(60));
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) =>
      svc.writeFile({
        workspaceId: W.a, logicalPath: `/files/race-${i}.txt`, kind: "file",
        bytes: payload, createdBy: "battery",
      }),
    ),
  );
  const okCount = results.filter((r) => r.status === "fulfilled").length;
  const quotaFails = results.filter(
    (r) => r.status === "rejected" && r.reason instanceof svc.FsError && r.reason.code === "quota_exceeded",
  ).length;
  check("exactly 1 of 20 concurrent writes succeeds", okCount === 1, `ok=${okCount}`);
  check("other 19 fail with quota_exceeded", quotaFails === 19, `quotaFails=${quotaFails}`);
  const q = await svc.getQuota({ workspaceId: W.a });
  check("usedBytes exact (60)", q.usedBytes === 60, `used=${q.usedBytes}`);
  // Clean up race files, restore quota.
  const rows = await prisma.workspaceFile.findMany({ where: { workspaceId: W.a } });
  for (const r of rows) {
    await svc.trashFile({ workspaceId: W.a, fileId: r.id });
    await svc.deleteFile({ workspaceId: W.a, fileId: r.id });
  }
  await svc.setQuotaLimit({ workspaceId: W.a, limitBytes: svc.DEFAULT_QUOTA_BYTES });
}

// ------------------------------------------------- 4. symlink / key shape
async function sectionSymlink() {
  console.log("4. symlink / storage-key shape");
  const root = mkdtempSync(join(tmpdir(), "fs-adapter-"));
  const adapter = new LocalDiskAdapter(root);
  for (const badKey of ["../../etc/passwd", "..", "not-a-uuid", "abc/def", "", "x".repeat(37)]) {
    let threw = false;
    try { await adapter.put(badKey, txt("x"), "text/plain"); } catch { threw = true; }
    check(`adapter rejects key ${JSON.stringify(badKey)}`, threw);
  }
  const key = randomUUID();
  await adapter.put(key, txt("hello"), "text/plain");
  const got = await adapter.get(key);
  check("uuid roundtrip", !!got && got.toString() === "hello");
  check("bytes land inside root", readFileSync(join(root, key)).toString() === "hello");
  // A pre-planted symlink at a UUID target: put() writes via a random temp
  // name + atomic rename, so the symlink itself is replaced, never followed
  // to write outside the root.
  const victim = join(tmpdir(), `fs-victim-${process.pid}.txt`);
  writeFileSync(victim, "victim");
  const key2 = randomUUID();
  const { symlinkSync, readlinkSync, lstatSync } = await import("node:fs");
  symlinkSync(victim, join(root, key2));
  await adapter.put(key2, txt("attacker"), "text/plain");
  check(
    "pre-planted symlink replaced, victim untouched",
    lstatSync(join(root, key2)).isFile() && !lstatSync(join(root, key2)).isSymbolicLink() &&
      readFileSync(victim).toString() === "victim",
    `readlink=${(() => { try { return readlinkSync(join(root, key2)); } catch { return "(not a link)"; } })()}`,
  );
  rmSync(root, { recursive: true, force: true });
  rmSync(victim, { force: true });
}

// ------------------------------------------------- 5. key guessing
async function sectionKeyGuessing() {
  console.log("5. storage-key guessing");
  const f = await svc.writeFile({
    workspaceId: W.a, logicalPath: "/files/guess.txt", kind: "file",
    bytes: txt("guess me"), createdBy: "battery",
  });
  const json = JSON.stringify(f);
  check("public metadata has no storageKey", !json.includes("storageKey"));
  const meta = await svc.getFile({ workspaceId: W.a, fileId: f.id });
  check("getFile has no storageKey", !!meta && !("storageKey" in meta));
  const row = await prisma.workspaceFile.findUnique({ where: { id: f.id } });
  check(
    "stored key is opaque uuid, not filename-derived",
    !!row && /^[0-9a-f-]{36}$/i.test(row.storageKey) && !row.storageKey.includes("guess"),
  );
  const routeSrc = readFileSync("app/api/files/[fileId]/route.ts", "utf8");
  check("no key-addressed route param", !/searchParams\.get\(["']key["']\)/.test(routeSrc));
  await svc.trashFile({ workspaceId: W.a, fileId: f.id });
  await svc.deleteFile({ workspaceId: W.a, fileId: f.id });
}

// ------------------------------------------------- 6. trash/restore races
async function sectionTrashRaces() {
  console.log("6. trash / restore races");
  const f = await svc.writeFile({
    workspaceId: W.a, logicalPath: "/files/race-trash.txt", kind: "file",
    bytes: txt("trash me"), createdBy: "battery",
  });
  const q0 = (await svc.getQuota({ workspaceId: W.a })).usedBytes;
  const t1 = await svc.trashFile({ workspaceId: W.a, fileId: f.id });
  const t2 = await svc.trashFile({ workspaceId: W.a, fileId: f.id });
  check("double trash idempotent", !!t1.trashedAt && !!t2.trashedAt);
  const q1 = (await svc.getQuota({ workspaceId: W.a })).usedBytes;
  check("trashed bytes still count toward quota", q1 === q0);
  // Occupy the original path, then restore must 409.
  const squatter = await svc.writeFile({
    workspaceId: W.a, logicalPath: "/files/race-trash.txt", kind: "file",
    bytes: txt("squatter"), createdBy: "battery",
  });
  const q0b = (await svc.getQuota({ workspaceId: W.a })).usedBytes;
  await expectFsError("restore onto occupied path → conflict", "conflict", () =>
    svc.restoreFile({ workspaceId: W.a, fileId: f.id }),
  );
  // Restore to a free path works.
  const restored = await svc.restoreFile({ workspaceId: W.a, fileId: f.id, newPath: "/files/restored.txt" });
  check("restore to free path", restored.logicalPath === "/files/restored.txt" && !restored.trashedAt);
  // Purge of a live file is refused.
  await expectFsError("purge of live file → invalid_state", "invalid_state", () =>
    svc.deleteFile({ workspaceId: W.a, fileId: squatter.id }),
  );
  const q2 = (await svc.getQuota({ workspaceId: W.a })).usedBytes;
  check("trash→restore leaves quota unchanged", q2 === q0b, `q0b=${q0b} q2=${q2}`);
  // Cleanup: trash + purge both.
  for (const x of [squatter.id, f.id]) {
    await svc.trashFile({ workspaceId: W.a, fileId: x });
    await svc.deleteFile({ workspaceId: W.a, fileId: x });
  }
  const q3 = (await svc.getQuota({ workspaceId: W.a })).usedBytes;
  check("purge decrements quota", q3 === 0, `used=${q3}`);
}

// ------------------------------------------------- 7. XSS on serve
function sectionXss() {
  console.log("7. XSS on serve (download headers)");
  const svg = buildDownloadHeaders("image/svg+xml", "evil.svg");
  check("svg → attachment", svg["content-disposition"].startsWith("attachment;"));
  check("svg → nosniff", svg["x-content-type-options"] === "nosniff");
  check("svg → CSP sandbox", svg["content-security-policy"] === "sandbox");
  const html = buildDownloadHeaders("text/html", "evil.html");
  check("html → attachment", html["content-disposition"].startsWith("attachment;"));
  const png = buildDownloadHeaders("image/png", "pic.png");
  check("png → inline", png["content-disposition"].startsWith("inline;"));
  check("png still sandboxed", png["content-security-policy"] === "sandbox");
  const tricky = buildDownloadHeaders("application/pdf", 'a";\r\nX-Injected: 1');
  check(
    "filename header-injection stripped",
    !/[\r\n]/.test(tricky["content-disposition"]) &&
      /^(inline|attachment); filename="[^"\r\n]*"$/.test(tricky["content-disposition"]),
    tricky["content-disposition"],
  );
  check("only safe mimes inline", !isInlineSafeMime("image/svg+xml") && isInlineSafeMime("application/pdf"));
}

// ------------------------------------------------- 8. content-type confusion
function sectionContentType() {
  console.log("8. content-type confusion");
  // HTML masquerading as JPEG bytes: polyglot/reject expected.
  const polyglot = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    txt("<html><script>alert(1)</script></html>"),
  ]);
  const r = validateUploadBuffer(polyglot, { filename: "evil.jpg", maxBytes: 1024 * 1024, category: "default" });
  check("polyglot html/jpeg rejected at upload", !r.ok, r.ok ? "accepted!" : r.reason);
  // Declared text/html for an image → sniff wins or rejection, never blind trust.
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const r2 = validateUploadBuffer(pngBytes, { filename: "x.html", maxBytes: 1024 * 1024, category: "default" });
  check("png bytes named .html not served as html", !r2.ok || r2.mime !== "text/html");
}

// ------------------------------------------------- 9. /skills reservation
function sectionSkillsReservation() {
  console.log("9. /skills write reservation");
  const src = readFileSync("app/api/files/route.ts", "utf8");
  check(
    "upload API restricted to /files and /memory",
    /API_WRITABLE_ROOTS = \["\/files", "\/memory"\]/.test(src),
  );
  check("threat model documents reservation", readFileSync("lib/filesystem/THREAT-MODEL.md", "utf8").includes("/skills"));
}

// ------------------------------------------------- 10. purgeExpiredTrash
async function sectionPurgeExpired() {
  console.log("10. trash retention purge");
  const f = await svc.writeFile({
    workspaceId: W.a, logicalPath: "/files/old-trash.txt", kind: "file",
    bytes: txt("old"), createdBy: "battery",
  });
  await svc.trashFile({ workspaceId: W.a, fileId: f.id });
  await prisma.workspaceFile.update({
    where: { id: f.id },
    data: { trashedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) },
  });
  const q0 = (await svc.getQuota({ workspaceId: W.a })).usedBytes;
  const { purged } = await svc.purgeExpiredTrash();
  check("expired trash purged", purged >= 1, `purged=${purged}`);
  const gone = await prisma.workspaceFile.findUnique({ where: { id: f.id } });
  check("row deleted", gone === null);
  const q1 = (await svc.getQuota({ workspaceId: W.a })).usedBytes;
  check("quota decremented on purge", q1 === q0 - 3, `q0=${q0} q1=${q1}`);
  // Fresh trash is NOT purged.
  const fresh = await svc.writeFile({
    workspaceId: W.a, logicalPath: "/files/fresh-trash.txt", kind: "file",
    bytes: txt("fresh"), createdBy: "battery",
  });
  await svc.trashFile({ workspaceId: W.a, fileId: fresh.id });
  const { purged: p2 } = await svc.purgeExpiredTrash();
  const stillThere = await prisma.workspaceFile.findUnique({ where: { id: fresh.id } });
  check("fresh trash retained", stillThere !== null, `purged=${p2}`);
  await svc.deleteFile({ workspaceId: W.a, fileId: fresh.id });
}

// ------------------------------------------------- 11. upload-safety gate
async function sectionUploadSafety() {
  console.log("11. upload-safety gate inside writeFile");
  const eicar = txt("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
  await expectFsError("EICAR rejected", "unsafe_content", () =>
    svc.writeFile({ workspaceId: W.a, logicalPath: "/files/eicar.txt", kind: "file", bytes: eicar, createdBy: "battery" }),
  );
  const svg = txt('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await expectFsError("scripted SVG rejected", "unsafe_content", () =>
    svc.writeFile({ workspaceId: W.a, logicalPath: "/files/evil.svg", kind: "file", bytes: svg, createdBy: "battery" }),
  );
  const exe = Buffer.concat([txt("MZ"), Buffer.alloc(100, 0x90)]);
  // Real binaries carry control bytes → unverifiable → rejected.
  const exeBinary = Buffer.concat([exe, Buffer.from([0x00, 0x01, 0x02, 0x1b])]);
  await expectFsError("binary exe rejected as unverifiable", "unsafe_content", () =>
    svc.writeFile({ workspaceId: W.a, logicalPath: "/files/evil.exe", kind: "file", bytes: exeBinary, createdBy: "battery" }),
  );
  // A clean-text buffer named .exe passes the gate as text/plain (extension is
  // never trusted), but the sniffed mime is what gets served — as an
  // attachment, never executed. Assert that serving property, not rejection.
  const exeNamed = await svc.writeFile({
    workspaceId: W.a, logicalPath: "/files/evil.exe", kind: "file", bytes: exe, createdBy: "battery",
  });
  check("exe-named text stored as sniffed text/plain", exeNamed.mimeType === "text/plain", exeNamed.mimeType);
  const exeHeaders = buildDownloadHeaders(exeNamed.mimeType, exeNamed.filename);
  check(
    "exe-named file served as attachment",
    exeHeaders["content-disposition"].startsWith("attachment;"),
  );
  await svc.trashFile({ workspaceId: W.a, fileId: exeNamed.id });
  await svc.deleteFile({ workspaceId: W.a, fileId: exeNamed.id });
  const rows = await prisma.workspaceFile.findMany({ where: { workspaceId: W.a } });
  check("rejected uploads leave no registry rows", rows.length === 0, `rows=${rows.length}`);
}

// ------------------------------------------------- 12. compat read path
async function sectionCompat() {
  console.log("12. compat read path (legacy + fs:)");
  const project = await prisma.project.create({
    data: { id: "battery-proj", workspaceId: W.a, domain: "battery.example" },
  });
  // Legacy row.
  const legacyDir = join(process.cwd(), ".data", "attachments", "battery-proj");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "legacy-uuid.txt"), "legacy bytes");
  const legacy = await prisma.fileAttachment.create({
    data: {
      projectId: project.id, source: "upload", filename: "legacy.txt",
      mimeType: "text/plain", sizeBytes: 12,
      storagePath: ".data/attachments/battery-proj/legacy-uuid.txt",
      uploadedBy: "battery",
    },
  });
  const lb = await readAttachmentBytes({ id: legacy.id, projectId: project.id, storagePath: legacy.storagePath });
  check("legacy .data/attachments row readable", !!lb && lb.toString() === "legacy bytes");
  // Registry row.
  const wf = await svc.writeFile({
    workspaceId: W.a, logicalPath: "/files/chat/battery-proj/new-uuid.txt", kind: "file",
    bytes: txt("registry bytes"), createdBy: "battery",
  });
  const reg = await prisma.fileAttachment.create({
    data: {
      projectId: project.id, source: "upload", filename: "new.txt",
      mimeType: "text/plain", sizeBytes: 14,
      storagePath: `fs:${wf.id}`,
      uploadedBy: "battery",
    },
  });
  const rb = await readAttachmentBytes({ id: reg.id, projectId: project.id, storagePath: reg.storagePath });
  check("fs: registry row readable", !!rb && rb.toString() === "registry bytes");
  // Delete path.
  await deleteAttachmentBytes({ projectId: project.id, storagePath: reg.storagePath });
  const gone = await prisma.workspaceFile.findUnique({ where: { id: wf.id } });
  check("compat delete trash+purges registry file", gone === null);
  await deleteAttachmentBytes({ projectId: project.id, storagePath: legacy.storagePath });
  check("compat delete removes legacy file", (() => { try { readFileSync(join(legacyDir, "legacy-uuid.txt")); return false; } catch { return true; } })());
  await prisma.fileAttachment.deleteMany({ where: { projectId: project.id } });
  await prisma.project.delete({ where: { id: project.id } });
}

// ---------------------------------------------------------------- main
try {
  await setup();
  sectionTraversal();
  await sectionIdor();
  await sectionQuotaRace();
  await sectionSymlink();
  await sectionKeyGuessing();
  await sectionTrashRaces();
  sectionXss();
  sectionContentType();
  sectionSkillsReservation();
  await sectionPurgeExpired();
  await sectionUploadSafety();
  await sectionCompat();
} finally {
  await teardown();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("Failures:", failures.join(", "));
  process.exit(1);
}
