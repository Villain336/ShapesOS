# Marketr — Billing Threat Model (Phase C gap-fill, track G2 + overage invoicing)

Stripe is a downstream money pipe, never the source of truth. The
`UsageEvent` ledger decides what was spent; Stripe only moves money for
hosted top-up purchases and monthly overage invoices. Every abuse case
below is enforced in `lib/metering/billing.ts`, the `/api/billing/*` and
`/api/cron/overage-invoicing` routes, or covered by
`scripts/verify-billing.mts` / `scripts/verify-overage.mts`. Self-hosted
Marketr never touches this track: with no `STRIPE_SECRET_KEY` /
`STRIPE_WEBHOOK_SECRET` every method fails closed with a plain-language
"billing not configured" error.

Key invariant: **no credits are ever granted except through
`applyTopUp` (sibling-owned, idempotent) after a verified
`checkout.session.completed` for a paid session whose amount matches a
known pack, and no overage dollar is ever billed except from the ledger's
summed `usage_events.overage_credits`.** There is no other path from
Stripe to the ledger, and no path from Stripe to an invoice amount.

## B1 — Webhook forgery (the critical path)

**Abuse:** An attacker POSTs a fabricated `checkout.session.completed`
payload to `/api/billing/webhook` to mint credits without paying.

**Mitigations:**
- `handleWebhook(rawBody, signature)` verifies the Stripe signature with
  `stripe.webhooks.constructEvent` **before any JSON parsing, before any
  business logic, before any DB write**. A bad signature returns
  `{ ok: false, reason: "invalid_signature" }` and applies nothing.
- The raw body is read via `req.text()` in the route — never
  `req.json()` first. Parsing an unverified body is the classic mistake;
  the route is structured so verification is the first statement.
- The webhook secret comes from `STRIPE_WEBHOOK_SECRET` only. It is never
  logged, never returned, never echoed in error messages.
- The route is public-by-design in the M11 scan (Stripe cannot hold a
  session) with a justification comment; the *signature* is the
  authorization.

**Battery:** tampered payload / wrong secret / missing signature →
rejected, `purchasedCredits` unchanged, no idempotency row.

## B2 — Webhook replay (double-apply)

**Abuse:** Stripe redelivers `checkout.session.completed` (retries after a
non-2xx, or an attacker replays a captured valid webhook) and the
workspace is credited twice for one payment.

**Mitigations:**
- Idempotency key `stripe:checkout-session:<sessionId>` is derived from
  the Stripe session ID (server-minted by Stripe, unique per payment).
- `billing.ts` keeps an exactly-once guard table
  (`billing_topup_idempotency`, PK on the idempotency key) created lazily
  via `CREATE TABLE IF NOT EXISTS` — no migration owned by this track.
  The guard row is inserted **first**; a PK conflict means "already
  applied" and the handler returns the prior result without touching the
  ledger. Insert-first (not check-then-insert) closes the concurrent
  double-delivery race.
- The sibling's `applyTopUp` remains positional (no native idempotency
  key), so this guard table is currently the authoritative dedup — not
  just a redundant layer. If the sibling later adds an idempotent
  object-form `applyTopUp`, the table doubles as purchase history for
  the UI and can stay as a second layer. The battery asserts through the
  public `handleWebhook` path so behavior holds under either
  implementation.

**Battery:** deliver the same signed webhook twice (sequentially and
concurrently) → exactly one ledger application; second delivery returns
`already_applied`.

## B3 — Session-ID confusion across workspaces

**Abuse:** A checkout created (and paid) for workspace A is applied to
workspace B — e.g. an attacker replays A's valid webhook hoping the
credits land elsewhere, or crafts a payload with B's workspace ID.

**Mitigations:**
- `createTopUpCheckout` binds `metadata.workspaceId` server-side from the
  **authenticated admin session's workspace** (`requireWorkspaceAccess`
  in the route). The client never supplies the workspace that gets
  credited — the pack ID is the only client input, and it is validated
  against `TOPUP_PACKS`.
- `handleWebhook` credits **only** `session.metadata.workspaceId`. A
  payload with missing/empty `workspaceId` metadata is rejected.
- A payload with *tampered* metadata fails B1 signature verification —
  the signature covers the whole payload including metadata. There is no
  code path that accepts a workspace ID from outside the signed payload.

**Battery:** signed webhook with metadata.workspaceId stripped →
rejected; payload with metadata rewritten (re-signed by the test — proves
the point that only the signature binds it) is rejected when the
signature doesn't match; checkout creation asserts
`metadata.workspaceId` equals the authorized workspace.

## B4 — Amount tampering (pack price vs credits mismatch)

**Abuse:** The paid amount doesn't match the credited pack — pack table
drift between checkout creation and webhook delivery, or a confused
`metadata.packCredits` — so the workspace gets 22,000 credits for a $50
payment (or vice versa: under-credited after paying $200).

**Mitigations:**
- `handleWebhook` looks up the pack **by the paid `amount_total`** (and
  `currency === "usd"`). No pack matches the paid amount exactly →
  reject, nothing applied, loud error for manual review.
- `metadata.packCredits` must equal the matched pack's credits; mismatch
  → reject. The credited amount always comes from the pack table, never
  from client-supplied or metadata-supplied numbers.
- `payment_status` must be `"paid"` — unpaid/expired sessions are ignored.

**Battery:** signed webhook with `amount_total` matching no pack →
rejected; `amount_total` = $50 but `metadata.packCredits` = 22000 →
rejected; unpaid session → ignored.

## B5 — Opt-in privilege / CSRF (non-admin enabling auto-overage)

**Abuse:** A non-admin workspace member (or a CSRF'd admin browser)
flips auto-overage on, exposing the workspace to uncapped spend.

**Mitigations:**
- `POST /api/billing/overage` requires `requireWorkspaceAccess(...,
  "admin")` — the M11-recognized primitive is in the route file itself,
  so the scan gates it. Non-members get 404 (not your workspace),
  non-admins get 403.
- The toggle is a POST with a JSON body (no state-changing GET), and the
  UI posts via `fetch` — same-origin. (Full CSRF-token hardening is a
  platform-wide follow-up, noted honestly.)
- Every toggle writes an audit row (`FileChangeLog`, actor `user`,
  action `save`, summary prefixed `Billing: auto-overage … by <actor>`).
  The enum has no billing action and this track owns no migration; the
  summary text is explicit and the sibling track may add a dedicated
  action later.
- Default is OFF: `blockAtCap` defaults true; nothing opts a workspace in
  implicitly.

**Battery:** the route's exported logic called with a non-admin user →
403 and `blockAtCap` unchanged; default for a fresh workspace is
`blockAtCap: true`.

## B6 — Test-mode vs live-mode key confusion

**Abuse:** A test-mode webhook secret verifies a live-mode event (or vice
versa), or test payments credit production workspaces.

**Mitigations:**
- Stripe signs test and live events with different secrets; a
  test-signed payload presented to a live-configured endpoint fails B1
  verification. The failure is loud, not silent.
- Documented deployment rule (not code): `STRIPE_SECRET_KEY` and
  `STRIPE_WEBHOOK_SECRET` must come from the **same** Stripe mode, and
  the webhook endpoint URL registered in the Dashboard must be the
  deployment's own `/api/billing/webhook`. There is no mode flag in code
  to get wrong — the secrets themselves define the mode.
- The UI never displays keys, modes, or secrets — only "purchases
  enabled / not enabled".

**Battery:** (static) both secrets are read from env only; no mode flag
exists to confuse; error copy never leaks key material.

## B7 — Unconfigured Stripe (self-host / misconfigured hosted)

**Abuse:** Billing code runs without keys and half-initializes — e.g.
creates a checkout object that can never charge, or applies credits from
an unverifiable webhook.

**Mitigations:**
- `requireConfigured()` is called at the top of **every** public method
  (`createTopUpCheckout`, `handleWebhook`, `setAutoOverage`,
  `purchaseTopUp`, `billOverage`). Missing `STRIPE_SECRET_KEY` or
  `STRIPE_WEBHOOK_SECRET` → throws `BillingNotConfiguredError`
  ("Stripe billing is not configured…") before any Stripe client is
  constructed. Never half-initialized.
- The UI probes `GET /api/billing/status` and hides purchase controls
  when unconfigured, with plain-language copy.

**Battery:** with env keys absent, every method throws the
not-configured error; no Stripe client constructed; no DB writes.

## B8 — Checkout session hijacking (stolen session ID)

**Abuse:** An attacker learns a victim's `cs_…` session ID and tries to
use it to get credits or to interfere with the victim's purchase.

**Mitigations:**
- Knowing a session ID is useless: credits flow only from a **signed
  webhook** (B1), and the webhook credits `metadata.workspaceId` which
  the attacker cannot change without breaking the signature (B3).
- `createTopUpCheckout` returns the Checkout URL to the admin who
  created it; session IDs are never rendered in shared UI or logs.

## B9 — Overage accounting and invoicing (WIRED)

When auto-overage is opted in and the cap is hit, the sibling-owned
`meter()` allows the charge (`cap.autoOverage || !cap.blockAtCap`) and
records it as a **normal UsageEvent** — the same action and credit cost
from `CREDIT_COSTS`. No new action and no invented costs (credits.ts is
sibling-owned). Additionally, `meter()` marks the overage portion factually
on the event (`usage_events.overage_credits` = the part of the charge that
fell beyond included + purchased, capped to the charge; see SEAM.md
"Overage accrual") — but ONLY when auto-overage is on. Legacy
`blockAtCap: false` usage passes the cap yet accrues nothing, so it can
never be invoiced. Overage usage is therefore auditable in the standard
by-action breakdown, and the invoice cron sums exactly this column — the
ledger decides what is owed, Stripe only moves the money.

Overage **invoicing** is now wired (`StripeBillingSink.invoiceOverage`,
cron `POST /api/cron/overage-invoicing`):

- Monthly, per workspace with auto-overage on: sums unbilled
  `overage_credits` before the current UTC month (completed months only —
  a partial in-progress month is never invoiced), creates one Stripe
  invoice item + finalized invoice, replay-safe per workspace per month
  (B12). The invoice period label is the completed billing month
  (derived from cutoff − 1ms), not the cron-run month.
- Invoicing fails closed without a verified card (`no_payment_method`):
  the setup route is the ONLY customer-creation path — invoicing never
  silently creates a Stripe customer. (Enabling auto-overage already
  requires a card; this covers cards removed afterwards.)
- $5.00 minimum: sub-minimum months are skipped WITHOUT advancing the
  invoice watermark, so small amounts carry forward and are billed once
  the minimum is reached (B15).
- `billOverage(workspaceId, credits, periodStart)` is now real: it invoices
  the month containing `periodStart` once that month has ended
  (`nothing_due` while it is in progress). The `credits` argument is NOT
  trusted — amounts always come from the ledger.

## B10 — Stripe customer binding (workspace ↔ customer confusion)

**Abuse:** A Stripe customer belonging to workspace A is used to invoice
workspace B — or an attacker tricks the system into attaching their card
to a victim workspace's invoices (or vice versa).

**Mitigations:**
- `billing_workspaces.stripe_customer_id` is written only from two
  server-side paths: `createPaymentMethodCheckout` (admin-session
  workspace, customer created with `metadata.workspaceId`) and the signed
  setup-completion webhook. It is never taken from client input.
- `handleSetupCompleted` rejects when the session's customer differs from
  the stored binding (`customer_mismatch`); it only fills an empty
  binding, never overwrites one.
- `handleInvoicePaid` / `handleInvoiceFailed` look up the invoice row by
  Stripe invoice id, then require the event's customer to equal the
  workspace's bound customer — a paid/failed event for a foreign customer
  is ignored, not applied.

**Battery:** setup webhook with a customer id different from the stored
binding → rejected, `hasPaymentMethod` unchanged; invoice.paid with a
mismatched customer → ignored, row status unchanged.

## B11 — Payment-method hijacking (card added to the wrong workspace)

**Abuse:** A signed setup-completion webhook for workspace B is replayed
or crafted to arm workspace A — giving A a card on file (and auto-overage
eligibility) it shouldn't have, or attaching the attacker's card to a
victim workspace so the victim's invoices charge the attacker (nuisance)
or the attacker's workspace bills the victim (theft).

**Mitigations:**
- The workspace armed is taken ONLY from the signed session's
  `metadata.workspaceId` (B1 covers forgery; B3 covers the binding
  pattern). The customer must additionally match the workspace's stored
  binding (B10).
- Exactly-once per session: `billing_setup_idempotency` insert-first; a
  replayed setup completion returns the prior result without re-attaching.
- Enabling auto-overage ALWAYS requires `hasPaymentMethod`
  (OverageCardRequiredError → 402 with plain-language copy) — no exception
  for unconfigured/self-hosted state. There is no path to uncapped spend
  without a verified card.

**Battery:** setup webhook replayed → single attach (one
`customers.update` call), second returns `alreadyApplied`; setup webhook
with stripped workspaceId metadata → rejected.

## B12 — Invoice replay / double-finalize

**Abuse:** The monthly cron fires twice (overlapping schedules, manual
re-run, retry after a timeout) and the workspace is invoiced twice for
the same overage — or Stripe redelivers and a second invoice is
finalized.

**Mitigations:**
- `invoiceOverage` inserts the `billing_overage_invoices` row FIRST with
  idempotency key `overageinvoice:<workspaceId>:<YYYY-MM of the completed
  billing month>`; a repeat run finds the terminal row and returns
  `already_invoiced` without touching Stripe.
- A concurrent second run that loses the insert race waits (bounded) for
  the in-flight invoice to settle, then replays it — it never drives the
  Stripe flow twice. A row stuck mid-flight past the stale timeout is
  treated as a crashed worker and reclaimed (safe: Stripe calls below use
  fixed idempotency keys).
- Every Stripe call carries a matching idempotency key
  (`overage-item:…`, `overage-invoice:…`, `overage-finalize:…`), so a
  crash between Stripe and the DB update retries without duplicating
  invoice items or finalizing twice. On Stripe failure the pending row is
  removed and the error rethrown — the next run retries cleanly.
- The watermark (`lastOverageInvoicedThrough`) advances only after a
  successful finalize, so a failed run never loses billable overage.

**Battery:** run the invoice core twice (sequentially and concurrently)
for the same month → exactly one invoice row, one finalize call, one
invoice item; second run returns `already_invoiced`.

## B13 — Webhook ordering (paid before finalized? failed handling)

**Abuse / confusion:** `invoice.paid` arrives before Marketr recorded the
invoice (race, or the invoice was created in the Stripe Dashboard);
`invoice.payment_failed` arrives and nobody notices — the workspace keeps
accruing overage on a dead card.

**Mitigations:**
- Unknown Stripe invoice ids are **ignored** (`unknown_invoice`), not
  failed — the cron's rows are authoritative for what Marketr billed.
  Dashboard-created invoices are out of scope by design.
- `invoice.payment_failed` marks the row `failed`, writes an audit row,
  and the Settings → Usage invoice list surfaces it with plain-language
  recovery copy (add a new card or pay from the Stripe receipt). It does
  NOT auto-disable auto-overage — a single decline (expired card, bank
  rule) shouldn't silently shut off a workspace's pipeline; the failure
  is visible and the next invoice retries the card on file.
- Dunning (Smart Retries configuration, retry schedules, auto-disable
  after N failures) is a documented follow-up, not built here.

**Battery:** `invoice.paid` for an unknown invoice id → ignored, no row
created; `invoice.payment_failed` → row `failed` + audit row present;
`invoice.paid` afterwards → row `paid`.

## B14 — Test-mode vs live-mode mixing (invoicing extension of B6)

**Abuse:** A test-mode customer/invoice id is presented to a live-mode
deployment (or vice versa), or the monthly cron runs against the wrong
mode's data.

**Mitigations:**
- Same as B6: the secrets define the mode; a test-signed webhook fails
  verification on a live endpoint. Additionally, invoice rows store the
  Stripe invoice id returned by the configured client — a row created in
  test mode references `in_test_…`, which a live client can never settle,
  and the customer-binding check (B10) fails closed on any mismatch.
- Documented deployment rule (not code): one mode per deployment; the
  webhook endpoint registered in the Dashboard must belong to that mode.

## B15 — Invoice threshold gaming

**Abuse:** A workspace keeps monthly overage just under $5.00 to dodge
invoices forever — free overage in perpetuity.

**Mitigations:**
- Sub-minimum months do NOT advance the invoice watermark: the overage
  carries forward and is billed once the cumulative unbilled amount
  reaches $5.00. Staying under the threshold forever caps the unbilled
  total below $5.00 — a bounded, accepted loss, and the ledger still
  records every credit.
- The $5.00 minimum exists because invoicing $0.37 costs more in Stripe
  fees and support burden than it recovers; the tradeoff is documented in
  the UI copy ("never forgiven, never rounded away").

**Battery:** accrue $1.20 of overage → `below_minimum`, watermark NULL;
accrue $4.00 more → next run invoices the full $5.20 in one invoice.

## Non-goals (explicitly not handled here)

- Disputes/chargebacks after a completed payment — Stripe Dashboard +
  support process; the idempotency table is the evidence of what was
  applied.
- Proration, plan changes, seat billing — out of scope.
- Dunning: after `invoice.payment_failed` the invoice is marked failed and
  surfaced; Stripe Smart Retries / retry schedules / auto-disable after N
  failures are a follow-up (B13).
- Multi-currency: overage invoices are USD-only, matching top-up packs.
- PCI scope: card data never touches Marketr — Stripe Checkout/Elements
  only. No card fields exist in this codebase.
