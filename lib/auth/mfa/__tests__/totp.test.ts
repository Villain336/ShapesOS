// ShapesOS Phase 4a — TOTP against the RFC 6238 Appendix B test vectors,
// the ±1 step window, replay refusal, and recovery-code format/hashing.
// Run: npx tsx --test lib/auth/mfa/__tests__/totp.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from "../totp";
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCodes,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  normalizeRecoveryCode,
} from "../recovery";

// RFC 6238 Appendix B: seeds are the ASCII strings below; 8-digit codes.
const SEED_SHA1 = Buffer.from("12345678901234567890", "ascii");
const SEED_SHA256 = Buffer.from("12345678901234567890123456789012", "ascii");
const SEED_SHA512 = Buffer.from("1234567890123456789012345678901234567890123456789012345678901234", "ascii");

const VECTORS: Array<[number, string, string, string]> = [
  // [unix seconds, SHA1, SHA256, SHA512]
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

describe("RFC 6238 Appendix B vectors", () => {
  for (const [t, sha1, sha256, sha512] of VECTORS) {
    it(`T=${t}`, () => {
      const step = totpStep(t * 1000);
      assert.equal(hotp(SEED_SHA1, step, 8, "sha1"), sha1);
      assert.equal(hotp(SEED_SHA256, step, 8, "sha256"), sha256);
      assert.equal(hotp(SEED_SHA512, step, 8, "sha512"), sha512);
    });
  }

  it("6-digit codes are the low digits of the same value (what apps show)", () => {
    const secret = base32Encode(SEED_SHA1);
    assert.equal(totpCode(secret, 59_000), "287082");
    assert.equal(totpCode(secret, 1111111109_000), "081804");
  });
});

describe("base32", () => {
  it("round-trips and matches RFC 4648", () => {
    assert.equal(base32Encode(Buffer.from("foobar")), "MZXW6YTBOI");
    assert.deepEqual(base32Decode("mzxw6ytboi"), Buffer.from("foobar"));
    assert.deepEqual(base32Decode("MZXW 6YTB-OI======"), Buffer.from("foobar"));
    const s = generateTotpSecret();
    assert.match(s, /^[A-Z2-7]{32}$/);
    assert.equal(base32Decode(s).length, 20);
  });

  it("rejects non-alphabet characters", () => {
    assert.throws(() => base32Decode("MZXW1"));
  });
});

describe("verifyTotp", () => {
  const secret = base32Encode(SEED_SHA1);
  const now = 1_700_000_000_000;

  it("accepts the current step and ±1 step, not ±2", () => {
    for (const d of [-1, 0, 1]) {
      const code = totpCode(secret, now + d * 30_000);
      const r = verifyTotp(secret, code, { nowMs: now });
      assert.equal(r.ok, true, `offset ${d}`);
      if (r.ok) assert.equal(r.step, totpStep(now) + d);
    }
    for (const d of [-2, 2]) {
      const r = verifyTotp(secret, totpCode(secret, now + d * 30_000), { nowMs: now });
      assert.deepEqual(r, { ok: false, reason: "mismatch" });
    }
  });

  it("refuses a replay: a step at or below the last accepted step", () => {
    const code = totpCode(secret, now);
    const first = verifyTotp(secret, code, { nowMs: now });
    assert.equal(first.ok, true);
    const step = first.ok ? first.step : -1;
    assert.deepEqual(verifyTotp(secret, code, { nowMs: now, lastStep: step }), { ok: false, reason: "replay" });
    // An older (still in-window) code is also refused once a newer one was used.
    const older = totpCode(secret, now - 30_000);
    assert.deepEqual(verifyTotp(secret, older, { nowMs: now, lastStep: step }), { ok: false, reason: "replay" });
    // The next step's code still works.
    assert.equal(verifyTotp(secret, totpCode(secret, now + 30_000), { nowMs: now, lastStep: step }).ok, true);
  });

  it("tolerates spaces/dashes and rejects malformed input", () => {
    const code = totpCode(secret, now);
    assert.equal(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { nowMs: now }).ok, true);
    assert.deepEqual(verifyTotp(secret, "12345", { nowMs: now }), { ok: false, reason: "format" });
    assert.deepEqual(verifyTotp(secret, "abcdef", { nowMs: now }), { ok: false, reason: "format" });
  });

  it("builds an otpauth:// URI apps understand", () => {
    const uri = otpauthUri({ secret: "JBSWY3DPEHPK3PXP", accountName: "ada@example.com" });
    assert.match(uri, /^otpauth:\/\/totp\/ShapesOS:ada%40example\.com\?/);
    const params = new URL(uri.replace("otpauth://", "https://")).searchParams;
    assert.equal(params.get("secret"), "JBSWY3DPEHPK3PXP");
    assert.equal(params.get("issuer"), "ShapesOS");
    assert.equal(params.get("digits"), "6");
    assert.equal(params.get("period"), "30");
  });
});

describe("recovery codes", () => {
  it("10 unique 80-bit codes, formatted xxxx-xxxx-xxxx-xxxx", () => {
    const codes = generateRecoveryCodes();
    assert.equal(codes.length, RECOVERY_CODE_COUNT);
    assert.equal(new Set(codes).size, RECOVERY_CODE_COUNT);
    for (const c of codes) {
      assert.match(c, /^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
      assert.ok(looksLikeRecoveryCode(c));
    }
  });

  it("hash is stable under case/separators and never equals the code", () => {
    const [c] = generateRecoveryCodes(1);
    assert.equal(hashRecoveryCode(c), hashRecoveryCode(c.toUpperCase().replace(/-/g, " ")));
    assert.notEqual(hashRecoveryCode(c), normalizeRecoveryCode(c));
    assert.match(hashRecoveryCode(c), /^[0-9a-f]{64}$/);
    assert.ok(!looksLikeRecoveryCode("123456"));
  });
});
