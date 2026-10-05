// Phase 3 (L): security-related settings UI.
// Run: npx tsx --test components/settings/__tests__/operator-controls.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseToolNames } from "../McpReadOnlyToolsEditor";

const src = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

describe("MCP read-only allow-list editor", () => {
  it("splits commas / whitespace / newlines and drops empties and over-long names", () => {
    assert.deepEqual(parseToolNames(" search_docs, get_record\nlist  "), ["search_docs", "get_record", "list"]);
    assert.deepEqual(parseToolNames(" , \n "), []);
    assert.deepEqual(parseToolNames("x".repeat(201)), []);
  });

  it("is mounted only on the admin-gated connectors page", () => {
    const page = src("app/dashboard/settings/connectors/page.tsx");
    assert.match(page, /requireWorkspaceRole\(user\.id, workspace\.id, "admin"\)/);
    assert.match(src("components/settings/ConnectorsManager.tsx"), /<McpReadOnlyToolsEditor/);
  });
});

describe("operator-only controls are decided on the server", () => {
  it("Knowledge Brain: corpus management only for platform operators", () => {
    const page = src("app/dashboard/intelligence/corpus/brain/page.tsx");
    assert.match(page, /const canManage = isPlatformOperator\(\{ id: user\.id, email: user\.email \}\)/);
    assert.doesNotMatch(page, /\["owner", "admin", "editor"\]\.includes/);
  });

  it("Providers: Activepieces flow bindings only for platform operators", () => {
    const page = src("app/dashboard/settings/providers/page.tsx");
    assert.match(page, /const operator = isPlatformOperator\(\{ id: user\.id, email: user\.email \}\)/);
    assert.match(page, /operator && \(\s*<ActivepiecesFlowBindings/);
  });
});
