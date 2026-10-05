// ShapesOS — Phase 11 (bizsync): Xero adapter (native, OAuth 2.0 + tenant).
//
// LIVE WIRING: Xero OAuth (lib/vault/oauth.ts "xero"); after the callback the
// granted organisations are discovered and one is selected
// (lib/bizsync/xero/tenants.ts — a person can switch it in Settings →
// Connectors → Business sync); its tenantId rides in the credential payload
// as the xero-tenant-id header. Xero Accounting API
// (lib/bizsync/xero/api.ts) through the shared accounting engines (tools:
// lib/connectors/m21/native/accounting.ts):
//   list_accounts | import_contacts | post_to_xero
// Posting is idempotent per source document (ops_accounting_exports +
// Idempotency-Key) and never touches the local journal.

import { AccountingAdapter } from "./accounting";

export class XeroAdapter extends AccountingAdapter {
  readonly key = "xero" as const;
  readonly displayName = "Xero";
}
