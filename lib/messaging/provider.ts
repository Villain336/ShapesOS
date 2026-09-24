// Marketr — R3 messaging core: provider abstraction (SMS + email).
//
// Mirrors the pattern in lib/calls/provider.ts: one interface, a fake
// provider for dev/tests, real providers behind env switches, and honest
// "not configured" errors when credentials are missing.
//
// Channels:
// - SMS:   Twilio (real) | FakeMessagingProvider (default).
// - Email: Resend (real) | FakeMessagingProvider (default).
//
// Env:
// - MESSAGING_SMS_PROVIDER   "twilio" | "fake"   (default "fake")
// - MESSAGING_EMAIL_PROVIDER "resend" | "fake"   (default "fake")
// - TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN (+ optional TWILIO_API_KEY/SECRET)
// - RESEND_API_KEY
// - FAKE_MESSAGING_SECRET    shared secret for the fake provider's webhook
//                            auth (dev default; set a real value in prod).
//
// Provider contract:
// - sendSms / sendEmail: deliver one message, return the provider SID.
// - validateWebhookSignature: authenticates inbound SMS webhooks.
//   Twilio: HMAC-SHA1(authToken, url + sortedParams) vs X-Twilio-Signature
//   (Twilio's documented algorithm — same as lib/calls/provider.ts).
//   Fake: HMAC-SHA256(secret, url + JSON(params)) vs X-Fake-Signature,
//   OR `Authorization: Bearer <FAKE_MESSAGING_SECRET>` (constant-time).

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Resend } from "resend";

export type SmsProviderName = "twilio" | "fake";
export type EmailProviderName = "resend" | "fake";

export interface SendSmsInput {
  to: string;
  /** Required by Twilio; ignored by the fake provider. */
  from?: string;
  body: string;
}

export interface SendEmailInput {
  to: string;
  from: string;
  fromName?: string;
  subject: string;
  /** Full HTML body (dispatcher composes the CAN-SPAM footer). */
  html: string;
  text?: string;
  headers?: Record<string, string>;
}

export interface SendResult {
  providerSid: string;
  /** SMS segments sent (GSM estimate); undefined for email. */
  segments?: number;
  /** True when the provider simulates delivery (fake provider). */
  delivered?: boolean;
}

export interface MessagingProvider {
  readonly name: string;
  sendSms(input: SendSmsInput): Promise<SendResult>;
  sendEmail(input: SendEmailInput): Promise<SendResult>;
  validateWebhookSignature(opts: {
    url: string;
    params: Record<string, string>;
    signature: string | null;
  }): boolean;
}

export class ProviderNotConfiguredError extends Error {
  constructor(provider: string, missing: string) {
    super(`${provider} provider is not configured (missing ${missing})`);
    this.name = "ProviderNotConfiguredError";
  }
}

// ---------------------------------------------------------------------------
// Twilio SMS (real). Not exercised without TWILIO_ACCOUNT_SID/AUTH_TOKEN.
// ---------------------------------------------------------------------------

const TWILIO_API = "https://api.twilio.com/2010-04-01";

/** GSM-7 estimate: 160 chars/segment for single-part, 153 for multipart. */
export function smsSegments(body: string): number {
  const len = body.length;
  if (len <= 160) return 1;
  return Math.ceil(len / 153);
}

export class TwilioMessagingProvider implements MessagingProvider {
  readonly name: SmsProviderName = "twilio";
  private accountSid: string;
  private authToken: string;
  private apiKey?: string;
  private apiSecret?: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const sid = (env.TWILIO_ACCOUNT_SID ?? "").trim();
    const token = (env.TWILIO_AUTH_TOKEN ?? "").trim();
    if (!sid) throw new ProviderNotConfiguredError("twilio", "TWILIO_ACCOUNT_SID");
    if (!token) throw new ProviderNotConfiguredError("twilio", "TWILIO_AUTH_TOKEN");
    this.accountSid = sid;
    this.authToken = token;
    this.apiKey = (env.TWILIO_API_KEY ?? "").trim() || undefined;
    this.apiSecret = (env.TWILIO_API_SECRET ?? "").trim() || undefined;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const user = this.apiKey ?? this.accountSid;
    const pass = this.apiSecret ?? this.authToken;
    const res = await fetch(`${TWILIO_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(init.headers ?? {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`Twilio API ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    }
    return body;
  }

  async sendSms(input: SendSmsInput): Promise<SendResult> {
    if (!input.to) throw new Error("Twilio sendSms: missing recipient");
    if (!input.from) {
      throw new ProviderNotConfiguredError(
        "twilio",
        "MESSAGING_SMS_FROM or workspace messaging.smsFromNumber",
      );
    }
    const params = new URLSearchParams();
    params.set("To", input.to);
    params.set("From", input.from);
    params.set("Body", input.body);
    const body = (await this.request(`/Accounts/${this.accountSid}/Messages.json`, {
      method: "POST",
      body: params.toString(),
    })) as { sid?: string; num_segments?: string };
    if (!body.sid) throw new Error("Twilio Messages API returned no SID");
    return {
      providerSid: body.sid,
      segments: body.num_segments ? Number(body.num_segments) : smsSegments(input.body),
    };
  }

  async sendEmail(_input: SendEmailInput): Promise<SendResult> {
    throw new Error(
      "Twilio SMS provider does not send email — set MESSAGING_EMAIL_PROVIDER=resend",
    );
  }

  validateWebhookSignature(opts: {
    url: string;
    params: Record<string, string>;
    signature: string | null;
  }): boolean {
    if (!opts.signature) return false;
    const data = Object.keys(opts.params)
      .sort()
      .reduce((acc, k) => acc + k + opts.params[k], opts.url);
    const expected = createHmac("sha1", this.authToken).update(data, "utf8").digest("base64");
    const a = Buffer.from(expected);
    const b = Buffer.from(opts.signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

// ---------------------------------------------------------------------------
// Resend email (real). Not exercised without RESEND_API_KEY.
// ---------------------------------------------------------------------------

export class ResendEmailProvider implements MessagingProvider {
  readonly name: EmailProviderName = "resend";
  private resend: Resend;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const apiKey = (env.RESEND_API_KEY ?? "").trim();
    if (!apiKey) throw new ProviderNotConfiguredError("resend", "RESEND_API_KEY");
    this.resend = new Resend(apiKey);
  }

  async sendSms(_input: SendSmsInput): Promise<SendResult> {
    throw new Error(
      "Resend email provider does not send SMS — set MESSAGING_SMS_PROVIDER=twilio",
    );
  }

  async sendEmail(input: SendEmailInput): Promise<SendResult> {
    if (!input.to) throw new Error("Resend sendEmail: missing recipient");
    if (!input.from) throw new Error("Resend sendEmail: missing sender");
    const from = input.fromName ? `${input.fromName} <${input.from}>` : input.from;
    const res = await this.resend.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      headers: input.headers,
    });
    if (res.error) {
      const e = res.error as { message?: string; name?: string };
      throw new Error(`Resend send failed: ${e.message ?? e.name ?? "unknown error"}`);
    }
    const id = (res.data as { id?: string } | null)?.id;
    if (!id) throw new Error("Resend send returned no id");
    return { providerSid: id };
  }

  validateWebhookSignature(_opts: {
    url: string;
    params: Record<string, string>;
    signature: string | null;
  }): boolean {
    // Resend has no inbound SMS webhook; nothing to validate.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fake provider (tests, dev, and this environment).
// ---------------------------------------------------------------------------

/** Fake message SIDs: FAKESM / FAKEEM + 32 hex chars. */
export function fakeMessageSid(prefix: "FAKESM" | "FAKEEM", seed = ""): string {
  const hex = seed
    ? createHash("sha256").update(seed).digest("hex").slice(0, 32)
    : randomBytes(16).toString("hex");
  return `${prefix}${hex.toUpperCase()}`;
}

export function fakeMessagingSecret(env: NodeJS.ProcessEnv = process.env): string {
  return (env.FAKE_MESSAGING_SECRET ?? "fake-messaging-dev-secret").trim();
}

export class FakeMessagingProvider implements MessagingProvider {
  readonly name = "fake" as const;
  private static counter = 0;

  static resetCounter(): void {
    FakeMessagingProvider.counter = 0;
  }

  async sendSms(input: SendSmsInput): Promise<SendResult> {
    FakeMessagingProvider.counter += 1;
    const sid = fakeMessageSid("FAKESM", `${Date.now()}:${FakeMessagingProvider.counter}`);
    // eslint-disable-next-line no-console
    console.log(
      `[messaging:fake:sms] to=${input.to} segments=${smsSegments(input.body)} sid=${sid} body=${input.body.slice(0, 120)}`,
    );
    // Simulated delivery: the fake provider "delivers" instantly.
    return { providerSid: sid, segments: smsSegments(input.body), delivered: true };
  }

  async sendEmail(input: SendEmailInput): Promise<SendResult> {
    FakeMessagingProvider.counter += 1;
    const sid = fakeMessageSid("FAKEEM", `${Date.now()}:${FakeMessagingProvider.counter}`);
    // eslint-disable-next-line no-console
    console.log(
      `[messaging:fake:email] to=${input.to} subject=${input.subject} sid=${sid} headers=${JSON.stringify(input.headers ?? {})}`,
    );
    return { providerSid: sid, delivered: true };
  }

  validateWebhookSignature(opts: {
    url: string;
    params: Record<string, string>;
    signature: string | null;
    env?: NodeJS.ProcessEnv;
  }): boolean {
    if (!opts.signature) return false;
    const secret = fakeMessagingSecret(opts.env ?? process.env);
    // Path 1: Authorization: Bearer <FAKE_MESSAGING_SECRET>.
    const bearer = `Bearer ${secret}`;
    const b = Buffer.from(opts.signature);
    const e = Buffer.from(bearer);
    if (b.length === e.length && timingSafeEqual(b, e)) return true;
    // Path 2: X-Fake-Signature HMAC (mirrors lib/calls/provider.ts).
    const expected = createHmac("sha256", secret)
      .update(opts.url + JSON.stringify(opts.params))
      .digest("hex");
    const a = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/** Resolve the active SMS provider. Defaults to fake. Throws
 * ProviderNotConfiguredError when "twilio" is selected without credentials. */
export function getSmsProvider(env: NodeJS.ProcessEnv = process.env): MessagingProvider {
  const name = ((env.MESSAGING_SMS_PROVIDER ?? "fake") as string).trim().toLowerCase();
  if (name === "twilio") return new TwilioMessagingProvider(env);
  return new FakeMessagingProvider();
}

/** Resolve the active email provider. Defaults to fake. Throws
 * ProviderNotConfiguredError when "resend" is selected without RESEND_API_KEY. */
export function getEmailProvider(env: NodeJS.ProcessEnv = process.env): MessagingProvider {
  const name = ((env.MESSAGING_EMAIL_PROVIDER ?? "fake") as string).trim().toLowerCase();
  if (name === "resend") return new ResendEmailProvider(env);
  return new FakeMessagingProvider();
}

/** Sign a fake-messaging webhook (tests). */
export function signFakeMessagingWebhook(
  url: string,
  params: Record<string, string>,
  secret = "fake-messaging-dev-secret",
): string {
  return createHmac("sha256", secret).update(url + JSON.stringify(params)).digest("hex");
}
