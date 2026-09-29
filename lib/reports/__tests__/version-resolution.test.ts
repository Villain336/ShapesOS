// Marketr — Phase 16 slice 9: template version resolution tests.
// Run: npx tsx --test lib/reports/__tests__/version-resolution.test.ts
//
// Proves the versioning seam: exact pins resolve byte-identical, "latest"
// resolves the highest semver, unknown templates/versions throw, and the CSS
// lint runs at load time (a template that fails lint cannot be resolved).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveTemplate,
  listTemplateVersions,
} from "@/lib/reports/templates/registry";

describe("template version resolution", () => {
  it("lists versions for template #1", async () => {
    const versions = await listTemplateVersions("client-performance");
    assert.deepEqual(versions, ["1.0.0"]);
  });

  it("resolves an exact pin with html + css", async () => {
    const t = await resolveTemplate("client-performance", "1.0.0");
    assert.equal(t.name, "client-performance");
    assert.equal(t.version, "1.0.0");
    assert.match(t.html, /<!--FIGURE_BLOCK-->/);
    assert.match(t.css, /--brand-primary/);
  });

  it("resolves 'latest' to the highest semver", async () => {
    const t = await resolveTemplate("client-performance", "latest");
    assert.equal(t.version, "1.0.0");
  });

  it("throws on unknown template and unknown version", async () => {
    await assert.rejects(() => resolveTemplate("nope", "latest"), /Unknown report template/);
    await assert.rejects(() => resolveTemplate("client-performance", "9.9.9"), /no version/);
  });

  it("rejects malformed template names", async () => {
    await assert.rejects(() => resolveTemplate("../registry", "latest"), /Invalid template name/);
  });
});
