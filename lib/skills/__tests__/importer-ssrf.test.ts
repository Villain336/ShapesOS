// Phase 1 (untrusted content): skill URL import is SSRF-guarded by default.
// Run: npx tsx --test lib/skills/__tests__/importer-ssrf.test.ts
// No network: every target is an IP literal the guard refuses before DNS.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { previewFromUrl, SkillImportError } from "../importer";

describe("previewFromUrl default fetch", () => {
  for (const url of [
    "http://169.254.169.254/latest/SKILL.md",
    "http://[::ffff:7f00:1]:3000/SKILL.md",
    "http://10.0.0.8/team/SKILL.md",
    "http://100.100.100.200/SKILL.md",
  ]) {
    it(`refuses ${url}`, async () => {
      await assert.rejects(previewFromUrl(url), (e: unknown) => {
        assert.ok(e instanceof SkillImportError);
        assert.match((e as Error).message, /disallowed address/);
        return true;
      });
    });
  }

  it("ignores the E2E seam for non-fixture paths", async () => {
    const prev = process.env.E2E_MOCK_OAUTH;
    process.env.E2E_MOCK_OAUTH = "1";
    try {
      await assert.rejects(previewFromUrl("http://127.0.0.1:3000/private/SKILL.md"), /disallowed address/);
    } finally {
      if (prev === undefined) delete process.env.E2E_MOCK_OAUTH;
      else process.env.E2E_MOCK_OAUTH = prev;
    }
  });
});
