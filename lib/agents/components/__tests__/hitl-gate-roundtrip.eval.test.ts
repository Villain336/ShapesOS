// Marketr — Phase 16 slice 11 evals: HITL gate round-trip (web, extended).
// Run: npx tsx --test lib/agents/components/__tests__/hitl-gate-roundtrip.eval.test.ts
//
// Slice 3's gate-roundtrip.test.ts proved the happy paths at the gate's OWN
// service level (approve/deny/edit → right item id → audit entry). This eval
// fills the gaps:
//   - deny path depth: note persisted, no-note deny, deny is terminal
//     (cannot approve or edit afterwards), audit ordering;
//   - edit path depth: edit → requeue pending → approve afterwards succeeds
//     (full lifecycle), audit chain order, edit cannot smuggle a status;
//   - route contract pins (text-level): the approve/reject/edit HTTP routes
//     must call the SAME service functions these tests exercise — if a route
//     ever reimplements the gate, the pin fails.
//   - card contract pin (text-level): the web ApprovalCard must POST the
//     three gate actions to the matching /api/autopilot/items/[id]/<action>
//     routes with { projectId, ... }.
//
// The real service functions run against a stub db — no live database.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";
import {
  approveAutopilotItem,
  editAutopilotItem,
  rejectAutopilotItem,
} from "@/lib/seo/autopilot-service";

interface Captured {
  updates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  audits: Array<{ action: string; summary: string }>;
  rows: Map<string, Record<string, unknown>>;
}

/** Stub db whose findFirst returns the CURRENT row (so sequential
 *  transitions on one item are possible, unlike a frozen snapshot). */
function stubDb(captured: Captured): PrismaClient {
  return {
    autopilotItem: {
      findFirst: async (args: { where: { id: string } }) => {
        const row = captured.rows.get(args.where.id);
        return row ? { ...row } : null;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        captured.updates.push(args);
        const row = captured.rows.get(args.where.id);
        if (!row) throw new Error("not found");
        const next = { ...row, ...args.data };
        captured.rows.set(args.where.id, next);
        return next;
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

function fresh(itemId = "item-1"): { db: PrismaClient; captured: Captured } {
  const captured: Captured = { updates: [], audits: [], rows: new Map() };
  captured.rows.set(itemId, {
    id: itemId,
    projectId: "proj-1",
    status: "pending",
    title: "Original title",
    sourceRef: "keyword:kw-1",
    rule: { id: "rule-1", name: "Test rule", publishTarget: null },
  });
  return { db: stubDb(captured), captured };
}

const BASE_ARGS = { workspaceId: "ws-1", projectId: "proj-1", itemId: "item-1", actor: "user-1" };

function readSource(p: string): string {
  return readFileSync(join(process.cwd(), p), "utf8");
}

describe("HITL gate round-trip eval: deny path", () => {
  it("deny persists the note and writes one audit entry", async () => {
    const { db, captured } = fresh();
    await rejectAutopilotItem(db, { ...BASE_ARGS, note: "off-brand tone" });
    assert.equal(captured.rows.get("item-1")!.status, "rejected");
    assert.equal(captured.rows.get("item-1")!.reviewNote, "off-brand tone");
    assert.deepEqual(
      captured.audits.map((a) => a.action),
      ["autopilot_item_rejected"],
    );
  });

  it("deny without a note still audits (silence is not an option)", async () => {
    const { db, captured } = fresh();
    await rejectAutopilotItem(db, BASE_ARGS);
    assert.equal(captured.rows.get("item-1")!.status, "rejected");
    assert.equal(captured.audits.length, 1);
    assert.equal(captured.audits[0].action, "autopilot_item_rejected");
  });

  it("deny is terminal: cannot approve afterwards", async () => {
    const { db, captured } = fresh();
    await rejectAutopilotItem(db, { ...BASE_ARGS, note: "no" });
    const updatesBefore = captured.updates.length;
    await assert.rejects(() => approveAutopilotItem(db, BASE_ARGS), /cannot be approved/);
    assert.equal(captured.updates.length, updatesBefore, "no update on failed transition");
    assert.equal(captured.audits.length, 1, "no audit on failed transition");
  });

  it("deny is terminal: cannot edit afterwards", async () => {
    const { db, captured } = fresh();
    await rejectAutopilotItem(db, BASE_ARGS);
    const updatesBefore = captured.updates.length;
    await assert.rejects(
      () => editAutopilotItem(db, { ...BASE_ARGS, title: "sneaky" }),
      /cannot be edited/,
    );
    assert.equal(captured.updates.length, updatesBefore);
    assert.equal(captured.audits.length, 1);
  });

  it("cannot deny an already-denied item (double-deny is a no-op failure)", async () => {
    const { db, captured } = fresh();
    await rejectAutopilotItem(db, BASE_ARGS);
    await assert.rejects(() => rejectAutopilotItem(db, BASE_ARGS), /cannot be rejected/);
    assert.equal(captured.audits.length, 1, "double-deny must not audit twice");
  });
});

describe("HITL gate round-trip eval: edit path", () => {
  it("full lifecycle: edit → pending → approve succeeds, audit chain in order", async () => {
    const { db, captured } = fresh();
    await editAutopilotItem(db, { ...BASE_ARGS, title: "Revised title" });
    assert.equal(captured.rows.get("item-1")!.status, "pending");
    await approveAutopilotItem(db, BASE_ARGS);
    assert.equal(captured.rows.get("item-1")!.status, "approved");
    assert.deepEqual(
      captured.audits.map((a) => a.action),
      ["autopilot_item_edited", "autopilot_item_approved"],
    );
    assert.match(captured.audits[0].summary, /Autopilot item edited \(title\)/);
  });

  it("full lifecycle: edit → deny succeeds afterwards", async () => {
    const { db, captured } = fresh();
    await editAutopilotItem(db, { ...BASE_ARGS, draftMarkdown: "# v2" });
    await rejectAutopilotItem(db, { ...BASE_ARGS, note: "still no" });
    assert.equal(captured.rows.get("item-1")!.status, "rejected");
    assert.deepEqual(
      captured.audits.map((a) => a.action),
      ["autopilot_item_edited", "autopilot_item_rejected"],
    );
  });

  it("edit cannot smuggle a status change (status stays pending)", async () => {
    const { db, captured } = fresh();
    // Extra fields on the args must not leak into the update — the service
    // only writes title/draftMarkdown (+ status: pending).
    await editAutopilotItem(db, {
      ...BASE_ARGS,
      title: "New title",
      status: "approved",
    } as unknown as Parameters<typeof editAutopilotItem>[1]);
    const data = captured.updates[0].data;
    assert.equal(data.status, "pending", "edit must always requeue as pending");
    assert.equal(captured.rows.get("item-1")!.status, "pending");
  });

  it("edit of an approved item fails — approvals are immutable", async () => {
    const { db, captured } = fresh();
    await approveAutopilotItem(db, BASE_ARGS);
    await assert.rejects(
      () => editAutopilotItem(db, { ...BASE_ARGS, title: "too late" }),
      /cannot be edited/,
    );
    assert.equal(captured.audits.length, 1, "only the approve audit exists");
  });
});

describe("HITL gate round-trip eval: route + card contract pins", () => {
  const ROUTES: Array<[string, string]> = [
    ["app/api/autopilot/items/[id]/approve/route.ts", "approveAutopilotItem"],
    ["app/api/autopilot/items/[id]/reject/route.ts", "rejectAutopilotItem"],
    ["app/api/autopilot/items/[id]/edit/route.ts", "editAutopilotItem"],
  ];

  it("each gate route calls the gate's OWN service function (the gate is the law)", () => {
    for (const [routePath, fn] of ROUTES) {
      const src = readSource(routePath);
      assert.ok(
        src.includes(`import { ${fn} } from "@/lib/seo/autopilot-service"`) ||
          new RegExp(`\\b${fn}\\b`).test(src),
        `${routePath} must call ${fn}`,
      );
      assert.ok(src.includes(fn), `${routePath} must invoke ${fn}`);
    }
  });

  it("the web ApprovalCard posts approve/reject/edit to the matching gate routes", () => {
    const src = readSource("components/agents/ApprovalCard.tsx");
    // Action paths rendered by the card.
    assert.ok(
      /path:\s*"approve"\s*\|\s*"reject"\s*\|\s*"edit"/.test(src),
      "ApprovalCard must support exactly approve/reject/edit actions",
    );
    // URL shape: /api/autopilot/items/<id>/<action>, body carries projectId.
    assert.ok(
      src.includes("`/api/autopilot/items/${encodeURIComponent(itemId)}/${path}`"),
      "ApprovalCard must POST to the gate's item action routes",
    );
    assert.ok(
      src.includes("JSON.stringify({ projectId, ...body })"),
      "ApprovalCard must send projectId with every gate action",
    );
    // The card never invents item content: it loads the item live from the gate.
    assert.ok(
      src.includes("`/api/autopilot/items/${encodeURIComponent(itemId)}?projectId="),
      "ApprovalCard must load the item from the gate before rendering actions",
    );
  });
});
