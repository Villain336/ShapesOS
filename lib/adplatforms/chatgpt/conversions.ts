// Marketr — Wave 2 ChatGPT Ads slice 4: Conversions API event builders.
//
// Server-side conversion events (purchase, signup, booking) close the
// attribution loop for ChatGPT campaigns. The payload shape is MODELED on
// standard Conversions API conventions (event_name / event_time / user_data /
// custom_data) — OpenAI's endpoint shape could not be verified against a
// public spec, so the sender fails closed unless the tenant configures the
// endpoint explicitly.
//
// Privacy gate: sending is refused unless the tenant has accepted OpenAI's
// ads data terms for PII-bearing events. Acceptance is an explicit per-call
// `termsAccepted: true` — the UI presents the checkbox, and without it the
// event is built (previewable) but never sent.

import { ChatGPTAdsError } from "./types";

export type ConversionEventName = "purchase" | "signup" | "booking" | string;

export interface ConversionUserData {
  /** Pre-hashed (SHA-256, lowercase, trimmed) values only — never raw PII. */
  em?: string[];
  ph?: string[];
  fn?: string[];
  ln?: string[];
  externalId?: string;
  clientIpAddress?: string;
  clientUserAgent?: string;
}

export interface BuildConversionEventInput {
  eventName: ConversionEventName;
  /** Unique per event — dedupes retries server-side. */
  eventId: string;
  eventTime?: Date;
  actionSource?: "website" | "app" | "chat" | "phone_call" | "other";
  userData?: ConversionUserData;
  valueCents?: number;
  currency?: string;
  contentIds?: string[];
  contentCategory?: string;
  orderId?: string;
}

export interface ConversionEvent {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: string;
  user_data: Record<string, unknown>;
  custom_data: Record<string, unknown>;
}

/**
 * Pure builder: OS conversion → Conversions API event payload. Throws when
 * raw (unhashed) PII is detected in user_data — hash client-side first.
 */
export function buildConversionEvent(input: BuildConversionEventInput): ConversionEvent {
  if (!input.eventName?.trim()) {
    throw new ChatGPTAdsError("EVENT_NAME_REQUIRED", "Conversion event needs an event name.");
  }
  if (!input.eventId?.trim()) {
    throw new ChatGPTAdsError("EVENT_ID_REQUIRED", "Conversion event needs a unique event id.");
  }
  const userData = input.userData ?? {};
  for (const [key, values] of Object.entries(userData)) {
    if (key === "externalId" || key === "clientIpAddress" || key === "clientUserAgent") continue;
    for (const v of values as string[]) {
      if (typeof v === "string" && !/^[0-9a-f]{64}$/i.test(v)) {
        throw new ChatGPTAdsError(
          "PII_MUST_BE_HASHED",
          `user_data.${key} must be SHA-256 hashed — raw PII is never sent.`,
        );
      }
    }
  }
  return {
    event_name: input.eventName,
    event_time: Math.floor((input.eventTime ?? new Date()).getTime() / 1000),
    event_id: input.eventId,
    action_source: input.actionSource ?? "website",
    user_data: {
      ...(userData.em ? { em: userData.em } : {}),
      ...(userData.ph ? { ph: userData.ph } : {}),
      ...(userData.fn ? { fn: userData.fn } : {}),
      ...(userData.ln ? { ln: userData.ln } : {}),
      ...(userData.externalId ? { external_id: userData.externalId } : {}),
      ...(userData.clientIpAddress ? { client_ip_address: userData.clientIpAddress } : {}),
      ...(userData.clientUserAgent ? { client_user_agent: userData.clientUserAgent } : {}),
    },
    custom_data: {
      ...(input.valueCents != null ? { value: input.valueCents / 100, currency: input.currency ?? "USD" } : {}),
      ...(input.contentIds ? { content_ids: input.contentIds } : {}),
      ...(input.contentCategory ? { content_category: input.contentCategory } : {}),
      ...(input.orderId ? { order_id: input.orderId } : {}),
    },
  };
}

export interface SendConversionEventDeps {
  /** Tenant-configured Conversions API endpoint. No default — never guess the URL. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

export interface SendConversionEventResult {
  ok: boolean;
  eventId: string;
}

/**
 * Send a built event. Fail-closed: refuses without explicit tenant terms
 * acceptance, refuses without a configured endpoint, and surfaces platform
 * rejections as errors rather than swallowing them.
 */
export async function sendConversionEvent(
  input: { event: ConversionEvent; termsAccepted: boolean },
  deps: SendConversionEventDeps = {},
): Promise<SendConversionEventResult> {
  if (input.termsAccepted !== true) {
    throw new ChatGPTAdsError(
      "TERMS_NOT_ACCEPTED",
      "Conversions API send refused: the tenant must accept OpenAI's ads data terms before PII-bearing events are sent.",
    );
  }
  if (!deps.endpoint?.trim()) {
    throw new ChatGPTAdsError(
      "CONVERSIONS_API_NOT_CONFIGURED",
      "Conversions API send refused: no endpoint configured for this workspace.",
    );
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(deps.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: [input.event] }),
    });
  } catch (err) {
    throw new ChatGPTAdsError(
      "CONVERSIONS_API_NETWORK_ERROR",
      `Conversions API send failed: ${err instanceof Error ? err.message : "network error"}`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ChatGPTAdsError(
      "CONVERSIONS_API_REJECTED",
      `Conversions API rejected the event (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
  return { ok: true, eventId: input.event.event_id };
}
