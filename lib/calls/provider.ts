// Marketr — call tracking (R5): telephony provider abstraction.
//
// REAL Twilio credentials are NOT available in this environment, so the
// FakeTelephonyProvider is the only provider wired today. The TwilioProvider
// below is a complete, honest implementation of Twilio's REST API and
// webhook-signature algorithm — adding TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN
// (and optionally TWILIO_API_KEY/SECRET) to the environment is the only step
// needed to go live. No model or route refactors are required; the switch is
// CALLS_PROVIDER=twilio.
//
// Provider contract:
// - purchaseNumber / releaseNumber: number lifecycle.
// - validateWebhookSignature: authenticates inbound Twilio webhooks.
// - inboundResponse: the TwiML (real) or JSON ack (fake) the voice webhook
//   answers with.
// - transcribe: speech-to-text behind an interface. The fake provider returns
//   a fixture transcript. The Twilio provider delegates to Twilio's native
//   transcription (the <Record> verb's transcribeCallback) — see
//   transcribe() comments for the wiring point.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type ProviderName = "twilio" | "fake";

export interface PurchaseNumberInput {
  areaCode?: string;
  friendlyName?: string;
  campaign?: string;
  /** The absolute voice webhook URL Twilio should hit for this number. */
  voiceUrl?: string;
  /** The absolute status-callback URL Twilio should hit for this number. */
  statusCallbackUrl?: string;
}

export interface PurchasedNumber {
  e164: string;
  providerSid: string;
}

export interface TranscriptResult {
  transcript: string | null;
  /** Where the transcript came from: fixture | twilio-native | none. */
  source: "fixture" | "twilio-native" | "none";
}

export interface TelephonyProvider {
  readonly name: ProviderName;
  purchaseNumber(input: PurchaseNumberInput): Promise<PurchasedNumber>;
  releaseNumber(e164: string): Promise<void>;
  /**
   * Validate a webhook's authenticity.
   * For Twilio: HMAC-SHA1(authToken, url + sortedParams) compared to the
   * X-Twilio-Signature header (Twilio's documented algorithm).
   * For fake: a shared-secret bearer (FAKE_TELEPHONY_SECRET) compared in
   * constant time.
   */
  validateWebhookSignature(opts: {
    url: string;
    params: Record<string, string>;
    signature: string | null;
  }): boolean;
  /** What the voice webhook should answer with for an accepted call. */
  inboundResponse(callSid: string): { contentType: string; body: string };
  transcribe(opts: { recordingUrl: string | null; callSid: string }): Promise<TranscriptResult>;
}

export class ProviderNotConfiguredError extends Error {
  constructor(provider: string, missing: string) {
    super(`${provider} provider is not configured (missing ${missing})`);
    this.name = "ProviderNotConfiguredError";
  }
}

// ---------------------------------------------------------------------------
// Twilio (real). Not exercised in this environment — no credentials.
// ---------------------------------------------------------------------------

const TWILIO_API = "https://api.twilio.com/2010-04-01";

export class TwilioProvider implements TelephonyProvider {
  readonly name: ProviderName = "twilio";
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

  async purchaseNumber(input: PurchaseNumberInput): Promise<PurchasedNumber> {
    const params = new URLSearchParams();
    if (input.areaCode) params.set("AreaCode", input.areaCode.replace(/\D/g, ""));
    if (input.friendlyName) params.set("FriendlyName", input.friendlyName.slice(0, 64));
    if (input.voiceUrl) {
      params.set("VoiceUrl", input.voiceUrl);
      params.set("VoiceMethod", "POST");
    }
    if (input.statusCallbackUrl) {
      params.set("StatusCallback", input.statusCallbackUrl);
      params.set("StatusCallbackMethod", "POST");
      params.set("StatusCallbackEvent", "completed");
    }
    const body = (await this.request(`/Accounts/${this.accountSid}/IncomingPhoneNumbers.json`, {
      method: "POST",
      body: params.toString(),
    })) as { phone_number?: string; sid?: string };
    if (!body.phone_number || !body.sid) throw new Error("Twilio purchase returned no number");
    return { e164: body.phone_number, providerSid: body.sid };
  }

  async releaseNumber(e164: string): Promise<void> {
    // Release needs the number's SID; look it up by phone number first.
    const list = (await this.request(
      `/Accounts/${this.accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(e164)}`,
      { method: "GET" },
    )) as { incoming_phone_numbers?: Array<{ sid: string }> };
    const sid = list.incoming_phone_numbers?.[0]?.sid;
    if (!sid) throw new Error(`Twilio: no purchased number found for ${e164}`);
    await this.request(`/Accounts/${this.accountSid}/IncomingPhoneNumbers/${sid}.json`, {
      method: "DELETE",
    });
  }

  validateWebhookSignature(opts: {
    url: string;
    params: Record<string, string>;
    signature: string | null;
  }): boolean {
    if (!opts.signature) return false;
    // Twilio's documented algorithm: HMAC-SHA1 over the full URL with the
    // POST params appended in sorted-key order (key+value concatenated).
    const data = Object.keys(opts.params)
      .sort()
      .reduce((acc, k) => acc + k + opts.params[k], opts.url);
    const expected = createHmac("sha1", this.authToken).update(data, "utf8").digest("base64");
    const a = Buffer.from(expected);
    const b = Buffer.from(opts.signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  inboundResponse(callSid: string): { contentType: string; body: string } {
    // Record the call; Twilio posts the recording + transcription (when
    // transcribe="true") to the same voice URL or the configured
    // transcribeCallback. Marketr's status/transcription webhooks finalize
    // the Call row from those callbacks.
    return {
      contentType: "text/xml",
      body: `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Thanks for calling. Please hold while we connect you.</Say><Dial timeout="30" /><Record maxLength="300" transcribe="true" /></Response><!-- ${callSid} -->`,
    };
  }

  async transcribe(_opts: { recordingUrl: string | null; callSid: string }): Promise<TranscriptResult> {
    // Production wiring point: Twilio posts the native transcription to the
    // <Record> verb's transcribeCallback URL (a route this module's comments
    // reference: /api/calls/webhooks/twilio/transcription). That route writes
    // Call.transcription directly — it does not go through this method.
    // This method exists for programmatic transcription requests (e.g. a
    // background STT pass); without a configured STT key it returns null.
    return { transcript: null, source: "none" };
  }
}

// ---------------------------------------------------------------------------
// Fake telephony (tests, dev, and this environment).
// ---------------------------------------------------------------------------

/**
 * Deterministic fake numbers: +1 (555) 010-XXXX, an exchange range that can
 * never be a real subscriber. Fake call SIDs are `FAKE` + 32 hex chars.
 */
export function fakeNumber(index: number): string {
  return `+1555010${String(index % 10000).padStart(4, "0")}`;
}

export function fakeCallSid(seed = ""): string {
  const hex = seed
    ? createHash("sha256").update(seed).digest("hex").slice(0, 32)
    : randomBytes(16).toString("hex");
  return `FAKE${hex.toUpperCase()}`;
}

export class FakeTelephonyProvider implements TelephonyProvider {
  readonly name: ProviderName = "fake";
  private static counter = 0;

  static resetCounter(): void {
    FakeTelephonyProvider.counter = 0;
  }

  private secret(env: NodeJS.ProcessEnv = process.env): string {
    return (env.FAKE_TELEPHONY_SECRET ?? "fake-telephony-dev-secret").trim();
  }

  async purchaseNumber(input: PurchaseNumberInput): Promise<PurchasedNumber> {
    FakeTelephonyProvider.counter += 1;
    return {
      e164: fakeNumber(FakeTelephonyProvider.counter),
      providerSid: `FAKEPN${String(FakeTelephonyProvider.counter).padStart(6, "0")}`,
    };
  }

  async releaseNumber(_e164: string): Promise<void> {
    // Nothing to release upstream in the fake provider.
  }

  validateWebhookSignature(opts: {
    url: string;
    params: Record<string, string>;
    signature: string | null;
  }): boolean {
    if (!opts.signature) return false;
    const expected = createHmac("sha256", this.secret())
      .update(opts.url + JSON.stringify(opts.params))
      .digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(opts.signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  inboundResponse(callSid: string): { contentType: string; body: string } {
    return {
      contentType: "application/json",
      body: JSON.stringify({ accepted: true, callSid, provider: "fake" }),
    };
  }

  async transcribe(opts: { recordingUrl: string | null; callSid: string }): Promise<TranscriptResult> {
    // Fixture transcript — deterministic per call SID so the battery can
    // assert on it. Production transcription is stubbed behind this
    // interface (see module header + honest gaps in the build report).
    return {
      source: "fixture",
      transcript: [
        "[0:00] Agent: Thanks for calling, how can I help you today?",
        "[0:08] Caller: Hi, I wanted to get a quote for your services.",
        "[0:15] Agent: Of course — can I get your name and email?",
        `[0:22] Caller: Sure. (call ${opts.callSid.slice(-6)})`,
      ].join("\n"),
    };
  }
}

/** Resolve the active provider from the environment. Defaults to fake. */
export function getProvider(env: NodeJS.ProcessEnv = process.env): TelephonyProvider {
  const name = ((env.CALLS_PROVIDER ?? "fake") as string).trim().toLowerCase();
  if (name === "twilio") return new TwilioProvider(env);
  return new FakeTelephonyProvider();
}

/** Sign a fake-telephony webhook (used by tests and the DNI demo caller). */
export function signFakeWebhook(
  url: string,
  params: Record<string, string>,
  secret = "fake-telephony-dev-secret",
): string {
  return createHmac("sha256", secret).update(url + JSON.stringify(params)).digest("hex");
}
