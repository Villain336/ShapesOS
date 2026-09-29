// Marketr — Phase 16 slice 3: gate round-trip tests.
// Run: npx tsx --test lib/agents/components/__tests__/gate-roundtrip.test.ts
//
// Proves the generative approval card's actions execute through the Phase 14
// gate's OWN service functions (same code path as the existing API routes):
//  - approve/deny/edit land on the right item id with the right transition,
//  - an audit entry is written per action (via the gate's auditAutopilot).
//
// The real service functions run against a stub db — no live database.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PrismaClient } from "@prisma/client";
import {
  approveAutopilotItem,
  editAutopilotItem,
  rejectAutopilotItem,
} from "@/lib/seo/autopilot-service";

interface Captured {
  updates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  audits: Array<{ action: string; summary: string }>;
}

function stubDb(item: Record<string, unknown>, captured: Captured): PrismaClient {
  return {
    autopilotItem: {
      findFirst: async () => ({ ...item }),
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        captured.updates.push(args);
        return args;
      },
    },
    autopilotKillSwitch: {
      findMany: async () => [],
    },
    fileChangeLog: {
      create: async (args: { data: { action: string; summary: string } }) => {
        captured.audits.push({ action: args.data.action, summary: args.data.summary });
        return args;
      },
    },
  } as unknown as PrismaClient;
}

const BASE_ARGS = { workspaceId: "ws-1", projectId: "proj-1", itemId: "item-1", actor: "user-1" };

function pendingItem(): Record<string, unknown> {
  return {
    id: "item-1",
    projectId: "proj-1",
    status: "pending",
    title: "Original title",
    sourceRef: "keyword:kw-1",
    rule: { id: "rule-1", name: "Test rule", publishTarget: null },
  };
}

describe("approval card → gate round-trip", () => {
  it("approve calls the gate with the right item id and writes an audit entry", async () => {
    const captured: Captured = { updates: [], audits: [] };
    await approveAutopilotItem(stubDb(pendingItem(), captured), BASE_ARGS);
    assert.equal(captured.updates.length, 1);
    assert.equal(captured.updates[0].where.id, "item-1");
    assert.equal(captured.updates[0].data.status, "approved");
    assert.equal(captured.audits.length, 1);
    assert.equal(captured.audits[0].action, "autopilot_item_approved");
    assert.match(captured.audits[0].summary, /Original title/);
  });

  it("deny calls the gate with the right item id, note, and audit entry", async () => {
    const captured: Captured = { updates: [], audits: [] };
    await rejectAutopilotItem(stubDb(pendingItem(), captured), { ...BASE_ARGS, note: "not on brand" });
    assert.equal(captured.updates.length, 1);
    assert.equal(captured.updates[0].where.id, "item-1");
    assert.equal(captured.updates[0].data.status, "rejected");
    assert.equal(captured.updates[0].data.reviewNote, "not on brand");
    assert.equal(captured.audits.length, 1);
    assert.equal(captured.audits[0].action, "autopilot_item_rejected");
  });

  it("edit updates editable fields, keeps the item pending, and audits", async () => {
    const captured: Captured = { updates: [], audits: [] };
    await editAutopilotItem(stubDb(pendingItem(), captured), {
      ...BASE_ARGS,
      title: "New title",
      draftMarkdown: "# New draft",
    });
    assert.equal(captured.updates.length, 1);
    assert.equal(captured.updates[0].where.id, "item-1");
    assert.equal(captured.updates[0].data.title, "New title");
    assert.equal(captured.updates[0].data.draftMarkdown, "# New draft");
    assert.equal(captured.updates[0].data.status, "pending", "edit must requeue as pending");
    assert.equal(captured.audits.length, 1);
    assert.equal(captured.audits[0].action, "autopilot_item_edited");
    assert.match(captured.audits[0].summary, /title \+ draft/);
  });

  it("edit with only a title still writes an audit entry", async () => {
    const captured: Captured = { updates: [], audits: [] };
    await editAutopilotItem(stubDb(pendingItem(), captured), { ...BASE_ARGS, title: "Title only" });
    assert.equal(captured.updates[0].data.title, "Title only");
    assert.ok(!("draftMarkdown" in captured.updates[0].data));
    assert.equal(captured.audits[0].action, "autopilot_item_edited");
  });

  it("gate status guards hold: cannot approve a rejected item", async () => {
    const captured: Captured = { updates: [], audits: [] };
    const item = { ...pendingItem(), status: "rejected" };
    await assert.rejects(() => approveAutopilotItem(stubDb(item, captured), BASE_ARGS), /cannot be approved/);
    assert.equal(captured.updates.length, 0, "no update on failed gate transition");
    assert.equal(captured.audits.length, 0, "no audit on failed gate transition");
  });

  it("gate status guards hold: cannot edit a non-pending item", async () => {
    const captured: Captured = { updates: [], audits: [] };
    const item = { ...pendingItem(), status: "approved" };
    await assert.rejects(
      () => editAutopilotItem(stubDb(item, captured), { ...BASE_ARGS, title: "x" }),
      /cannot be edited/,
    );
    assert.equal(captured.updates.length, 0);
    assert.equal(captured.audits.length, 0);
  });

  it("edit requires at least one editable field", async () => {
    const captured: Captured = { updates: [], audits: [] };
    await assert.rejects(
      () => editAutopilotItem(stubDb(pendingItem(), captured), BASE_ARGS),
      /requires a new title/,
    );
    assert.equal(captured.updates.length, 0);
    assert.equal(captured.audits.length, 0);
  });
});
