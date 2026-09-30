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
import { OpsInvoiceCard } from "@/components/agents/OpsInvoiceCard";
import { OpsOrderCard } from "@/components/agents/OpsOrderCard";
import { OpsWorkflowRunCard } from "@/components/agents/OpsWorkflowRunCard";

describe("generative component registry (allowlist)", () => {
  it("registers the allowlisted components (approval_card, report_preview, ops cards)", () => {
    // Slice 9 added report_preview; Phase 17 slice 7 adds the ops cards. The
    // registry is designed to grow — the allowlist is still exact.
    assert.deepEqual(Object.keys(GENERATIVE_COMPONENT_REGISTRY).sort(), [
      "approval_card",
      "ops_invoice_card",
      "ops_order_card",
      "ops_workflow_run_card",
      "report_preview",
    ]);
    for (const name of [
      "approval_card",
      "ops_invoice_card",
      "ops_order_card",
      "ops_workflow_run_card",
      "report_preview",
    ]) {
      assert.equal(isRegisteredComponentName(name), true, name);
      assert.equal(assertRegisteredComponentName(name), name, name);
    }
  });

  it("resolves approval_card to the ApprovalCard component", () => {
    assert.equal(resolveGenerativeComponent("approval_card"), ApprovalCard);
  });

  it("resolves the ops cards to their components", () => {
    assert.equal(resolveGenerativeComponent("ops_invoice_card"), OpsInvoiceCard);
    assert.equal(resolveGenerativeComponent("ops_order_card"), OpsOrderCard);
    assert.equal(resolveGenerativeComponent("ops_workflow_run_card"), OpsWorkflowRunCard);
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
