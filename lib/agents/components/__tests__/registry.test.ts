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
  it("registers approval_card as the first (and only) component", () => {
    assert.deepEqual(Object.keys(GENERATIVE_COMPONENT_REGISTRY), ["approval_card"]);
    assert.equal(isRegisteredComponentName("approval_card"), true);
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
