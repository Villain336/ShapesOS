# Marketr — Call Tracking & Appointment Booking (R5)

## Provider boundary: fake vs live

Call tracking runs on a `TelephonyProvider` (`lib/calls/provider.ts`).
`CALLS_PROVIDER` selects it; it defaults to `fake`.

| | Fake (default) | Twilio (live) |
|---|---|---|
| Numbers | Deterministic `+1 (555) 010-XXXX` | Real purchased numbers via `IncomingPhoneNumbers` |
| Inbound calls | Signed JSON webhooks (`signFakeWebhook`) | Twilio POSTs to `/api/calls/webhooks/twilio/voice` |
| Status callbacks | Same | Twilio POSTs to `/api/calls/webhooks/twilio/status` |
| Transcription | Fixture transcript | `<Record transcribe="true">` posts to `/api/calls/webhooks/twilio/transcription` |
| Webhook auth | `X-Fake-Signature` HMAC-SHA256 (`FAKE_TELEPHONY_SECRET`) | `X-Twilio-Signature` HMAC-SHA1 (`TWILIO_AUTH_TOKEN`) |

**Going live** requires only environment changes — no code changes:

```
CALLS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# optional, preferred for REST calls:
TWILIO_API_KEY=SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Point each number's Voice URL at
`https://<your-host>/api/calls/webhooks/twilio/voice` and its StatusCallback
at `.../api/calls/webhooks/twilio/status` (the purchase API sets these when
`voiceUrl`/`statusCallbackUrl` are passed). Keep Twilio's
`StatusCallbackEvent=completed` default.

**Deployment caveat:** Twilio signs the *public* URL. If a proxy rewrites the
host or scheme before the request reaches Next.js, signature validation will
403 legitimate webhooks — make sure the public URL reaches the route intact.

## Dynamic number insertion (DNI)

1. Buy tracking numbers in **Calls → Numbers**, giving each a campaign label
   (e.g. `summer-sale`).
2. Add the snippet (copy it from the dashboard) to your site's `<head>`:
   ```html
   <script src="https://<your-host>/api/calls/dni/snippet?workspace=WORKSPACE_ID"></script>
   ```
3. Mark the numbers you want swapped with `[data-mk-number]`, or let the
   snippet rewrite every `tel:` link automatically.

Resolution: `?utm_source=` (fallback `?source=`) is matched
case-insensitively against campaign labels; no match (or no query param)
falls back to the workspace's first active number; no active numbers → the
site's hard-coded number stays. The endpoint is public by design and
rate-limited (60/min per workspace+IP); it exposes only the numbers you
publish.

## Booking pages

Create pages in **Calls → Booking pages**. The token is shown once — the
public page lives at `/book/<token>`. Settings: duration, buffer between
appointments, IANA timezone, and per-day working hours.

Bookings create or match a lead (email first, then phone; source `booking`),
log one attribution touch (channel follows Marketr's UTM-aware normalization —
UTMs credit the originating channel, no UTMs → `booking`), a `meeting` activity, and queue
confirmation + 24h + 1h reminders. **Consent is mandatory**: the booking form
requires the checkbox; without it the submission is rejected (400).

## Reminder runner

Reminders are *queued*, not sent, at booking time. A scheduler must call:

```
POST /api/calls/reminders/run
Authorization: Bearer $REMINDERS_CRON_SECRET
```

Run it every 5–15 minutes. Response: `{ sent, deferredQuietHours,
skippedOptOut, elapsedMs }`.

- Auth: the cron secret; without it (local dev), any editor+ session works.
- Delivery: Resend when `RESEND_API_KEY` + `BOOKING_MAIL_FROM` are set;
  otherwise the stub log port (safe — nothing sends).
- Quiet hours 21:00–07:59 (page timezone) are enforced at send time;
  due reminders are deferred to 08:00. Opt-outs and cancellations are
  re-checked at send time.

## Environment variables

| Var | Purpose |
|---|---|
| `CALLS_PROVIDER` | `fake` (default) or `twilio` |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Live telephony credentials |
| `TWILIO_API_KEY` / `TWILIO_API_SECRET` | Optional REST-call credentials |
| `FAKE_TELEPHONY_SECRET` | Signs fake webhooks (dev/tests) |
| `REMINDERS_CRON_SECRET` | Bearer auth for the reminder runner |
| `RESEND_API_KEY` / `BOOKING_MAIL_FROM` | Real reminder delivery |

## Honest gaps

- Live calls require real Twilio credentials; nothing here has been
  exercised against Twilio's API.
- Transcription is a fixture behind the provider interface.
- Booking overlap is race-safe for same-slot submissions (partial unique
  index → 409); different-start overlaps rely on the app check.
- Phone lead matching uses last-10-digit matching over the 200 most recent
  leads.
