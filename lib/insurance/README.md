# Insurance module

Wave 2 quick-wins module. Spec: `~/workspace/biz-os/specs/SPEC-INSURANCE.md`.
Vault-private: never publish or share.

## Producer-of-record decision (Tico, 2026-10-01): LICENSED PARTNER

The partner holds the insurance licenses; Marketr provides the software.

- A workspace binds **only** when an **active, appointed** licensed partner is
  on file (`InsuranceLicensedPartner` with a producer license number and at
  least one licensed state). Registration is fail-closed on license identity:
  a partner record without a license number or licensed states can never
  satisfy the gate.
- The bind/execute path calls `requireAppointedPartner(workspaceId)` first and
  throws `PARTNER_NOT_APPOINTED` when the gate is unsatisfied — never a silent
  skip. The vendor adapter additionally requires the partner id on every
  `bind()` call and throws the same code when it is missing.
- Suspended and revoked partners do not satisfy the gate.
- Quote / propose / approval flows are unaffected: quotes are non-binding and
  approvals are human decisions; only execution needs the partner.

## Rails

- **Primary: CoverForce** — API-first, Startup Program + Amwins DAIS market
  access. Fixture-backed until the Startup Program paperwork is signed; live
  mode fails closed with `VENDOR_NOT_CONFIGURED`.
- **Second rail (staged, not v1): Bold Penguin DeX ai** — native MCP + A2A.
  The `InsuranceVendor` interface is designed so DeX ai can replace or sit
  alongside the CoverForce shim without rewriting agent logic.

## Money red-lane rules (SPEC-INSURANCE.md §4.4)

1. Premiums are consequential payments: propose → explicit approval → licensed
   rail executes. No auto-bind in v1.
2. Zero custody: the OS never holds, floats, or routes premium funds. All
   payments are carrier-direct through the vendor rail.
3. No invented coverage: quotes, limits, and certificates render only from
   vendor/carrier data. Missing fields read "not confirmed," never a guess.
4. Every governed action writes an audit record (slice 3).
5. Declines and referrals are first-class outcomes with documented reasons.

## Layout

| File | Slice | Contents |
|---|---|---|
| `types.ts` | 1 | Policy/carrier/renewal domain, status machines, renewal alerts, declarations parsing |
| `mock-vendor.ts` | 1 | `InsuranceVendor` interface + fixture-backed mock |
| `quoting.ts` | 2 | Submission intake validation, quote machine, normalization |
| `coverforce.ts` | 2 | CoverForce adapter (fixture mode; live fails closed) |
| `mcp-shim.ts` | 2 | Thin MCP tools: `insurance_check_appetite`, `insurance_submit_risk`, `insurance_get_quotes` |
| `partner.ts` | 2 | Licensed-partner domain, registration validation, bind gate |
| `governance.ts` | 3a | Governed actions (request_quote / bind_policy / issue_certificate), approval + audit framework |
| `binding.ts` | 3b | `executeBind` — the ONLY bind execution entrypoint; disclosure re-verification, zero-custody payment handoff, quote → policy lineage |
| `__tests__/` | 1–3b | ontology, quoting, partner, governance, binding |

API: `app/api/insurance/policies`, `app/api/insurance/submissions`,
`app/api/insurance/governance/*`, `app/api/insurance/quotes/[id]/bind` (slice 3b).

## Bind execution (slice 3b)

`executeBind({ workspaceId, quoteId, approvalId, requestedBy? })` runs the
steps in order, each fail-closed:

1. Quote exists, status is `quoted`, not expired (a `bound` quote replays the
   existing policy — never double-binds).
2. The approval is an **approved** `insurance_bind_policy` approval for this
   quote, and its disclosure (carrier, premium, limits, effective date) still
   matches the quote — drift fails with `BIND_DISCLOSURE_MISMATCH`.
3. `requireAppointedPartner(workspaceId)` — `PARTNER_NOT_APPOINTED` otherwise.
4. `vendor.bind({ quoteId, partnerId, idempotencyKey })` — the key derives
   from `(quoteId, approvalId)`.
5. `InsurancePolicy` created from **vendor data only**; limits not returned by
   the v1 bind response read "not confirmed" (null). `priorPolicyId` is set
   when the quote's `rawPayload.renewalOfPolicyId` names an existing policy.
6. `InsurancePaymentHandoff` written: `custodyAssertion: "carrier_direct"`,
   payee = the carrier, and a code-level assertion (`assertZeroCustodyHandoff`)
   that no OS account fields exist on the record.
7. The `InsuranceAuditEvent` for the approval is stamped with the vendor
   transaction ref (the carrier confirmation).
