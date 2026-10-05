// ShapesOS Phase 13 (twincore): the twin alert sweep raises each condition
// once (stub deps — no database), with the trigger keys the alert hub knows.
//   npx tsx --test lib/twin/__tests__/twin-alerts.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sweepTwinAlerts, type TwinAlertDeps } from "../alerts";
import { TWIN_ALERT_TRIGGERS } from "../derive";
import { triggerDef } from "@/lib/alerts/triggers";
import { CRON_JOBS } from "@/lib/cron/jobs";
import type { TwinSnapshot } from "../types";

const snap: TwinSnapshot = {
  site: { id: "site1", kind: "warehouse", status: "published", name: "Main", code: "WH-01", gridW: 20, gridD: 20, warehouseId: "wh" },
  objects: [
    {
      id: "o1",
      kind: "register",
      label: "Till 1",
      footprint: { x: 0, z: 0, w: 1, d: 1, h: 1, rotation: 0 },
      binding: { type: "register", id: "reg1", label: "Till 1" },
      bindingBroken: false,
      state: { kind: "register", status: "open", sessionId: "sess1", sessionNumber: "POS-0001", salesCents: 0, openedAt: "2026-10-03T00:00:00.000Z" },
      pill: "Open",
      alert: { key: "register_left_open", message: "POS-0001 has been open for 36 h" },
    },
  ],
  kpis: [],
  shipments: [],
  agents: [],
  generatedAt: "2026-10-04T12:00:00.000Z",
};

describe("twin alert sweep", () => {
  it("every twin trigger is a live alert-hub trigger; the cron runs every 5 minutes", () => {
    for (const t of Object.values(TWIN_ALERT_TRIGGERS)) assert.equal(triggerDef(t)?.live, true, t);
    assert.equal(CRON_JOBS.find((j) => j.key === "twin-alerts")?.cron, "*/5 * * * *");
  });

  it("raises a condition once: notification + alert-hub event, then nothing while it persists", async () => {
    const seen = new Set<string>();
    const notified: string[] = [];
    const emitted: Array<{ trigger: string; dedupKey?: string; link?: string }> = [];
    const deps: TwinAlertDeps = {
      snapshots: async () => [snap],
      seen: async (_ws, key) => seen.has(key),
      notify: async (input) => {
        seen.add(input.dedupKey);
        notified.push(input.objectLabel);
        return 1;
      },
      emit: async (input) => {
        emitted.push(input);
        return [];
      },
    };
    const first = await sweepTwinAlerts("ws", deps);
    assert.deepEqual([first.sites, first.raised, first.alreadyRaised], [1, 1, 0]);
    assert.deepEqual(notified, ["Till 1"]);
    assert.equal(emitted[0]!.trigger, "twin.register_left_open");
    assert.equal(emitted[0]!.dedupKey, "twin.register_left_open:site1:o1:sess1");
    assert.equal(emitted[0]!.link, "/dashboard/ops/twin/site1?object=o1");
    const second = await sweepTwinAlerts("ws", deps);
    assert.deepEqual([second.raised, second.alreadyRaised], [0, 1]);
    assert.equal(emitted.length, 1);
  });

  it("a broken snapshot is reported, never thrown", async () => {
    const r = await sweepTwinAlerts("ws", { snapshots: async () => { throw new Error("boom"); }, seen: async () => false, notify: async () => 0, emit: async () => [] });
    assert.deepEqual(r.errors, ["boom"]);
  });
});
