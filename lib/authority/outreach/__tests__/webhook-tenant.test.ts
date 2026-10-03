// ShapesOS — Phase 1 unit tests: outreach webhook tenant resolution uses
// signed data only, and the idempotency port claims each event once.
// Run: npx tsx --test lib/authority/outreach/__tests__/webhook-tenant.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { memoryWebhookEventStore, parseWebhookPayload, resolveWebhookWorkspace } from "../webhooks";

const owners: Record<string, string> = { seq_a: "ws_a" };
const lookup = async (id: string) => owners[id] ?? null;

describe("resolveWebhookWorkspace", () => {
  it("uses the referenced sequence's own workspace", async () => {
    assert.equal(await resolveWebhookWorkspace({ sequenceId: "seq_a" }, lookup), "ws_a");
  });
  it("uses the signed body workspaceId for sequence-less events", async () => {
    assert.equal(await resolveWebhookWorkspace({ workspaceId: "ws_b" }, lookup), "ws_b");
  });
  it("rejects a body workspaceId that disagrees with the sequence", async () => {
    assert.equal(await resolveWebhookWorkspace({ sequenceId: "seq_a", workspaceId: "ws_b" }, lookup), null);
  });
  it("has no tenant at all without signed data", async () => {
    assert.equal(await resolveWebhookWorkspace({}, lookup), null);
    assert.equal(await resolveWebhookWorkspace({ sequenceId: "seq_unknown" }, lookup), null);
  });
  it("parses the workspaceId field from the (signed) body", () => {
    const p = parseWebhookPayload(JSON.stringify({ eventId: "e1", type: "unsubscribed", email: "a@b.co", workspaceId: "ws_b" }));
    assert.equal(p.workspaceId, "ws_b");
  });
});

describe("webhook event idempotency port", () => {
  it("claims once; release allows a retry", async () => {
    const store = memoryWebhookEventStore();
    const ev = { provider: "smartlead" as const, eventId: "e1", workspaceId: "ws_a", type: "sent" };
    assert.equal(await store.claim(ev), true);
    assert.equal(await store.claim(ev), false);
    await store.release("smartlead", "e1");
    assert.equal(await store.claim(ev), true);
  });
});
