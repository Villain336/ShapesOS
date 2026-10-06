// ShapesOS — Phase 18.2 (WS=content): collab token claims (unit).
// Run: npx tsx --test lib/collab/__tests__/token.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CARET_COLORS, COLLAB_TOKEN_TTL_MS, caretColor, collabPublicUrl, collabSecret, parseDocName, signCollabToken, verifyCollabToken } from "../token";
import { standaloneCollabPort, workerCollabPort } from "../env";

const SECRET = "test-secret-0123456789abcdef";
const base = { ws: "w1", doc: "note:n1", uid: "u1", role: "write" as const, name: "Ana", color: "var(--aos-ink)" };

describe("collab tokens", () => {
  it("round-trips the claims and expires after the TTL", () => {
    const now = 1_000_000;
    const tok = signCollabToken(base, SECRET, now);
    const v = verifyCollabToken(tok, SECRET, now + 1000);
    assert.ok(v.ok);
    if (v.ok) {
      assert.equal(v.claims.ws, "w1");
      assert.equal(v.claims.doc, "note:n1");
      assert.equal(v.claims.role, "write");
      assert.equal(v.claims.exp, now + COLLAB_TOKEN_TTL_MS);
    }
    assert.deepEqual(verifyCollabToken(tok, SECRET, now + COLLAB_TOKEN_TTL_MS), { ok: false, reason: "expired" });
  });

  it("refuses a forged, tampered, re-signed or malformed token", () => {
    const tok = signCollabToken(base, SECRET);
    assert.deepEqual(verifyCollabToken(tok, "another-secret-0123456789"), { ok: false, reason: "signature" });
    const [body, sig] = tok.split(".");
    const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
    const upgraded = Buffer.from(JSON.stringify({ ...claims, role: "write", ws: "w2" })).toString("base64url");
    assert.equal(verifyCollabToken(`${upgraded}.${sig}`, SECRET).ok, false, "a viewer can't upgrade itself or switch workspace");
    assert.equal(verifyCollabToken("x", SECRET).ok, false);
    assert.equal(verifyCollabToken(`${tok}.extra`, SECRET).ok, false);
    assert.equal(verifyCollabToken("a".repeat(5000), SECRET).ok, false);
  });

  it("names exactly one known document kind", () => {
    assert.deepEqual(parseDocName("note:abc_1"), { kind: "note", id: "abc_1" });
    assert.equal(parseDocName("doc:abc"), null, "Office (Univer) docs are not co-edited");
    assert.equal(parseDocName("note:../x"), null);
    assert.throws(() => signCollabToken({ ...base, doc: "sheet:1" }, SECRET));
  });

  it("caret colours are neutral tokens only (never a status colour)", () => {
    for (const c of CARET_COLORS) assert.doesNotMatch(c, /running|needs|done|failed/);
    assert.equal(caretColor("u1"), caretColor("u1"));
    assert.ok((CARET_COLORS as readonly string[]).includes(caretColor("someone")));
  });

  it("configuration: off without a secret or a ws(s) URL; ports", () => {
    assert.equal(collabSecret({}), null);
    assert.equal(collabSecret({ AUTH_SECRET: "short" }), null);
    assert.equal(collabSecret({ NEXTAUTH_SECRET: SECRET }), SECRET);
    assert.equal(collabPublicUrl({}), null);
    assert.equal(collabPublicUrl({ COLLAB_PUBLIC_URL: "https://x" }), null);
    assert.equal(collabPublicUrl({ COLLAB_PUBLIC_URL: "wss://collab.shapesos.com/" }), "wss://collab.shapesos.com");
    assert.equal(workerCollabPort({}), null);
    assert.equal(workerCollabPort({ COLLAB_PORT: "1235" }), 1235);
    assert.equal(standaloneCollabPort({ PORT: "10000" }), 10000);
    assert.equal(standaloneCollabPort({}), 1235);
  });
});
