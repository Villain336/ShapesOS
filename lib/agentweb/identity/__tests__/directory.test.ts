// Phase 21A round 2 (WS=agentweb): the public key directory document (PURE).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDirectoryResponse, DIRECTORY_MEDIA_TYPE } from "../directory";
import { generateKeyPair, verifyDirectoryResponse } from "../httpsig";

describe("directory response", () => {
  const k = generateKeyPair();
  const now = 1_800_000_000;
  const keys = [{ kty: "OKP" as const, crv: "Ed25519" as const, x: k.x, kid: k.kid, use: "sig" as const, nbf: now - 100, exp: now + 1000 }];
  const out = buildDirectoryResponse({ keys, signingKey: k, authority: "app.shapesos.test", nowSec: now });

  it("is a JWKS with public members only, and never the private scalar", () => {
    const body = JSON.parse(out.body);
    assert.deepEqual(body.keys, [{ kty: "OKP", crv: "Ed25519", x: k.x, kid: k.kid, use: "sig", nbf: now - 100, exp: now + 1000 }]);
    assert.ok(!out.body.includes(k.d), "the private key must not be anywhere in the response");
    assert.ok(!/"d"\s*:/.test(out.body));
  });

  it("uses the directory media type and is signed over the authority it was asked on", () => {
    assert.equal(out.headers["content-type"], DIRECTORY_MEDIA_TYPE);
    assert.equal(verifyDirectoryResponse({ authority: "app.shapesos.test", headers: out.headers, x: k.x, now }).ok, true);
    assert.equal(verifyDirectoryResponse({ authority: "evil.test", headers: out.headers, x: k.x, now }).ok, false);
  });
});
