# Phase 17 — Business Operations: "Run the business"

**Status:** SPEC DRAFT — queued after Phase 16 (…→ 15 → 16 → 17).
**Decided by Tico:** 2026-09-28 — "for Medusa and erpnext i want the features as well for more business capabilities and operation."
**Goal:** Marketr stops being marketing-only and runs the business behind the marketing: sell (commerce), bill (invoicing), track (inventory), deliver (projects) — all agent-addressable, all behind the Phase 14 approval gate.

---

## 1. Medusa side — commerce features (MIT — adoption is on the table)

- **What it is:** MIT-licensed composable commerce platform (~36k★). Isolated modules (product, cart, order, payment, promotion, customer) + a **Workflows engine with compensation functions** — automatic saga-style rollback when a multi-step operation fails.
- **The load-bearing idea:** the Workflows engine is the structural answer for Marketr's Missions/Playbooks reliability — long-running agent operations get transactional semantics (book → pay → confirm, with rollback on failure) instead of hope-based sequencing.
- **v1 commerce scope:** product catalog, carts/orders, payments (Stripe via Medusa's payment modules — zero custody changes; Marketr never holds funds), promotions/discounts, customers. Aimed at agencies selling retainers/packages and SMBs selling products.
- **Adopt vs reimplement:** decision (a) below. Either way, the module boundaries (not a monolith) are the pattern.

## 2. ERPNext side — operations features (GPL-3.0 — PATTERNS ONLY)

- **License law:** ERPNext is GPL-3.0 copyleft. We borrow **patterns only, clean-room** — never its code, never its schema verbatim, never its UI copy. All Marketr implementations are original.
- **The load-bearing idea — the DocType pattern:** in ERPNext, every business entity is schema + auto-generated REST API + permissions by construction. Applied to Marketr: every Operations entity is agent-addressable *by construction* — the agent doesn't learn five APIs, it learns one convention.
- **v1 operations scope (recommended: invoicing + inventory + projects):**
  - **Invoicing:** invoices, line items, tax, payment status, overdue reminders (agent-drafted, gate-approved before sending — money is a red lane).
  - **Inventory:** products/stock levels, low-stock alerts, purchase orders.
  - **Projects:** deliverables, milestones, time tracking — the agency's client work, linked to CRM leads.
  - Deferred to v2: full HR (leave, payroll), manufacturing, full accounting ledger.
- **Lightweight CRM adjacency:** Operations entities link to the canonical `Lead`/CRM models (Wave B) — an invoice belongs to a lead-turned-customer; a project belongs to a deal.

## 3. Data model sketch (new Prisma models)

- `OpsProduct` — catalog: name, sku, price, stockQty, trackInventory.
- `OpsOrder` — customer ref, line items, status (draft | confirmed | fulfilled | cancelled), totals.
- `OpsPayment` — order ref, provider (stripe), amount, status. Records only — funds never touch Marketr.
- `OpsPromotion` — codes, rules, usage limits.
- `OpsInvoice` — customer ref, line items, tax, status (draft | sent | paid | overdue), sentAt. **Sending an invoice is a gated write** (medium, approval required — red lane).
- `OpsInventoryTxn` — product ref, delta, reason (sale | restock | adjustment), actor.
- `OpsProject` — customer ref, milestones (JSON), status, linked lead/deal.
- `OpsWorkflowRun` — workflow name, steps, compensation log (the Medusa-inspired transactional record).
- All tenant-scoped; RLS battery extended. Every entity gets the DocType-style auto API convention: `GET/POST/PATCH /api/ops/{entity}` with workspace scoping + audit.

## 4. Where it lives in the product

- **New "Operations" area** in the dashboard nav (not a CRM tab — this is a second pillar: Marketing + Operations). Sub-tabs: Commerce, Invoicing, Inventory, Projects — Studio house pattern, brand vars, dense tables, Lucide.
- Agents act on Operations through the **Phase 14 approval gate**: reads + draft-creators (draft invoice, draft purchase order) run freely logged; sends/charges/refunds/deletes go through approve/deny. Money-moving actions are medium-gated minimum, bulk refunds high-gated.

## 5. Build order

1. DocType-style entity convention: schema → auto REST API + permissions + audit (the framework everything else plugs into).
2. Invoicing (draft → approve → send → paid/overdue) with the gate on send.
3. Inventory + purchase orders + low-stock alerts.
4. Projects + milestones + time tracking, linked to CRM.
5. Commerce modules: catalog → cart/order → payments (Stripe) → promotions. (Decision (a) picks adopt vs reimplement before this step.)
6. `OpsWorkflowRun` + compensation functions for multi-step operations (order→payment→fulfillment rollback).
7. Agent wiring: Operations tools into the agent surface (Phase 16 generative UI shows invoices/orders as live components).
8. Evals: invoice-send gate tests, refund rollback tests, RLS on new tables, DocType-convention conformance tests.

## 6. Verification (definition of done)

- tsc clean (heap flag), production build green, tests green (new suites: invoicing flow incl. gate-on-send, inventory txn integrity, project milestones, order→payment→fulfillment happy path + rollback, RLS, gate-bypass negatives on money actions).
- Acceptance: agent drafts an invoice → approval card shows the plain-language summary → approve → sent; a failed order workflow compensates (no half-charged customer); inventory decrements exactly once per sale.
- Secret scan clean. Screenshots: Operations area, invoice flow, order with rollback proof. Local-only commit.

## 7. Cost & license reality check (verified 2026-09-28)

- **Medusa:** MIT — adoption via npm is clean; no license cost. The cost is integration surface (payment providers, webhooks) and evals.
- **ERPNext:** GPL-3.0 — **patterns only, clean-room.** No ERPNext code, schema, or UI text in the repo — ever. A license audit of the Operations code is part of verification.
- **Money red lane:** unchanged — Marketr records payments, never holds funds; sending invoices and issuing refunds are gated writes with audit trails. Every purchase/commercial commitment remains Tico's explicit approval.

---

## DECISIONS — LOCKED by Tico 2026-09-28

- **(a) Adopt Medusa v2 packages — but keep our UI.** Real maintained commerce modules under the Marketr shell; our UI, our gate, our agent wiring.
- **(b) Everything v1.** Invoicing + inventory + projects + HR essentials.
- **(c) Extend the existing CRM.** Operations lives under the CRM.

---

## OPEN DECISIONS (resolved 2026-09-28)

**(a) Medusa: adopt or reimplement?**
*Option 1 — Adopt Medusa v2 packages via npm (recommended):* real, maintained commerce modules; we build the Marketr shell + gate + agent wiring around them.
*Option 2 — Reimplement the patterns:* full control, zero dependency, but we own every commerce edge case forever.

**(b) Which ERPNext modules in v1?**
*Option 1 — Invoicing + inventory + projects (recommended):* the agency/SMB core; HR and full ledger wait.
*Option 2 — Invoicing only:* smallest surface, prove the DocType convention, expand later.
*Option 3 — Everything v1:* invoicing + inventory + projects + HR essentials. Biggest bang, biggest build.

**(c) Operations placement.**
*Option 1 — New top-level "Operations" area (recommended):* Marketing + Operations as two pillars; cleaner mental model.
*Option 2 — Extend the CRM:* operations lives under the existing CRM. Less nav, muddier boundaries.
