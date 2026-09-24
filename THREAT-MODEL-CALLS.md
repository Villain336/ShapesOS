# Marketr — Call Tracking & Booking Threat Model (Phase 2, R5)

**Status:** Written against the shipped implementation; every abuse case has an
adversarial test in `scripts/verify-calltracking.mts`.
**Scope:** `lib/calls/*`, `/api/calls/*`, `/book/[token]`, `/dashboard/calls`,
`CallNumber` / `Call` / `BookingPage` / `Booking` / `Reminder` models, the
DNI snippet (`/api/calls/dni`), the reminder runner
(`/api/calls/reminders/run`).
**Assumptions:** Live telephony requires real Twilio credentials
(`TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`); this environment runs the fake
provider. Transcription is a fixture behind the `TelephonyProvider`
interface. Recording URLs and transcripts are stored on the Call row.

## Trust boundaries

1. **Telephony webhooks** (`/api/calls/webhooks/twilio/*`) — public by design;
   authenticated by the provider's signature, never by a session.
2. **Public booking page** (`/api/calls/public/booking/[token]`, `/book/[token]`)
   — public by design; the unguessable token IS the capability. No caller PII
   is ever returned (availability slots contain no names).
3. **DNI endpoint/snippet** (`/api/calls/dni`) — public by design; it exposes
   only phone numbers the business already publishes on its site.
4. **Session API** (`/api/calls/numbers`, `/calls/calls`, `/calls/booking-pages`,
   `/calls/bookings`, `/calls/reminders/run`) — session + workspace-scoped;
   purchases and page management require the **editor** role.

## Abuse cases → mitigations

### C1. Webhook forgery
*Abuse:* An attacker forges a Twilio voice/status/transcription webhook to
inject fake calls, attribution touches, or transcripts.
*Mitigations:*
- Every webhook route runs `validateWebhook()`: Twilio's documented
  HMAC-SHA1(full URL + sorted params) vs `X-Twilio-Signature`, compared with
  `timingSafeEqual`; the fake provider uses HMAC-SHA256 vs
  `X-Fake-Signature`. Missing or bad signature → 403, no rows written.
- Live mode requires the Twilio auth token — with `CALLS_PROVIDER=twilio` and
  no `TWILIO_AUTH_TOKEN`, the provider constructor throws and webhooks fail
  closed as "provider_unconfigured".
- Deployment caveat (documented, not a code fix): Twilio signs the *public*
  URL; if the app sits behind a proxy that rewrites host/proto, `req.url` in
  the route won't match and legitimate webhooks 403. Operators must ensure
  the public URL reaches the route unchanged (forwarded-host handling).
- Battery: bad signature → 403; missing signature → 403.

### C2. Replay / duplicate delivery
*Abuse:* Twilio retries a status callback; the retried delivery double-logs
the attribution touch or re-creates the lead.
*Mitigations:*
- `handleInboundVoice` is idempotent on the provider call SID (unique
  `Call.externalSid`): a retried voice webhook returns the existing Call.
- `handleCallStatus` short-circuits when the call is already in a final
  status — `duplicate: true`, no re-match, no second touch.
- The call touch goes through `logTouch`, whose UNIQUE `(leadId, dedupHash)`
  with hour-bucketed timestamps collapses identical retries; P2002 returns
  the existing touch.
- Battery: duplicate status callback → `duplicate: true`, exactly one touch,
  exactly one lead.

### C3. Cross-workspace IDOR
*Abuse:* A user in workspace A reads/mutates workspace B's numbers, calls,
booking pages, or bookings by guessing IDs.
*Mitigations:*
- Every session route re-derives `workspaceId` from the session
  (`getOrCreateWorkspace`) and scopes every query by it. Reads use
  `findFirst({ where: { id, workspaceId } })`; mutations use
  `updateMany`/`deleteMany({ where: { id, workspaceId } })` — a foreign ID
  behaves as not-found, never as someone else's data.
- Webhook paths resolve the workspace from the called number (`To`), never
  from the request body.
- DNI resolution filters by `workspaceId` (unknown workspace → 404).
- Battery: cross-workspace number read/update/release, call list, page
  read/patch/delete, booking read/patch all return 404/empty for the
  attacker's workspace.

### C4. Number ownership and release
*Abuse:* An attacker triggers a call against a released number; a workspace
keeps attribution credit from numbers it no longer owns.
*Mitigations:*
- `handleInboundVoice` rejects `number_released` (→ 404) and
  `number_not_found` (→ 404) before writing any rows.
- Release (`DELETE /api/calls/numbers/[id]`) marks the row `released`
  (editor role, workspace-scoped) and calls `provider.releaseNumber()`;
  the number keeps its historical call rows (attribution history is
  preserved) but accepts no new calls.
- `purchaseNumber` is editor-only; numbers are globally unique on `e164`.
- Battery: released number blocks inbound voice; unknown number → 404.

### C5. Caller PII and recording/transcript data
*Abuse:* Caller phone numbers, recordings, and transcripts leak to other
workspaces or to unauthenticated visitors.
*Mitigations:*
- Caller PII (`Call.from`, recordings, transcripts) is only reachable through
  the workspace-scoped call log (`/api/calls/calls`, `/dashboard/calls`);
  never on any public surface. The public booking API returns availability
  slots only — no names, emails, or phones.
- The dashboard shows the caller number because the workspace owns it; the
  threat model for the CRM notes the same posture.
- Deployment note: `Call.recordingUrl` points at the provider's storage
  (Twilio's expiring URLs); transcript fixtures never leave the server.
- Battery: public booking endpoints return no PII; foreign workspace sees no
  calls.

### C6. Public booking token abuse
*Abuse:* An attacker guesses/brute-forces booking-page tokens, or reuses a
leaked token.
*Mitigations:*
- Tokens are `mkbook_` + 32 random hex chars (128 bits); only the sha256 is
  stored. Lookup is `findUnique({ tokenHash })` — no timing oracle on the
  raw token.
- The raw token is returned exactly once, at page creation; the dashboard
  never displays it again.
- A disabled page (`enabled: false`) returns 404 on all public endpoints.
- Battery: garbage token → 404; disabled page → 404.

### C7. Booking spam and rate limits
*Abuse:* A bot floods a public booking page with fake appointments; a huge
body crashes the parser.
*Mitigations:*
- Per page+IP in-memory rate limiter: 10 submissions / minute (429 with
  `Retry-After`). Public GETs are not write-limited; the DNI endpoint has
  its own 60/min per workspace+IP limit.
- Raw body is capped at 4 KB (413) before JSON parsing; Zod validates and
  bounds every field (name ≤160, notes ≤2000, email/phone lengths).
- `startAt` must be a future ISO timestamp; the server re-checks availability
  at submit time — submitting a non-offered slot is impossible through the
  public API (past dates → 400, taken slots → 409).
- Battery: 11th submission in a minute → 429; oversized body → 413;
  double-booking the same slot → 409 (including the DB-level backstop, T8).

### C8. Reminder consent, opt-out, and quiet hours
*Abuse:* Reminders are sent to people who never consented; sends land at
3 AM; opt-outs are ignored.
*Mitigations:*
- Consent is required at booking: `consent: false` (or missing) → 400 and no
  booking row, hence no reminders. `consentGiven` is stored on the Booking.
- `recordOptOut` (used by the booking PATCH/cancel path and any STOP
  handling) sets `remindersOptedOut` and flips every scheduled reminder to
  `skipped_opt_out` — cancellation suppresses pending reminders by design.
- `sendDueReminders` re-checks opt-out/cancelled/no-consent at send time and
  skips those rows (`skipped_opt_out`), so a consent flip between queue and
  send is honored.
- Quiet hours (21:00–07:59 in the page's timezone): a reminder due inside the
  window is *deferred* to 08:00 local (dueAt pushed, row stays scheduled) —
  never sent in the dark.
- Delivery without credentials is the LogMailPort stub (logs server-side);
  Resend delivery requires explicit `RESEND_API_KEY` + `BOOKING_MAIL_FROM`
  env vars — emails never send by accident.
- Battery: consent:false → 400; opt-out → reminders skipped; quiet-hour due
  → deferred to 08:00; runner without consent on file sends nothing.

### C9. Provider-secret handling
*Abuse:* Twilio credentials or the fake-webhook secret leak through logs,
errors, or the repo.
*Mitigations:*
- Secrets live in environment variables only (`TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, optional `TWILIO_API_KEY`/`SECRET`,
  `FAKE_TELEPHONY_SECRET`, `REMINDERS_CRON_SECRET`, `RESEND_API_KEY`).
  They are never logged (error messages name the missing var, never the
  value) and never stored in the DB.
- Webhook signature comparison uses `timingSafeEqual` on equal-length
  buffers; a length mismatch fails closed before comparison.
- The secret scan (`scripts/verify-m11-security` scope) covers changed files.
- Battery: constructor throws `ProviderNotConfiguredError` naming the
  missing var; no secret appears in any response body.

### C10. Reminder-runner authorization
*Abuse:* Anyone on the internet triggers mass reminder sends.
*Mitigations:*
- `POST /api/calls/reminders/run` requires `Authorization: Bearer
  REMINDERS_CRON_SECRET`. When the secret is unset (local dev only), an
  editor+ session may run it manually. Either path is authenticated; there
  is no anonymous send trigger.

## Known limitations (honest gaps)

- **Live calls need real Twilio credentials** — webhook flows are exercised
  end-to-end only against the fake provider here.
- **Transcription is a fixture** behind the `TelephonyProvider` interface;
  the `/api/calls/webhooks/twilio/transcription` route is live wiring for
  Twilio's `transcribeCallback` but is unverified against real Twilio.
- **TwiML URL integrity (C1 caveat):** signature validation trusts `req.url`;
  proxy rewrites break Twilio validation (documented above).
- **Booking overlap backstop is exact-start only:** the partial unique index
  on `(pageId, startAt)` WHERE scheduled blocks the realistic race (two
  submissions for the same generated slot); overlapping bookings with
  *different* start times rely on the application-level clash check.
- **Hour-bucketed touch dedup:** two genuinely different calls or bookings
  from the same lead within the same hour on the same channel/source/campaign
  collapse to one attribution touch (standing C2 behavior). The Call/Booking
  rows remain the per-event record.
- **Phone lead matching is last-10-digits over the most recent 200 leads** —
  tolerant of formatting, but a wrong-number match is possible on recycled
  numbers; the dashboard links every call to its matched lead for review.
