// ShapesOS — Phase 21B (WS=drive): path rules for the generalised roots (unit).
// Run: npx tsx --test lib/filesystem/__tests__/paths-drive.test.ts
//
// Expected values are literals from the spec (brief "Safety hardening"), never
// recomputed with the code under test.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collisionKey,
  displayPath,
  folderChain,
  normalizeDrivePath,
  normalizeFolderPath,
  normalizeLogicalPath,
  sanitizeUploadName,
} from "../paths";

function ok(input: string) {
  const r = normalizeDrivePath(input);
  assert.ok(r.ok, `expected ${JSON.stringify(input)} to be accepted, got ${r.ok ? "" : r.reason}`);
  return r;
}
function bad(input: string, re?: RegExp) {
  const r = normalizeDrivePath(input);
  assert.ok(!r.ok, `expected ${JSON.stringify(input)} to be rejected`);
  if (!r.ok && re) assert.match(r.reason, re);
}

describe("roots", () => {
  it("keeps the four legacy roots exactly as before", () => {
    const r = ok("/files/reports/q3.pdf");
    assert.equal(r.path, "/files/reports/q3.pdf");
    assert.equal(r.root, "/files");
    assert.equal(r.kind, "file");
    assert.equal(ok("/skills/a.md").kind, "skill");
    assert.equal(ok("/memory/a.md").kind, "memory");
    assert.equal(ok("/artifacts/a.md").kind, "artifact");
  });

  it("shows the legacy roots under /shared and accepts that spelling as the same file", () => {
    const r = ok("/shared/files/reports/q3.pdf");
    assert.equal(r.path, "/files/reports/q3.pdf", "one canonical spelling, so no duplicate rows");
    assert.equal(r.root, "/files");
    assert.equal(displayPath("/files/reports/q3.pdf"), "/shared/files/reports/q3.pdf");
    assert.equal(displayPath("/shared/notes/a.txt"), "/shared/notes/a.txt");
    assert.equal(displayPath("/home/u1/a.txt"), "/home/u1/a.txt");
  });

  it("parses /home/<userId> as the private home of that user", () => {
    const r = ok("/home/cm1abc/Taxes 2025/return.pdf");
    assert.equal(r.root, "/home");
    assert.equal(r.ownerUserId, "cm1abc");
    assert.equal(r.kind, "file");
    assert.equal(r.path, "/home/cm1abc/Taxes 2025/return.pdf");
    bad("/home/a.txt", /home/i); // a file directly in /home has no owner
    bad("/home/u1", /name a file/i);
  });

  it("parses /shared, /apps/<app>/<install>, /agents/<run>, /mounts/<provider>", () => {
    assert.equal(ok("/shared/Marketing/plan.docx").ownerUserId, null);
    const app = ok("/apps/crm-lite/inst_1/data/a.json");
    assert.deepEqual(app.app, { appId: "crm-lite", install: "inst_1" });
    assert.equal(ok("/agents/run_9/out.csv").runId, "run_9");
    assert.equal(ok("/mounts/google-drive/Docs/a.gdoc").provider, "google-drive");
  });

  it("refuses unapproved mount providers and the trash root as a write target", () => {
    bad("/mounts/onedrive/a.txt", /provider/i);
    bad("/mounts/dropbox/a.txt", /provider/i);
    bad("/trash/a.txt", /trash/i);
    bad("/etc/passwd", /must live under/i);
  });

  it("accepts container paths as folders but not as files", () => {
    const f = normalizeFolderPath("/apps/crm-lite/inst_1");
    assert.ok(f.ok);
    assert.ok(normalizeFolderPath("/files").ok);
    assert.ok(normalizeFolderPath("/home/u1").ok);
    assert.ok(normalizeFolderPath("/shared").ok);
    assert.ok(!normalizeFolderPath("/").ok);
    assert.ok(!normalizeFolderPath("/apps").ok, "/apps alone is not a container");
    bad("/apps/crm-lite/inst_1");
  });
});

describe("hardening: traversal", () => {
  it("rejects .. and . segments in every root, raw and percent-encoded", () => {
    bad("/shared/../home/u1/a.txt", /\.\./);
    bad("/home/u1/../u2/a.txt", /\.\./);
    bad("/shared/docs/./a.txt", /\./);
    bad("/files/%2e%2e/etc/passwd", /\.\./);
    bad("/files/a/..%2fb");
  });
  it("never decodes twice: a double-encoded dot stays encoded and is refused as a name", () => {
    bad("/files/%252e%252e", /letters, numbers/i);
  });
  it("keeps a literal percent sign as a plain character under the new roots", () => {
    assert.equal(ok("/shared/100% done.txt").path, "/shared/100% done.txt");
  });
  it("rejects backslashes, NUL and relative paths", () => {
    bad("/shared/a\\b.txt");
    bad("/shared/a\0b.txt");
    bad("shared/a.txt", /start with/i);
    bad("");
  });
  it("rejects a home that lies about its owner id", () => {
    bad("/home/..%2fu2/a.txt");
    bad("/home/u 1/a.txt");
  });
});

describe("hardening: Windows and portability", () => {
  it("rejects reserved device names, with or without an extension, any case", () => {
    for (const n of ["CON", "con", "PRN", "AUX", "NUL", "COM1", "com9", "LPT1", "lpt9", "con.txt", "NUL.tar.gz", "Aux.md"]) {
      bad(`/shared/${n}`, /reserved/i);
    }
    ok("/shared/console.txt");
    ok("/shared/COM10.txt");
    ok("/shared/CONSOLE");
  });
  it("rejects names Windows cannot store: trailing dot or space, forbidden characters", () => {
    bad("/shared/report.", /end/i);
    bad("/shared/report ", /end/i);
    bad("/shared/ report.txt", /start/i);
    for (const ch of ["<", ">", ":", '"', "|", "?", "*"]) bad(`/shared/a${ch}b.txt`, /character/i);
  });
  it("allows dotfiles, spaces inside names, parentheses and unicode letters", () => {
    ok("/shared/.gitignore");
    ok("/shared/Q3 report (final).pdf");
    ok("/shared/Résumé.pdf");
    ok("/shared/日本語.txt");
  });
  it("rejects control characters and bidi/zero-width spoofing", () => {
    bad("/shared/a\u0007b.txt", /character/i);
    bad("/shared/a‮txt.exe", /character/i);
    bad("/shared/a​b.txt", /character/i);
    bad("/shared/﻿a.txt", /character/i);
  });
});

describe("hardening: Unicode normalisation and case", () => {
  it("normalises names to NFC", () => {
    const decomposed = "/shared/Café.txt"; // e + combining acute
    const r = ok(decomposed);
    assert.equal(r.path, "/shared/Café.txt");
    assert.equal(r.path.length, "/shared/Café.txt".length);
  });
  it("two names differing only by case or normalisation share one collision key", () => {
    assert.equal(collisionKey("/shared/Report.PDF"), collisionKey("/shared/report.pdf"));
    assert.equal(collisionKey("/shared/Café.txt"), collisionKey("/shared/CAFÉ.TXT"));
    assert.notEqual(collisionKey("/shared/a.txt"), collisionKey("/shared/b.txt"));
    assert.notEqual(collisionKey("/shared/a/b.txt"), collisionKey("/shared/a_b.txt"));
  });
  it("legacy roots keep their strict character set", () => {
    bad("/files/my report.pdf", /letters, numbers/i);
    bad("/files/Résumé.pdf", /letters, numbers/i);
  });
});

describe("hardening: length and depth", () => {
  it("caps a name at 255 bytes of UTF-8", () => {
    ok(`/shared/${"a".repeat(255)}`);
    bad(`/shared/${"a".repeat(256)}`, /too long/i);
    bad(`/shared/${"é".repeat(128)}`, /too long/i); // 256 bytes
    ok(`/shared/${"é".repeat(127)}`); // 254 bytes
  });
  it("caps the whole path at 1024 characters and depth at 32 folders", () => {
    const seg = "d".repeat(100);
    bad(`/shared/${Array(11).fill(seg).join("/")}/a.txt`, /too long/i);
    ok(`/shared/${Array(30).fill("d").join("/")}/a.txt`);
    bad(`/shared/${Array(32).fill("d").join("/")}/a.txt`, /depth/i);
  });
  it("legacy paths keep the 512 limit", () => {
    bad(`/files/${"a".repeat(120)}/${"b".repeat(120)}/${"c".repeat(120)}/${"d".repeat(120)}/${"e".repeat(120)}`, /too long/i);
  });
});

describe("normalizeLogicalPath compatibility", () => {
  it("is the same function the existing callers use and still returns the legacy shape", () => {
    const r = normalizeLogicalPath("/files/a/b.txt");
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual([r.path, r.root, r.kind], ["/files/a/b.txt", "/files", "file"]);
    const w = normalizeLogicalPath("/files");
    assert.ok(!w.ok);
    if (!w.ok) assert.equal(w.reason, "Path must name a file, not a root.");
  });
});

describe("sanitizeUploadName", () => {
  it("turns an arbitrary browser file name into one the rules accept", () => {
    assert.equal(sanitizeUploadName("report: final?.pdf"), "report_ final_.pdf");
    assert.equal(sanitizeUploadName("CON.txt"), "_CON.txt");
    assert.equal(sanitizeUploadName("  spaced name.  "), "spaced name");
    assert.equal(sanitizeUploadName("..\\..\\evil.txt"), "evil.txt");
    assert.equal(sanitizeUploadName(""), "file");
    assert.equal(sanitizeUploadName("a/b/c.txt"), "c.txt");
  });
});

describe("folderChain (which folders exist as rows above a path)", () => {
  it("lists the materialised folders from the top, marking containers as system", () => {
    assert.deepEqual(folderChain("/files/reports/q3"), [
      { path: "/files", system: true },
      { path: "/files/reports", system: false },
      { path: "/files/reports/q3", system: false },
    ]);
    assert.deepEqual(folderChain("/shared/Marketing/plans"), [
      { path: "/shared/Marketing", system: false },
      { path: "/shared/Marketing/plans", system: false },
    ]);
    assert.deepEqual(folderChain("/home/u1/Taxes"), [
      { path: "/home/u1", system: true },
      { path: "/home/u1/Taxes", system: false },
    ]);
    assert.deepEqual(folderChain("/apps/crm/i1/data"), [
      { path: "/apps/crm/i1", system: true },
      { path: "/apps/crm/i1/data", system: false },
    ]);
    assert.deepEqual(folderChain("/agents/r1"), [{ path: "/agents/r1", system: true }]);
    assert.deepEqual(folderChain("/mounts/google-drive/Docs"), [
      { path: "/mounts/google-drive", system: true },
      { path: "/mounts/google-drive/Docs", system: false },
    ]);
  });
  it("has nothing for the virtual tops themselves", () => {
    assert.deepEqual(folderChain("/shared"), []);
    assert.deepEqual(folderChain("/home"), []);
    assert.deepEqual(folderChain("/apps/crm"), []);
  });
});
