# Marketr — Billing Threat Model (Phase C gap-fill, track G2)

Stripe is a downstream money pipe, never the source of truth. The
`UsageEvent` ledger decides what was spent; Stripe only moves money for
hosted top-up purchases. Every abuse case below is enforced in
`lib/metering/billing.ts`, the `/api/billing/*` routes, or covered by
`scripts/verify-billing.mts`. Self-hosted Marketr never touches this
track: with no `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` every method
fails closed with a plain-language "billing not configured" error.

Key invariant: **no credits are ever granted except through
`applyTopUp` (sibling-owned, idempotent) after a verified
`checkout.session.completed` for a paid session whose amount matches a
known pack.** There is no other path from Stripe to the ledger.

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

## B9 — Overage accounting (sibling G1 implementation)

When auto-overage is opted in and the cap is hit, the sibling-owned
`meter()` allows the charge (`cap.autoOverage || !cap.blockAtCap`) and
records it as a **normal UsageEvent** — the same action and credit cost
from `CREDIT_COSTS`. No new action and no invented costs (credits.ts is
sibling-owned). Overage usage is therefore auditable in the standard
by-action breakdown; a workspace can see exactly which actions consumed
overage. Overage **invoicing** through Stripe (charging the $0.012/credit)
is a hosted follow-up — documented, not built. `billOverage` stays a
fail-closed stub, and the hard cap stays enforced until that path exists.

## Non-goals (explicitly not handled here)

- Disputes/chargebacks after a completed payment — Stripe Dashboard +
  support process; the idempotency table is the evidence of what was
  applied.
- Proration, plan changes, seat billing — out of scope.
- PCI scope: card data never touches Marketr — Stripe Checkout/Elements
  only. No card fields exist in this codebase.
