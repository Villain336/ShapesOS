// ShapesOS — outbound webhooks, pure parts (Phase 4a): signatures + replay
// window, backoff schedule, event catalog, endpoint URL rules.
// Run: npx tsx --test lib/webhooks/__tests__/webhooks.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeSignature,
  mintWebhookSecret,
  parseSignatureHeader,
  secretHint,
  signatureHeader,
  verifyWebhookSignature,
} from "../signing";
import { afterFailure, backoffMs, MAX_ATTEMPTS, MAX_BACKOFF_MS } from "../dispatch";
import {
  SUBSCRIBABLE_EVENT_TYPES,
  WEBHOOK_EVENT_SCHEMAS,
  WEBHOOK_EVENT_TYPES,
  endpointWants,
  isWebhookEventType,
} from "../events";
import { buildEnvelope, leadEventData } from "../emit";
import { CreateEndpointSchema, UpdateEndpointSchema, validateEndpointUrl } from "../endpoints";

const SECRET = "whsec_test_secret";
const BODY = JSON.stringify({ id: "evt_1", type: "lead.created", data: { a: 1 } });
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const T = Math.floor(NOW / 1000);

describe("signing (Stripe-style, HMAC-SHA256)", () => {
  it("signs t.body and verifies within the replay window", () => {
    const header = signatureHeader(SECRET, BODY, T);
    assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/);
    assert.deepEqual(verifyWebhookSignature(SECRET, BODY, header, { now: NOW }), { ok: true, timestamp: T });
    // 4 minutes later is still inside the default 5-minute window.
    assert.equal(verifyWebhookSignature(SECRET, BODY, header, { now: NOW + 240_000 }).ok, true);
  });

  it("rejects replays outside the window, tampering, a wrong secret, and junk", () => {
    const header = signatureHeader(SECRET, BODY, T);
    assert.deepEqual(verifyWebhookSignature(SECRET, BODY, header, { now: NOW + 301_000 }), { ok: false, reason: "expired" });
    assert.deepEqual(verifyWebhookSignature(SECRET, BODY, header, { now: NOW - 301_000 }), { ok: false, reason: "expired" });
    assert.deepEqual(verifyWebhookSignature(SECRET, BODY + " ", header, { now: NOW }), { ok: false, reason: "mismatch" });
    assert.deepEqual(verifyWebhookSignature("whsec_other", BODY, header, { now: NOW }), { ok: false, reason: "mismatch" });
    // Re-signing the same body under a new timestamp needs the secret.
    const forged = header.replace(`t=${T}`, `t=${T + 10}`);
    assert.deepEqual(verifyWebhookSignature(SECRET, BODY, forged, { now: NOW }), { ok: false, reason: "mismatch" });
    for (const bad of [null, "", "v1=abc", "t=1", "t=x,v1=" + "0".repeat(64)]) {
      assert.deepEqual(verifyWebhookSignature(SECRET, BODY, bad, { now: NOW }), { ok: false, reason: "malformed" });
    }
  });

  it("accepts any of several v1 signatures (rotation overlap)", () => {
    const good = computeSignature(SECRET, T, BODY);
    const header = `t=${T},v1=${"0".repeat(64)},v1=${good}`;
    assert.equal(parseSignatureHeader(header)?.v1.length, 2);
    assert.equal(verifyWebhookSignature(SECRET, BODY, header, { now: NOW }).ok, true);
  });

  it("mints unguessable secrets with a non-sensitive hint", () => {
    const a = mintWebhookSecret();
    const b = mintWebhookSecret();
    assert.notEqual(a, b);
    assert.match(a, /^whsec_[A-Za-z0-9_-]{40,}$/);
    const hint = secretHint(a);
    assert.ok(hint.startsWith("whsec_") && hint.includes("…"));
    assert.ok(hint.length < 20 && !hint.includes(a.slice(12, 30)));
  });
});

describe("retry schedule", () => {
  const mid = () => 0.5; // no jitter
  it("backs off exponentially (×4 from one minute) and caps at 24h", () => {
    assert.deepEqual([1, 2, 3, 4].map((n) => backoffMs(n, mid)), [60_000, 240_000, 960_000, 3_840_000]);
    assert.equal(backoffMs(7, mid), MAX_BACKOFF_MS);
    assert.equal(backoffMs(30, mid), MAX_BACKOFF_MS);
  });

  it("jitters within ±10%", () => {
    assert.equal(backoffMs(1, () => 0), 54_000);
    assert.equal(backoffMs(1, () => 1), 66_000);
  });

  it("dead-letters after the last attempt", () => {
    const now = new Date(NOW);
    const retry = afterFailure(1, now, mid);
    assert.equal(retry.status, "pending");
    assert.equal(retry.nextAttemptAt.getTime(), NOW + 60_000);
    assert.equal(afterFailure(MAX_ATTEMPTS - 1, now, mid).status, "pending");
    assert.equal(afterFailure(MAX_ATTEMPTS, now, mid).status, "dead");
    // Total retry horizon is roughly two days.
    let total = 0;
    for (let n = 1; n < MAX_ATTEMPTS; n++) total += backoffMs(n, mid);
    assert.ok(total > 40 * 3_600_000 && total < 50 * 3_600_000, `${total / 3_600_000}h`);
  });
});

describe("event catalog", () => {
  it("covers the domain events the platform emits", () => {
    for (const t of [
      "lead.created",
      "lead.updated",
      "invoice.paid",
      "approval.needed",
      "approval.decided",
      "agent_run.finished",
      "agent_run.failed",
      "notification.created",
    ]) {
      assert.ok(isWebhookEventType(t), t);
      assert.ok(SUBSCRIBABLE_EVENT_TYPES.includes(t as never), t);
    }
    assert.ok(!SUBSCRIBABLE_EVENT_TYPES.includes("webhook.ping"));
    assert.equal(isWebhookEventType("lead.deleted"), false);
    assert.equal(Object.keys(WEBHOOK_EVENT_SCHEMAS).length, WEBHOOK_EVENT_TYPES.length);
  });

  it("empty filter means every event; pings always pass", () => {
    assert.equal(endpointWants([], "lead.created"), true);
    assert.equal(endpointWants(null, "invoice.paid"), true);
    assert.equal(endpointWants(["lead.created"], "lead.created"), true);
    assert.equal(endpointWants(["lead.created"], "invoice.paid"), false);
    assert.equal(endpointWants(["lead.created"], "webhook.ping"), true);
  });

  it("builds a versioned envelope and lead payloads that satisfy the schema", () => {
    const now = new Date(NOW);
    const data = leadEventData(
      {
        id: "lead_1",
        workspaceId: "ws",
        name: "Ada",
        email: "ada@example.test",
        phone: null,
        company: "Acme",
        title: null,
        stage: "new",
        score: 40,
        valueCents: 1200,
        source: "website_form",
        pipelineId: "p1",
        projectId: null,
        createdAt: now,
        updatedAt: now,
      },
      ["stage"],
    );
    assert.equal(WEBHOOK_EVENT_SCHEMAS["lead.updated"].safeParse(data).success, true);
    const env = buildEnvelope("lead.updated", "ws", data, now, "evt_x");
    assert.deepEqual(Object.keys(env).sort(), ["apiVersion", "createdAt", "data", "id", "type", "workspaceId"]);
    assert.equal(env.createdAt, "2026-10-05T12:00:00.000Z");
    assert.equal(WEBHOOK_EVENT_SCHEMAS["invoice.paid"].safeParse({ id: "i" }).success, false);
  });
});

describe("endpoint rules", () => {
  const publicDns = async () => ["93.184.216.34"];
  const privateDns = async () => ["10.0.0.5"];

  it("accepts a public https URL", async () => {
    assert.equal(await validateEndpointUrl(" https://hooks.example.test/in ", publicDns), "https://hooks.example.test/in");
  });

  it("rejects http, credentials, internal and metadata targets", async () => {
    for (const [url, dns] of [
      ["http://hooks.example.test/in", publicDns],
      ["https://user:pw@hooks.example.test/in", publicDns],
      ["https://internal.example.test/in", privateDns],
      ["https://127.0.0.1/in", publicDns],
      ["https://169.254.169.254/latest", publicDns],
      ["https://localhost/in", publicDns],
      ["not a url", publicDns],
    ] as const) {
      await assert.rejects(validateEndpointUrl(url, dns), (e: unknown) => (e as { status?: number }).status === 400, url);
    }
  });

  it("validates bodies strictly", () => {
    assert.deepEqual(CreateEndpointSchema.parse({ url: "https://x.test" }).events, []);
    assert.deepEqual(
      CreateEndpointSchema.parse({ url: "https://x.test", events: ["lead.created", "lead.created"] }).events,
      ["lead.created"],
    );
    assert.equal(CreateEndpointSchema.safeParse({ url: "https://x.test", events: ["webhook.ping"] }).success, false);
    assert.equal(CreateEndpointSchema.safeParse({ url: "https://x.test", workspaceId: "other" }).success, false);
    assert.equal(UpdateEndpointSchema.safeParse({ rotateSecret: false }).success, false);
    assert.equal(UpdateEndpointSchema.safeParse({ enabled: false }).success, true);
  });
});
