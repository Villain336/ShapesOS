// Marketr — Phase 16 slice 3: generative component allowlist tests.
// Run: npx tsx --test lib/agents/components/__tests__/registry.test.ts
//
// The registry is the allowlist authority: the agent may emit ONLY
// registered names. Unregistered names must be rejected, never rendered.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GENERATIVE_COMPONENT_REGISTRY,
  assertRegisteredComponentName,
  isRegisteredComponentName,
  resolveGenerativeComponent,
} from "../registry";
import { ApprovalCard } from "@/components/agents/ApprovalCard";

describe("generative component registry (allowlist)", () => {
  it("registers the allowlisted components (approval_card, report_preview)", () => {
    // Slice 9 added report_preview; the registry is designed to grow (slice 10
    // adds the mobile subset). The allowlist is still exact — nothing else.
    assert.deepEqual(Object.keys(GENERATIVE_COMPONENT_REGISTRY).sort(), [
      "approval_card",
      "report_preview",
    ]);
    assert.equal(isRegisteredComponentName("approval_card"), true);
    assert.equal(isRegisteredComponentName("report_preview"), true);
  });

  it("resolves approval_card to the ApprovalCard component", () => {
    assert.equal(resolveGenerativeComponent("approval_card"), ApprovalCard);
  });

  it("assert passes registered names through", () => {
    assert.equal(assertRegisteredComponentName("approval_card"), "approval_card");
  });

  it("rejects unregistered component names", () => {
    for (const bad of ["evil_widget", "ApprovalCard", "approval-card", "", "  ", null, undefined, 42, {}]) {
      assert.equal(isRegisteredComponentName(bad), false, `expected ${String(bad)} to be unregistered`);
      assert.throws(
        () => assertRegisteredComponentName(bad),
        /unregistered generative component/,
        `expected ${String(bad)} to throw`,
      );
    }
  });

  it("rejects unregistered names at resolve time (render path)", () => {
    assert.throws(() => resolveGenerativeComponent("not_a_component"), /unregistered generative component/);
  });
});
