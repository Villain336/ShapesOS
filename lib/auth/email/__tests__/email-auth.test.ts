// ShapesOS — Phase 6 email accounts: pure units (no database).
//   password hashing + constant-time verify, token generation + hashing,
//   password policy, email normalization, subject ids, mail delivery rules.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMMON_PASSWORDS,
  PASSWORD_MIN_LENGTH,
  SCRYPT_PARAMS,
  hashPassword,
  needsRehash,
  parsePasswordHash,
  passwordPolicyError,
  verifyPassword,
} from "../password";
import {
  TOKEN_TTL_MS,
  cleanName,
  emailFromUserId,
  emailUserId,
  generateEmailToken,
  hashEmailToken,
  isEmailUserId,
  looksLikeEmailToken,
  normalizeEmail,
  tokenExpiry,
} from "../tokens";
import { emailAuthBaseUrl, emailAuthDelivery, emailAuthEnabled, renderAuthEmail, sendAuthEmail, tokenLink } from "../mail";
import { firstFactorMethod } from "@/lib/auth/mfa/session-token";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("password hashing", () => {
  it("hashes with explicit scrypt parameters and a random salt", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    assert.notEqual(a, b, "salted");
    assert.match(a, /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    const parsed = parsePasswordHash(a)!;
    assert.equal(parsed.N, SCRYPT_PARAMS.N);
    assert.equal(parsed.salt.length, 16);
    assert.equal(parsed.key.length, 32);
    assert.ok(!a.includes("correct horse"));
  });

  it("verifies the right password only", async () => {
    const h = await hashPassword("correct horse battery");
    assert.equal(await verifyPassword("correct horse battery", h), true);
    assert.equal(await verifyPassword("correct horse batterY", h), false);
    assert.equal(await verifyPassword("", h), false);
  });

  it("normalizes Unicode (NFKC) before hashing", async () => {
    const h = await hashPassword("café-password");
    assert.equal(await verifyPassword("café-password", h), true);
  });

  it("never matches malformed, tampered or absurd hashes", async () => {
    for (const bad of [null, undefined, "", "plain", "bcrypt$x", "scrypt$3$8$1$c2FsdHNhbHQ$a2V5a2V5a2V5a2V5", "scrypt$1048577$8$1$c2FsdHNhbHQ$a2V5a2V5a2V5a2V5a2V5"]) {
      assert.equal(await verifyPassword("anything at all", bad as string), false);
    }
    // N above the cap (2^21) is refused before scrypt runs.
    assert.equal(parsePasswordHash("scrypt$2097152$8$1$c2FsdHNhbHRz$a2V5a2V5a2V5a2V5a2V5a2V5"), null);
  });

  it("flags weaker parameters for rehash", async () => {
    assert.equal(needsRehash(await hashPassword("correct horse battery")), false);
    assert.equal(needsRehash("scrypt$16384$8$1$c2FsdHNhbHRz$a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5"), true);
    assert.equal(needsRehash(null), true);
  });
});

describe("password policy", () => {
  it("requires a minimum length", () => {
    assert.match(passwordPolicyError("short1!")!, /at least 10/);
    assert.equal(passwordPolicyError("x".repeat(PASSWORD_MIN_LENGTH - 1) + "y"), null);
    assert.match(passwordPolicyError("")!, /Enter a password/);
    assert.match(passwordPolicyError(undefined)!, /Enter a password/);
    assert.match(passwordPolicyError("a".repeat(300))!, /at most/);
  });
  it("refuses common passwords (case-insensitive) and repeated characters", () => {
    assert.ok(COMMON_PASSWORDS.size >= 50);
    assert.match(passwordPolicyError("Password123")!, /too common/);
    assert.match(passwordPolicyError("QWERTYUIOP")!, /too common/);
    assert.match(passwordPolicyError("aaaaaaaaaaaa")!, /repeat/);
  });
  it("refuses the email address itself", () => {
    assert.match(passwordPolicyError("ana.lopez@example.com", { email: "ana.lopez@example.com" })!, /email/);
    assert.match(passwordPolicyError("ana.lopez1!", { email: "ana.lopez@example.com" })!, /email/);
    assert.equal(passwordPolicyError("tangerine-orbit-42", { email: "ana.lopez@example.com" }), null);
  });
});

describe("email normalization + subject ids", () => {
  it("trims, lower-cases and shape-checks", () => {
    assert.equal(normalizeEmail("  Ana.Lopez@Example.COM "), "ana.lopez@example.com");
    assert.equal(normalizeEmail("a+tag@sub.example.co.uk"), "a+tag@sub.example.co.uk");
    for (const bad of ["", "ana", "ana@", "@example.com", "ana@example", "ana lopez@example.com", "a..b@example.com", ".a@example.com", "a@-x.com", 42, null, `${"a".repeat(65)}@example.com`, `a@${"b".repeat(250)}.com`]) {
      assert.equal(normalizeEmail(bad), null, String(bad));
    }
  });
  it("builds and parses the stable subject", () => {
    assert.equal(emailUserId("ana@example.com"), "email:ana@example.com");
    assert.equal(isEmailUserId("email:ana@example.com"), true);
    assert.equal(isEmailUserId("admin:ana@example.com"), false);
    assert.equal(isEmailUserId("email:"), false);
    assert.equal(emailFromUserId("email:ana@example.com"), "ana@example.com");
    assert.equal(emailFromUserId("google:123"), null);
  });
  it("cleans display names", () => {
    assert.equal(cleanName("  Ana\n  Lopez "), "Ana Lopez");
    assert.equal(cleanName("   "), null);
    assert.equal(cleanName("x".repeat(200))!.length, 80);
    assert.equal(cleanName(5), null);
  });
  it("maps the email providers to their first-factor method", () => {
    assert.equal(firstFactorMethod("email-password"), "pwd");
    assert.equal(firstFactorMethod("email-link"), "email");
    assert.equal(firstFactorMethod("credentials"), "pwd");
    assert.equal(firstFactorMethod("google"), "sso");
  });
});

describe("one-time tokens", () => {
  it("are 256-bit base64url and unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = generateEmailToken();
      assert.equal(looksLikeEmailToken(t), true);
      seen.add(t);
    }
    assert.equal(seen.size, 200);
    assert.equal(looksLikeEmailToken("short"), false);
    assert.equal(looksLikeEmailToken("a".repeat(43) + "!"), false);
    assert.equal(looksLikeEmailToken(null), false);
  });
  it("are stored as SHA-256 hex, never as themselves", () => {
    const t = generateEmailToken();
    const h = hashEmailToken(t);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(hashEmailToken(t), h);
    assert.notEqual(h, t);
    assert.notEqual(hashEmailToken(generateEmailToken()), h);
  });
  it("expire per purpose", () => {
    const now = new Date("2026-10-04T12:00:00Z");
    assert.equal(tokenExpiry("login", now).getTime() - now.getTime(), 15 * 60_000);
    assert.equal(tokenExpiry("reset", now).getTime() - now.getTime(), TOKEN_TTL_MS.reset);
    assert.equal(tokenExpiry("verify", now).getTime() - now.getTime(), 24 * 3_600_000);
  });
});

describe("email delivery rules", () => {
  it("uses SMTP, then Resend, then the console only outside production", () => {
    assert.equal(emailAuthDelivery(env({ SMTP_HOST: "smtp.x", SMTP_FROM: "a@x", NODE_ENV: "production" })), "smtp");
    assert.equal(emailAuthDelivery(env({ RESEND_API_KEY: "re_x", INVITE_MAIL_FROM: "a@x", NODE_ENV: "production" })), "resend");
    assert.equal(emailAuthDelivery(env({ NODE_ENV: "development" })), "console");
    assert.equal(emailAuthDelivery(env({ NODE_ENV: "production" })), null);
  });
  it("is disabled in production without a mailer or without a configured URL", () => {
    assert.equal(emailAuthEnabled(env({ NODE_ENV: "production" })), false);
    assert.equal(emailAuthEnabled(env({ NODE_ENV: "production", SMTP_HOST: "h", SMTP_FROM: "f" })), false);
    assert.equal(emailAuthEnabled(env({ NODE_ENV: "production", SMTP_HOST: "h", SMTP_FROM: "f", APP_URL: "https://app.example.com" })), true);
    assert.equal(emailAuthEnabled(env({ NODE_ENV: "development" })), true);
  });
  it("never builds production links from the request Host", () => {
    assert.equal(emailAuthBaseUrl(env({ NODE_ENV: "production" }), "https://evil.example"), null);
    assert.equal(emailAuthBaseUrl(env({ NODE_ENV: "production", APP_URL: "https://app.example.com/x" }), "https://evil.example"), "https://app.example.com");
    assert.equal(emailAuthBaseUrl(env({ NODE_ENV: "development" }), "http://localhost:3000"), "http://localhost:3000");
  });
  it("puts the token in the fragment and the right page", () => {
    assert.equal(tokenLink("https://a.test", "login", "tok"), "https://a.test/login/link#token=tok");
    assert.equal(tokenLink("https://a.test", "verify", "tok"), "https://a.test/login/link#token=tok");
    assert.equal(tokenLink("https://a.test", "reset", "tok"), "https://a.test/reset-password#token=tok");
  });
  it("renders escaped, sentence-case emails", () => {
    const m = renderAuthEmail({ kind: "reset", to: "a@b.c", url: 'https://a.test/reset-password#token=x"<' });
    assert.equal(m.subject, "Reset your ShapesOS password");
    assert.ok(m.html.includes("&quot;&lt;"));
    assert.ok(!m.html.includes('x"<'));
    assert.ok(m.text.includes("expires in 60 minutes"));
  });
  it("refuses to send in production without a mailer; prints only in development", async () => {
    const prod = await sendAuthEmail({ kind: "login", to: "a@b.c", url: "https://x/#token=t" }, { env: env({ NODE_ENV: "production" }) });
    assert.deepEqual(prod, { sent: false, reason: "not_configured" });
    const logged: string[] = [];
    const orig = console.info;
    console.info = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      const dev = await sendAuthEmail({ kind: "login", to: "a@b.c", url: "https://x/#token=t" }, { env: env({ NODE_ENV: "development" }) });
      assert.deepEqual(dev, { sent: true, via: "console" });
    } finally {
      console.info = orig;
    }
    assert.equal(logged.length, 1);
    assert.ok(logged[0]!.includes("https://x/#token=t"));
  });
  it("reports a failed delivery without echoing the provider error", async () => {
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      const res = await sendAuthEmail(
        { kind: "login", to: "a@b.c", url: "https://x/#token=secret-token" },
        {
          env: env({ NODE_ENV: "production", SMTP_HOST: "h", SMTP_FROM: "f" }),
          deliver: async () => {
            throw Object.assign(new Error("boom https://x/#token=secret-token"), { code: "ECONNREFUSED" });
          },
        },
      );
      assert.deepEqual(res, { sent: false, reason: "send_failed" });
    } finally {
      console.error = orig;
    }
    assert.ok(errs.join(" ").includes("ECONNREFUSED"));
    assert.ok(!errs.join(" ").includes("secret-token"));
  });
});
