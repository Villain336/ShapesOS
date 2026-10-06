// ShapesOS — Phase 18.3 (WS=flow): Web Push crypto against the RFCs.
//   - RFC 8291 Appendix A: every intermediate value and the final message,
//     byte for byte, from the RFC's fixed keys and salt
//   - RFC 8292 §2.4 / §3: the example JWT verifies with the example key; our
//     own JWTs verify, carry { aud, exp ≤ 24 h, sub } and the header format
//   - round trip with a fresh browser key; size cap; env validation

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import {
  audienceFor,
  b64url,
  decryptAes128gcm,
  encryptAes128gcm,
  fromB64url,
  generateVapidKeys,
  MAX_PLAINTEXT,
  signVapidJwt,
  vapidAuthorization,
  vapidConfigFromEnv,
  verifyVapidJwt,
} from "../vapid";

// RFC 8291, Appendix A ("Intermediate Values for Encryption").
const A = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  ecdhSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  prk: "09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

// RFC 8292 §2.4 (example JWT) and §3.2 (its public key).
const RFC8292_JWT =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA";
const RFC8292_KEY = "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs";

describe("aes128gcm (RFC 8291 Appendix A)", () => {
  const out = encryptAes128gcm({
    p256dh: A.uaPublic,
    auth: A.auth,
    plaintext: fromB64url(A.plaintext),
    asPrivateKey: fromB64url(A.asPrivate),
    salt: fromB64url(A.salt),
  });

  it("derives the same ECDH secret, IKM, PRK, CEK and nonce", () => {
    assert.equal(b64url(out.asPublicKey), A.asPublic);
    assert.equal(b64url(out.ecdhSecret), A.ecdhSecret);
    assert.equal(b64url(out.ikm), A.ikm);
    assert.equal(b64url(out.prk), A.prk);
    assert.equal(b64url(out.cek), A.cek);
    assert.equal(b64url(out.nonce), A.nonce);
  });

  it("produces the RFC's message byte for byte (salt, rs=4096, keyid, ciphertext)", () => {
    assert.equal(b64url(out.body), A.message);
  });

  it("the browser side decrypts it back to the plaintext", () => {
    const plain = decryptAes128gcm(fromB64url(A.message), fromB64url(A.uaPrivate), A.auth);
    assert.equal(plain.toString("utf8"), "When I grow up, I want to be a watermelon");
  });

  it("round-trips a fresh browser key with a random salt and ephemeral key", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = b64url(Buffer.from("0123456789abcdef"));
    const msg = JSON.stringify({ title: "Approval needed", body: "Refund #42", href: "/dashboard/approvals" });
    const a = encryptAes128gcm({ p256dh: b64url(ua.getPublicKey()), auth, plaintext: msg });
    const b = encryptAes128gcm({ p256dh: b64url(ua.getPublicKey()), auth, plaintext: msg });
    assert.notEqual(b64url(a.body), b64url(b.body), "salt + ephemeral key differ per message");
    assert.equal(decryptAes128gcm(a.body, ua.getPrivateKey(), auth).toString("utf8"), msg);
  });

  it("refuses a payload that would not fit one 4096-byte message, and malformed keys", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = b64url(Buffer.alloc(16, 1));
    assert.throws(() => encryptAes128gcm({ p256dh: b64url(ua.getPublicKey()), auth, plaintext: Buffer.alloc(MAX_PLAINTEXT + 1) }), /too large/);
    const max = encryptAes128gcm({ p256dh: b64url(ua.getPublicKey()), auth, plaintext: Buffer.alloc(MAX_PLAINTEXT) });
    assert.equal(max.body.length, 4096, "the cap is exactly one 4096-byte body");
    assert.throws(() => encryptAes128gcm({ p256dh: b64url(Buffer.alloc(33)), auth, plaintext: "x" }), /p256dh/);
    assert.throws(() => encryptAes128gcm({ p256dh: b64url(ua.getPublicKey()), auth: b64url(Buffer.alloc(8)), plaintext: "x" }), /auth/);
  });
});

describe("VAPID (RFC 8292)", () => {
  it("verifies the RFC's example JWT with the RFC's example key", () => {
    const v = verifyVapidJwt(RFC8292_JWT, RFC8292_KEY);
    assert.equal(v.ok, true);
    assert.deepEqual(v.claims, { aud: "https://push.example.net", exp: 1453523768, sub: "mailto:push@example.com" });
    assert.equal(verifyVapidJwt(RFC8292_JWT.replace(".i3CYb7", ".i3CYb8"), RFC8292_KEY).ok, false, "a tampered signature fails");
  });

  it("signs ES256 JWTs that verify, with aud = the push origin, exp ≤ 24 h and sub", () => {
    const keys = generateVapidKeys();
    const now = Date.UTC(2026, 9, 6, 12, 0, 0);
    const jwt = signVapidJwt({ audience: audienceFor("https://fcm.googleapis.com/fcm/send/abc:def"), subject: "mailto:ops@example.test", ...keys, now });
    const [h] = jwt.split(".");
    assert.deepEqual(JSON.parse(fromB64url(h!).toString()), { typ: "JWT", alg: "ES256" });
    const v = verifyVapidJwt(jwt, keys.publicKey);
    assert.equal(v.ok, true);
    assert.equal(v.claims?.aud, "https://fcm.googleapis.com");
    assert.equal(v.claims?.sub, "mailto:ops@example.test");
    assert.equal(v.claims?.exp, now / 1000 + 12 * 3600);
    const capped = signVapidJwt({ audience: "https://x.test", subject: "mailto:a@b.c", ...keys, now, expiresAt: now / 1000 + 48 * 3600 });
    assert.equal(verifyVapidJwt(capped, keys.publicKey).claims?.exp, now / 1000 + 24 * 3600, "never more than 24 h");
    assert.equal(fromB64url(jwt.split(".")[2]!).length, 64, "raw r||s signature (ieee-p1363)");
    assert.equal(vapidAuthorization(jwt, keys.publicKey), `vapid t=${jwt}, k=${keys.publicKey}`);
    assert.equal(verifyVapidJwt(jwt, generateVapidKeys().publicKey).ok, false, "another key does not verify it");
  });

  it("reads keys from env: off with a reason when missing or mismatched, on when valid", () => {
    const keys = generateVapidKeys();
    assert.deepEqual(vapidConfigFromEnv({} as NodeJS.ProcessEnv), { configured: false, reason: "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not set." });
    const bad = vapidConfigFromEnv({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: "ops" } as unknown as NodeJS.ProcessEnv);
    assert.equal(bad.configured, false);
    const mismatch = vapidConfigFromEnv({ VAPID_PUBLIC_KEY: generateVapidKeys().publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: "mailto:o@x.test" } as unknown as NodeJS.ProcessEnv);
    assert.equal(mismatch.configured, false);
    assert.match((mismatch as { reason: string }).reason, /does not match/);
    const ok = vapidConfigFromEnv({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: "https://shapes.example" } as unknown as NodeJS.ProcessEnv);
    assert.equal(ok.configured, true);
  });
});
