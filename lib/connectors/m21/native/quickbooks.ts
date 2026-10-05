// ShapesOS — Phase 11 (bizsync): QuickBooks Online adapter (native, OAuth 2.0).
//
// LIVE WIRING: Intuit OAuth (lib/vault/oauth.ts "quickbooks"; the company
// realmId arrives on the callback and is kept in the credential payload) →
// QuickBooks Accounting API (lib/bizsync/quickbooks/api.ts) through the
// shared accounting engines (tools: lib/connectors/m21/native/accounting.ts):
//   list_accounts | import_contacts | post_to_quickbooks
// Posting is idempotent per source document (ops_accounting_exports +
// ?requestid=) and never touches the local journal. QUICKBOOKS_ENVIRONMENT=
// sandbox points at Intuit's sandbox host.

import { AccountingAdapter } from "./accounting";

export class QuickbooksAdapter extends AccountingAdapter {
  readonly key = "quickbooks" as const;
  readonly displayName = "QuickBooks";
}
