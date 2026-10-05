// ShapesOS — Phase 1 (H4) tests: production fails closed when secrets are
// unset, and fake providers are refused in production unless opted in.
// Run: npx tsx --test lib/env/__tests__/secrets.test.ts

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  assertFakeProviderAllowed,
  FakeProviderRefusedError,
  fakeProvidersAllowed,
  MissingSecretError,
  requireSecret,
} from "../secrets";
import { fakeMessagingSecret, getEmailProvider, getSmsProvider } from "@/lib/messaging/provider";
import { getProvider as getTelephonyProvider, FakeTelephonyProvider } from "@/lib/calls/provider";
import { fakeMailSecret } from "@/lib/mail/fake";
import { fakeCallRailSecret, FakeCallRailProvider } from "@/lib/media/callrail";
import { signUnsubscribeToken } from "@/lib/messaging/consent";
import { approvalReceiptSecret } from "@/lib/media/safety";
import { pixelSigningSecret } from "@/lib/flywheel/ctv/attribution";
import { webhookSecret as gbpWebhookSecret } from "@/lib/authority/reviews/intake";
import { ingestMailWebhook } from "@/lib/mail/webhooks";

const PROD = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
const DEV = { NODE_ENV: "development" } as NodeJS.ProcessEnv;

const isMissing = (name: string) => (e: unknown) => e instanceof MissingSecretError && e.envVar === name;

describe("requireSecret", () => {
  it("throws in production when unset or blank", () => {
    assert.throws(() => requireSecret("X_SECRET", "dev", PROD), isMissing("X_SECRET"));
    assert.throws(() => requireSecret("X_SECRET", "dev", { ...PROD, X_SECRET: "   " }), isMissing("X_SECRET"));
  });
  it("returns the configured value in production", () => {
    assert.equal(requireSecret("X_SECRET", "dev", { ...PROD, X_SECRET: " s3cret " }), "s3cret");
  });
  it("keeps the dev fallback outside production", () => {
    assert.equal(requireSecret("X_SECRET", "dev-fallback", DEV), "dev-fallback");
  });
});

describe("every shipped fallback secret fails closed in production (H4)", () => {
  const cases: Array<[string, (env: NodeJS.ProcessEnv) => unknown]> = [
    ["FAKE_MESSAGING_SECRET", (env) => fakeMessagingSecret(env)],
    ["FAKE_MAIL_SECRET", (env) => fakeMailSecret(env)],
    ["FAKE_CALLRAIL_SECRET", (env) => fakeCallRailSecret(env)],
    ["MESSAGING_UNSUBSCRIBE_SECRET", (env) => signUnsubscribeToken({ workspaceId: "w", messageId: "m" }, env)],
    ["MARKETR_APPROVAL_SECRET", (env) => approvalReceiptSecret(env)],
    ["PIXEL_SIGNING_SECRET", (env) => pixelSigningSecret(env)],
  ];
  for (const [name, read] of cases) {
    it(`${name}: throws when unset in production, works when set`, () => {
      assert.throws(() => read(PROD), isMissing(name));
      assert.doesNotThrow(() => read({ ...PROD, [name]: "configured" }));
      assert.doesNotThrow(() => read(DEV));
    });
  }

  describe("secrets read from process.env", () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    });

    it("MARKETR_GBP_WEBHOOK_SECRET (GBP review intake)", () => {
      (process.env as Record<string, string>).NODE_ENV = "production";
      delete process.env.MARKETR_GBP_WEBHOOK_SECRET;
      assert.throws(() => gbpWebhookSecret(), isMissing("MARKETR_GBP_WEBHOOK_SECRET"));
      process.env.MARKETR_GBP_WEBHOOK_SECRET = "configured";
      assert.equal(gbpWebhookSecret(), "configured");
    });

    it("FAKE_TELEPHONY_SECRET / FAKE_CALLRAIL_SECRET: the literal dev bearer is rejected in production", () => {
      (process.env as Record<string, string>).NODE_ENV = "production";
      delete process.env.FAKE_TELEPHONY_SECRET;
      delete process.env.FAKE_CALLRAIL_SECRET;
      assert.throws(
        () =>
          new FakeTelephonyProvider().validateWebhookSignature({
            url: "https://x/api/calls/webhook",
            params: {},
            signature: "Bearer fake-telephony-dev-secret",
          }),
        isMissing("FAKE_TELEPHONY_SECRET"),
      );
      assert.throws(
        () =>
          new FakeCallRailProvider().validateWebhookSignature({
            rawBody: "{}",
            signature: "Bearer fake-callrail-dev-secret",
          }),
        isMissing("FAKE_CALLRAIL_SECRET"),
      );
    });
  });
});

describe("fake providers are refused in production unless ALLOW_FAKE_PROVIDERS=1", () => {
  const refused = (e: unknown) => e instanceof FakeProviderRefusedError;

  it("policy helper", () => {
    assert.equal(fakeProvidersAllowed(DEV), true);
    assert.equal(fakeProvidersAllowed(PROD), false);
    assert.equal(fakeProvidersAllowed({ ...PROD, ALLOW_FAKE_PROVIDERS: "1" }), true);
    assert.throws(() => assertFakeProviderAllowed("x", PROD), refused);
  });

  it("SMS / email / telephony resolvers", () => {
    assert.throws(() => getSmsProvider(PROD), refused);
    assert.throws(() => getEmailProvider(PROD), refused);
    assert.throws(() => getTelephonyProvider(PROD), refused);
    const optIn = { ...PROD, ALLOW_FAKE_PROVIDERS: "1" };
    assert.equal(getSmsProvider(optIn).name, "fake");
    assert.equal(getEmailProvider(optIn).name, "fake");
    assert.equal(getTelephonyProvider(optIn).name, "fake");
    assert.equal(getSmsProvider(DEV).name, "fake");
  });

  it("opting in still requires an explicit fake secret (no literal bearer)", () => {
    const optIn = { ...PROD, ALLOW_FAKE_PROVIDERS: "1" };
    const sms = getSmsProvider(optIn);
    assert.throws(
      () =>
        sms.validateWebhookSignature({
          url: "https://x/api/messaging/inbound/sms",
          params: { From: "+15550001111", To: "+15550002222", Body: "START" },
          signature: "Bearer fake-messaging-dev-secret",
          env: optIn,
        } as Parameters<typeof sms.validateWebhookSignature>[0]),
      isMissing("FAKE_MESSAGING_SECRET"),
    );
  });

  it("fake mail webhooks are rejected in production before any lookup", async () => {
    const res = await ingestMailWebhook({
      providerName: "fake",
      rawBody: "{}",
      signature: "Bearer fake-mail-dev-secret",
      env: PROD,
    } as Parameters<typeof ingestMailWebhook>[0]);
    assert.equal(res.accepted, false);
  });
});
