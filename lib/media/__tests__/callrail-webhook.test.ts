// ShapesOS — real CallRail webhook: per-workspace signing secret
// (REMEDIATION-PLAN Phase 1 follow-up: ?w= + one host-wide secret let a
// signature valid for one workspace be replayed into another).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  callRailWorkspaceWebhookSecret,
  createCallRailService,
  RealCallRailProvider,
} from "../callrail";
import type { MediaStore } from "../store";

const HOST = "host-secret-for-tests";
const body = JSON.stringify({ events: [] });
const hmac = (secret: string) => createHmac("sha256", secret).update(body, "utf8").digest("hex");

function provider(acceptSharedSecret = false) {
  return new RealCallRailProvider({ apiKey: "k", webhookSecret: HOST, acceptSharedSecret });
}

describe("callRailWorkspaceWebhookSecret", () => {
  it("is deterministic per workspace and differs across workspaces", () => {
    assert.equal(callRailWorkspaceWebhookSecret(HOST, "ws_a"), callRailWorkspaceWebhookSecret(HOST, "ws_a"));
    assert.notEqual(callRailWorkspaceWebhookSecret(HOST, "ws_a"), callRailWorkspaceWebhookSecret(HOST, "ws_b"));
    assert.notEqual(callRailWorkspaceWebhookSecret(HOST, "ws_a"), HOST);
  });
});

describe("RealCallRailProvider.validateWebhookSignature", () => {
  const secretA = callRailWorkspaceWebhookSecret(HOST, "ws_a");

  it("accepts the workspace's own secret (HMAC or Bearer)", () => {
    const p = provider();
    assert.equal(p.validateWebhookSignature({ rawBody: body, signature: hmac(secretA), workspaceId: "ws_a" }), true);
    assert.equal(p.validateWebhookSignature({ rawBody: body, signature: `Bearer ${secretA}`, workspaceId: "ws_a" }), true);
  });

  it("rejects workspace A's signature replayed with ?w=ws_b", () => {
    const p = provider();
    assert.equal(p.validateWebhookSignature({ rawBody: body, signature: hmac(secretA), workspaceId: "ws_b" }), false);
    assert.equal(p.validateWebhookSignature({ rawBody: body, signature: `Bearer ${secretA}`, workspaceId: "ws_b" }), false);
  });

  it("rejects the host-wide secret unless the migration flag is on", () => {
    assert.equal(provider().validateWebhookSignature({ rawBody: body, signature: hmac(HOST), workspaceId: "ws_a" }), false);
    assert.equal(
      provider(true).validateWebhookSignature({ rawBody: body, signature: hmac(HOST), workspaceId: "ws_a" }),
      true,
    );
  });

  it("rejects when no workspace is given", () => {
    assert.equal(provider().validateWebhookSignature({ rawBody: body, signature: hmac(secretA) }), false);
  });
});

describe("ingestWebhook binds the workspace into verification", () => {
  it("returns invalid signature for a cross-workspace replay before touching the store", async () => {
    const store = new Proxy({}, {
      get() {
        throw new Error("store must not be touched");
      },
    }) as MediaStore;
    const svc = createCallRailService(store, provider());
    const secretA = callRailWorkspaceWebhookSecret(HOST, "ws_a");
    const r = await svc.ingestWebhook({ rawBody: body, signature: hmac(secretA), workspaceId: "ws_b" });
    assert.equal(r.accepted, false);
    assert.equal(r.reason, "invalid signature");
  });
});
