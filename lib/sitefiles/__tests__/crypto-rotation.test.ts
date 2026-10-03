// ShapesOS — Phase 1 tests: credential envelopes carry a key id and the key
// can be rotated with MARKETR_CREDENTIALS_KEY_PREVIOUS (old envelopes still
// decrypt; legacy v1 envelopes keep working).
// Run: npx tsx --test lib/sitefiles/__tests__/crypto-rotation.test.ts

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  credentialKeyId,
  currentCredentialKeyId,
  decryptSecret,
  encryptSecret,
  needsReencryption,
  reencryptSecret,
} from "../crypto";
import { parseOAuthState, signOAuthState } from "@/lib/vault/oauth";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const saved = {
  cur: process.env.MARKETR_CREDENTIALS_KEY,
  prev: process.env.MARKETR_CREDENTIALS_KEY_PREVIOUS,
};

function useKeys(current: string, previous?: string) {
  process.env.MARKETR_CREDENTIALS_KEY = current;
  if (previous === undefined) delete process.env.MARKETR_CREDENTIALS_KEY_PREVIOUS;
  else process.env.MARKETR_CREDENTIALS_KEY_PREVIOUS = previous;
}

/** A pre-Phase-1 envelope: "v1:iv:ct:tag", no key id, no AAD. */
function legacyV1(plaintext: string, hexKey: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), ct.toString("base64"), c.getAuthTag().toString("base64")].join(":");
}

afterEach(() => {
  if (saved.cur === undefined) delete process.env.MARKETR_CREDENTIALS_KEY;
  else process.env.MARKETR_CREDENTIALS_KEY = saved.cur;
  if (saved.prev === undefined) delete process.env.MARKETR_CREDENTIALS_KEY_PREVIOUS;
  else process.env.MARKETR_CREDENTIALS_KEY_PREVIOUS = saved.prev;
});

describe("credential envelope key id", () => {
  it("new envelopes are v2 and name the current key", () => {
    useKeys(KEY_A);
    const env = encryptSecret("s3cret");
    const [v, kid] = env.split(":");
    assert.equal(v, "v2");
    assert.equal(kid, currentCredentialKeyId());
    assert.equal(kid, credentialKeyId(Buffer.from(KEY_A, "hex")));
    assert.equal(decryptSecret(env), "s3cret");
    assert.equal(needsReencryption(env), false);
  });

  it("rotation: old envelopes decrypt via MARKETR_CREDENTIALS_KEY_PREVIOUS and can be re-sealed", () => {
    useKeys(KEY_A);
    const old = encryptSecret("rotate-me");
    useKeys(KEY_B, KEY_A);
    assert.equal(decryptSecret(old), "rotate-me");
    assert.equal(needsReencryption(old), true);
    const fresh = reencryptSecret(old);
    assert.equal(fresh.split(":")[1], credentialKeyId(Buffer.from(KEY_B, "hex")));
    assert.equal(decryptSecret(fresh), "rotate-me");
    // Once the old key is retired completely, only re-sealed envelopes open.
    useKeys(KEY_B);
    assert.throws(() => decryptSecret(old), /neither MARKETR_CREDENTIALS_KEY nor in MARKETR_CREDENTIALS_KEY_PREVIOUS/);
    assert.equal(decryptSecret(fresh), "rotate-me");
  });

  it("several previous keys may be listed", () => {
    const KEY_C = "c".repeat(64);
    useKeys(KEY_C);
    const env = encryptSecret("x");
    useKeys(KEY_A, `${KEY_B}, ${KEY_C}`);
    assert.equal(decryptSecret(env), "x");
  });

  it("legacy v1 envelopes still decrypt (current key, then previous keys)", () => {
    const legacy = legacyV1("legacy", KEY_A);
    useKeys(KEY_A);
    assert.equal(decryptSecret(legacy), "legacy");
    useKeys(KEY_B, KEY_A);
    assert.equal(decryptSecret(legacy), "legacy");
    assert.equal(needsReencryption(legacy), true);
    useKeys(KEY_B);
    assert.throws(() => decryptSecret(legacy));
  });

  it("the key id is authenticated: relabelling an envelope fails", () => {
    useKeys(KEY_A, KEY_B);
    const env = encryptSecret("bound");
    const parts = env.split(":");
    parts[1] = credentialKeyId(Buffer.from(KEY_B, "hex"));
    assert.throws(() => decryptSecret(parts.join(":")));
  });

  it("vault OAuth state round-trips with v2 envelopes", () => {
    useKeys(KEY_A);
    const state = signOAuthState({
      userId: "u1", workspaceId: "w1", connectorKey: "ga4", exp: Date.now() + 60_000, nonce: "n",
    });
    assert.equal(parseOAuthState(state).workspaceId, "w1");
  });
});
