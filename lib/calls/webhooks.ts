// Marketr — call tracking (R5): webhook plumbing shared by the Twilio
// voice and status routes.
//
// Twilio posts application/x-www-form-urlencoded bodies and signs them with
// X-Twilio-Signature (HMAC-SHA1 of the full URL + sorted params). The fake
// provider signs JSON bodies with X-Fake-Signature (HMAC-SHA256 of
// url + JSON(params)) so the battery can exercise the same validation path
// without network access.

import { getProvider, type TelephonyProvider } from "./provider";

/** Read the provider's POST body into a flat string map (form or JSON). */
export async function readWebhookParams(req: Request): Promise<Record<string, string>> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(body).map(([k, v]) => [k, String(v ?? "")]),
    );
  }
  const form = await req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) out[k] = String(v);
  return out;
}

export interface ValidatedWebhook {
  ok: boolean;
  provider: TelephonyProvider;
  params: Record<string, string>;
  /** Why validation failed. */
  reason?: "missing_signature" | "bad_signature" | "provider_unconfigured";
}

/**
 * Validate the webhook signature for the active provider. Twilio uses
 * X-Twilio-Signature; the fake provider uses X-Fake-Signature.
 */
export async function validateWebhook(req: Request): Promise<ValidatedWebhook> {
  let provider: TelephonyProvider;
  try {
    provider = getProvider();
  } catch {
    return { ok: false, provider: undefined as never, params: {}, reason: "provider_unconfigured" };
  }
  const params = await readWebhookParams(req);
  const signature =
    req.headers.get("x-twilio-signature") ?? req.headers.get("x-fake-signature");
  if (!signature) {
    return { ok: false, provider, params, reason: "missing_signature" };
  }
  const valid = provider.validateWebhookSignature({ url: req.url, params, signature });
  return valid
    ? { ok: true, provider, params }
    : { ok: false, provider, params, reason: "bad_signature" };
}
