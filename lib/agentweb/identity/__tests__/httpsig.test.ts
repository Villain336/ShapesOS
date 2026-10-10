// Phase 21A round 2 (WS=agentweb): Web Bot Auth, RFC 9421 HTTP message signatures
// with Ed25519 (PURE). Vectors are draft-meunier-web-bot-auth-architecture-05,
// Appendix A.2 (Ed25519), which use the RFC 9421 Appendix B.1.4 test key:
//   x = JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs
//   d = n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU
//   keyid = JWK thumbprint = poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U
// Ed25519 is deterministic, so signing reproduces the published Signature bytes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jwkThumbprint, keyPairFromJwk, signRequest, verifyRequest, signDirectoryResponse, verifyDirectoryResponse, generateKeyPair } from "../httpsig";

const X = "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs";
const D = "n4Ni-HpISpVObnQMW0wOhCKROaIKqKtW_2ZYb2p9KcU";
const KEYID = "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";
const NONCE_A21 = "g0iqFa9e1ffijlyOScDkXpfSmTbYpRNSGPJrQ1It20ahwgzB3jOUcdgLgFxUg7RMtW4V8IILaKKtA+YuSyIgJQ==";
const NONCE_A22 = "XeP72svPKNiGEg3aDE7WJuTpN69H08oMFqC8NLFy1MptpENAT3WZTYwK+MYdsFMlaqHCJGo9ZAhqer1NWY9Epg==";
const SIG_A21 = "sig1=:FFASViSdcgsyaqqYiCnkHreeZzbNKcTzDvZC5uVlP/dn9IbWj8j0o4wKFTH3rBnUiSUBduwm1Gp5VlIPCp01Ag==:";
const SIG_A22 = "sig2=:DGiW2ErlQh0hc8wY2FQdbnFd6CEmonyY8nlvECIJFaUSYYNvNvSsGyP99BUGtq51gA4ouXlkUwjnta084bpjCg==:";
const keys = keyPairFromJwk({ x: X, d: D });

describe("key identity", () => {
  it("the keyid is the RFC 7638 / RFC 8037 JWK thumbprint of the public key", () => {
    assert.equal(jwkThumbprint(X), KEYID);
    assert.equal(keys.kid, KEYID);
  });
});

describe("draft appendix A.2 test vectors", () => {
  it("A.2.1 (no Signature-Agent): signing reproduces the published Signature and Signature-Input", () => {
    const h = signRequest({ url: "https://example.com/", keys, created: 1735689600, expires: 4889289600, nonce: NONCE_A21, label: "sig1" });
    assert.equal(h.Signature, SIG_A21);
    assert.equal(
      h["Signature-Input"],
      `sig1=("@authority");created=1735689600;keyid="${KEYID}";alg="ed25519";expires=4889289600;nonce="${NONCE_A21}";tag="web-bot-auth"`,
    );
    assert.equal(h["Signature-Agent"], undefined);
  });

  it("A.2.2 (Signature-Agent dictionary member agent2): reproduces the published values", () => {
    const h = signRequest({ url: "https://example.com/", keys, created: 1735689600, expires: 4889289600, nonce: NONCE_A22, label: "sig2", signatureAgent: { url: "https://signature-agent.test", member: "agent2", form: "dictionary" } });
    assert.equal(h["Signature-Agent"], `agent2="https://signature-agent.test"`);
    assert.equal(h["Signature-Input"], `sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="${KEYID}";alg="ed25519";expires=4889289600;nonce="${NONCE_A22}";tag="web-bot-auth"`);
    assert.equal(h.Signature, SIG_A22);
  });

  it("verifies the published signatures byte for byte, with the verifier's own view of the host", () => {
    const common = { now: 1735689700, maxWindowSec: Infinity, resolveKey: (id: string) => (id === KEYID ? X : null) };
    const v1 = verifyRequest({ url: "https://example.com/anything", headers: { "Signature-Input": `sig1=("@authority");created=1735689600;keyid="${KEYID}";alg="ed25519";expires=4889289600;nonce="${NONCE_A21}";tag="web-bot-auth"`, Signature: SIG_A21 }, ...common });
    assert.deepEqual(v1.ok, true);
    const v2 = verifyRequest({
      url: "https://example.com/",
      headers: {
        "Signature-Agent": `agent2="https://signature-agent.test"`,
        "Signature-Input": `sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="${KEYID}";alg="ed25519";expires=4889289600;nonce="${NONCE_A22}";tag="web-bot-auth"`,
        Signature: SIG_A22,
      },
      ...common,
    });
    assert.deepEqual(v2.ok, true);
    if (v2.ok) assert.equal(v2.signatureAgent, "https://signature-agent.test");
  });
});

describe("replay protection", () => {
  const now = 1_800_000_000;
  const fresh = generateKeyPair();
  const sign = (url: string) => signRequest({ url, keys: fresh, created: now, expires: now + 60, nonce: "n1" });
  const resolveKey = (id: string) => (id === fresh.kid ? fresh.x : null);

  it("a signature for one host fails verification on another host (authority is signed)", () => {
    const headers = sign("https://shop-a.example/cart");
    assert.equal(verifyRequest({ url: "https://shop-a.example/other", headers, resolveKey, now }).ok, true);
    const replay = verifyRequest({ url: "https://shop-b.example/cart", headers, resolveKey, now });
    assert.deepEqual(replay, { ok: false, reason: "bad_signature" });
  });

  it("covers the port: the same host on another port is another authority", () => {
    const headers = sign("https://shop-a.example:8443/cart");
    assert.equal(verifyRequest({ url: "https://shop-a.example:8443/x", headers, resolveKey, now }).ok, true);
    assert.equal(verifyRequest({ url: "https://shop-a.example/x", headers, resolveKey, now }).ok, false);
  });

  it("@target-uri, when signed, pins the whole URL (path replay fails too)", () => {
    const headers = signRequest({ url: "https://shop-a.example/cart?a=1", keys: fresh, created: now, expires: now + 60, components: ["@authority", "@target-uri"] });
    assert.equal(verifyRequest({ url: "https://shop-a.example/cart?a=1", headers, resolveKey, now }).ok, true);
    assert.equal(verifyRequest({ url: "https://shop-a.example/checkout", headers, resolveKey, now }).ok, false);
  });

  it("an expired or not-yet-valid signature is refused", () => {
    const headers = sign("https://shop-a.example/");
    assert.deepEqual(verifyRequest({ url: "https://shop-a.example/", headers, resolveKey, now: now + 61 }), { ok: false, reason: "expired" });
    assert.deepEqual(verifyRequest({ url: "https://shop-a.example/", headers, resolveKey, now: now - 3600 }), { ok: false, reason: "not_yet_valid" });
  });

  it("a nonce seen before is refused", () => {
    const headers = sign("https://shop-a.example/");
    const seen = new Set<string>();
    const seenNonce = (n: string) => (seen.has(n) ? true : (seen.add(n), false));
    assert.equal(verifyRequest({ url: "https://shop-a.example/", headers, resolveKey, now, seenNonce }).ok, true);
    assert.deepEqual(verifyRequest({ url: "https://shop-a.example/", headers, resolveKey, now, seenNonce }), { ok: false, reason: "replayed_nonce" });
  });

  it("refuses a window longer than the allowed one (24 hours by default)", () => {
    const headers = signRequest({ url: "https://shop-a.example/", keys: fresh, created: now, expires: now + 90_000 });
    assert.deepEqual(verifyRequest({ url: "https://shop-a.example/", headers, resolveKey, now }), { ok: false, reason: "window_too_long" });
  });
});

describe("what a verifier must refuse", () => {
  const now = 1_800_000_000;
  const k = generateKeyPair();
  const resolveKey = (id: string) => (id === k.kid ? k.x : null);
  const headers = () => signRequest({ url: "https://a.example/", keys: k, created: now, expires: now + 60 });

  it("unknown key, wrong tag, no authority or target-uri covered, tampered signature", () => {
    assert.deepEqual(verifyRequest({ url: "https://a.example/", headers: headers(), resolveKey: () => null, now }), { ok: false, reason: "unknown_key" });
    const wrongTag = { ...headers(), "Signature-Input": headers()["Signature-Input"].replace('tag="web-bot-auth"', 'tag="other"') };
    assert.deepEqual(verifyRequest({ url: "https://a.example/", headers: wrongTag, resolveKey, now }), { ok: false, reason: "no_web_bot_auth_signature" });
    const noAuthority = signRequest({ url: "https://a.example/", keys: k, created: now, expires: now + 60, components: ["@method"] });
    assert.deepEqual(verifyRequest({ url: "https://a.example/", headers: noAuthority, resolveKey, now }), { ok: false, reason: "authority_not_covered" });
    const h = headers();
    const raw = Buffer.from(/:(.*):/.exec(h.Signature)![1]!, "base64");
    raw[0] = raw[0]! ^ 0xff; // one flipped byte
    const flipped = { ...h, Signature: `sig1=:${raw.toString("base64")}:` };
    assert.equal(verifyRequest({ url: "https://a.example/", headers: flipped, resolveKey, now }).ok, false);
  });

  it("a Signature-Agent header that is not covered is refused", () => {
    const h = headers();
    const withAgent = { ...h, "Signature-Agent": `agent="https://evil.example"` };
    assert.deepEqual(verifyRequest({ url: "https://a.example/", headers: withAgent, resolveKey, now }), { ok: false, reason: "signature_agent_not_covered" });
  });

  it("changing a signed Signature-Agent after signing fails verification", () => {
    const h = signRequest({ url: "https://a.example/", keys: k, created: now, expires: now + 60, signatureAgent: { url: "https://agent.example", member: "a", form: "dictionary" } });
    assert.equal(verifyRequest({ url: "https://a.example/", headers: h, resolveKey, now }).ok, true);
    assert.equal(verifyRequest({ url: "https://a.example/", headers: { ...h, "Signature-Agent": `a="https://evil.example"` }, resolveKey, now }).ok, false);
  });

  it("the quoted-string Signature-Agent form (Cloudflare's documented example, our default) round-trips", () => {
    const h = signRequest({ url: "https://a.example/", keys: k, created: now, expires: now + 60, signatureAgent: { url: "https://agent.example" } });
    assert.equal(h["Signature-Agent"], `"https://agent.example"`);
    assert.match(h["Signature-Input"], /^sig1=\("@authority" "signature-agent"\);/);
    assert.equal(verifyRequest({ url: "https://a.example/", headers: h, resolveKey, now }).ok, true);
  });

  it("header names are matched case-insensitively", () => {
    const h = headers();
    const lower = { signature: h.Signature, "signature-input": h["Signature-Input"] };
    assert.equal(verifyRequest({ url: "https://a.example/", headers: lower, resolveKey, now }).ok, true);
  });
});

describe("signed key directory response", () => {
  const now = 1_800_000_000;
  const k = generateKeyPair();
  it("signs with the directory tag over the request authority, and verifies", () => {
    const body = JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", x: k.x }] });
    const h = signDirectoryResponse({ authority: "agent.shapesos.test", keys: k, created: now, expires: now + 300 });
    assert.match(h["Signature-Input"], /^sig1=\("@authority";req\);created=\d+;expires=\d+;keyid="[A-Za-z0-9_-]+";alg="ed25519";tag="http-message-signatures-directory"$/);
    assert.equal(verifyDirectoryResponse({ authority: "agent.shapesos.test", headers: h, x: k.x, now }).ok, true);
    assert.equal(verifyDirectoryResponse({ authority: "other.test", headers: h, x: k.x, now }).ok, false);
    void body;
  });
});
