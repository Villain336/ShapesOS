// Marketr — Knowledge Brain: ingest honors removal flags.
// Run: npx tsx --test lib/intelligence/corpus/__tests__/ingest-removals.test.ts
// Runs scripts/ingest-corpus.mts --dry-run against a temp CORPUS_DIR with one
// source flagged. The flagged source must be excluded (✕ removal-flagged)
// while unflagged sources proceed normally — and nothing is written outside
// the temp dir.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(__dirname, "..", "..", "..", "..");
const FLAGGED = "google-search-central"; // real Tier 1 registry id
let tmp = "";

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brain-ingest-"));
  fs.writeFileSync(
    path.join(tmp, "removals.json"),
    JSON.stringify({
      [FLAGGED]: { reason: "license revoked", flaggedAt: "2026-09-26T00:00:00Z", flaggedBy: "tester@example.com" },
    }),
  );
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ingest-corpus.mts --dry-run with a removal flag", () => {
  it("excludes the flagged source; unflagged sources proceed; temp dir only", { timeout: 120_000 }, () => {
    const stdout = execFileSync("npx", ["tsx", "scripts/ingest-corpus.mts", "--dry-run"], {
      cwd: REPO,
      env: { ...process.env, CORPUS_DIR: tmp },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const flaggedLine = stdout.split("\n").find((l) => l.includes(FLAGGED));
    assert.ok(flaggedLine, "flagged source appears in run log");
    assert.ok(flaggedLine.includes("✕") && flaggedLine.includes("removal-flagged"), `excluded: ${flaggedLine}`);

    // Unflagged sources still flow through normally.
    assert.ok(stdout.includes("✓") || stdout.includes("~"), "unflagged sources processed");

    // Nothing was written to the temp corpus dir besides removals.json
    // (dry-run performs no writes — the flag path is verified via the log).
    assert.deepEqual(fs.readdirSync(tmp).sort(), ["removals.json"]);
  });
});
