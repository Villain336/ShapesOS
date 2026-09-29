// Marketr — Phase 16 slice 9: report_preview registry tests.
// Run: npx tsx --test lib/reports/__tests__/report-preview-registry.test.ts
//
// Proves `report_preview` joined the allowlist (slice-3 authority) and that
// unregistered names are still rejected — the agent can emit report previews
// and nothing else.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GENERATIVE_COMPONENT_REGISTRY,
  isRegisteredComponentName,
  assertRegisteredComponentName,
  resolveGenerativeComponent,
} from "@/lib/agents/components/registry";

describe("report_preview registration", () => {
  it("report_preview is on the allowlist with a model-facing description", () => {
    assert.ok(isRegisteredComponentName("report_preview"));
    assert.match(
      GENERATIVE_COMPONENT_REGISTRY.report_preview.description,
      /approve, deny, or edit/,
    );
    assert.match(GENERATIVE_COMPONENT_REGISTRY.report_preview.description, /approvalId/);
  });

  it("resolves to a React component", () => {
    const Component = resolveGenerativeComponent("report_preview");
    assert.equal(typeof Component, "function");
  });

  it("unregistered names are still rejected, never rendered", () => {
    assert.equal(isRegisteredComponentName("report_pdf"), false);
    assert.throws(() => assertRegisteredComponentName("report_pdf"), /unregistered generative component/);
  });
});
