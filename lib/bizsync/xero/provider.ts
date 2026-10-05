// ShapesOS — Phase 11 (bizsync): Xero as an AccountingProvider for the shared
// engines (lib/bizsync/accounting/{export,contacts}.ts). Every create carries
// the engine's idempotency key as the Idempotency-Key header.

import { ConnectorApiError, type LiveDeps } from "@/lib/connectors/m21/live/http";
import type { AccountingProvider, RemoteRef } from "../accounting/types";
import { xeroGet, xeroPut, type XeroAuth } from "./api";
import { accountFromXero, billToXero, journalToXero, partyFromXero, paymentToXero, salesToXero, xeroQuote, type XeroAccount, type XeroContact } from "./map";

const PAGE = 100;

/** Payload builders throw plain Errors for local data Xero can't take (e.g. an account without a code): a definitive refusal. */
function build<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new ConnectorApiError("Xero", "bad_request", err instanceof Error ? err.message : "invalid document");
  }
}

function first(res: Record<string, unknown> | null, key: string, idKey: string, numberKey: string | null, what: string): RemoteRef {
  const row = (Array.isArray(res?.[key]) ? (res![key] as Array<Record<string, unknown>>) : [])[0];
  const id = row?.[idKey];
  if (typeof id !== "string" || !id) throw new ConnectorApiError("Xero", "provider_error", `Xero returned no id for the ${what}.`);
  const n = numberKey ? row?.[numberKey] : null;
  return { id, number: typeof n === "string" && n ? n : null };
}

export function xeroProvider(auth: XeroAuth, deps: LiveDeps = {}): AccountingProvider {
  return {
    key: "xero",
    label: "Xero",
    async listAccounts() {
      const r = await xeroGet<{ Accounts?: XeroAccount[] }>(auth, "Accounts", {}, deps);
      return (r?.Accounts ?? []).flatMap((a) => {
        const x = accountFromXero(a);
        return x ? [x] : [];
      });
    },
    async findOrCreateParty(kind, p, key) {
      // An existing contact with the same email wins, then the same name (Xero names are unique).
      for (const where of [p.email ? `EmailAddress==${xeroQuote(p.email)}` : null, `Name==${xeroQuote(p.name)}`]) {
        if (!where) continue;
        const found = await xeroGet<{ Contacts?: XeroContact[] }>(auth, "Contacts", { where }, deps);
        const hit = found?.Contacts?.find((c) => c.ContactID && c.ContactStatus !== "ARCHIVED");
        if (hit?.ContactID) return hit.ContactID;
      }
      const res = await xeroPut<Record<string, unknown>>(auth, "Contacts", { Contacts: [{ Name: p.name, ...(p.email ? { EmailAddress: p.email } : {}) }] }, key, deps);
      return first(res, "Contacts", "ContactID", null, kind).id;
    },
    async createSales(doc, key) {
      const { path, body } = build(() => salesToXero(doc));
      const res = await xeroPut<Record<string, unknown>>(auth, path, body, key, deps);
      return path === "Invoices" ? first(res, "Invoices", "InvoiceID", "InvoiceNumber", "invoice") : first(res, "CreditNotes", "CreditNoteID", "CreditNoteNumber", "credit note");
    },
    async createBill(doc, key) {
      const res = await xeroPut<Record<string, unknown>>(auth, "Invoices", build(() => billToXero(doc)), key, deps);
      return first(res, "Invoices", "InvoiceID", "InvoiceNumber", "bill");
    },
    async createPayment(doc, key) {
      const res = await xeroPut<Record<string, unknown>>(auth, "Payments", build(() => paymentToXero(doc)), key, deps);
      return first(res, "Payments", "PaymentID", null, "payment");
    },
    async createJournal(doc, key) {
      const res = await xeroPut<Record<string, unknown>>(auth, "ManualJournals", build(() => journalToXero(doc)), key, deps);
      return first(res, "ManualJournals", "ManualJournalID", null, "manual journal");
    },
    async listParties(kind, page) {
      const r = await xeroGet<{ Contacts?: XeroContact[] }>(auth, "Contacts", { page, where: kind === "customer" ? "IsCustomer==true" : "IsSupplier==true" }, deps);
      const rows = r?.Contacts ?? [];
      return {
        parties: rows.flatMap((c) => {
          if (c.ContactStatus === "ARCHIVED") return [];
          const x = partyFromXero(c);
          return x ? [x] : [];
        }),
        more: rows.length >= PAGE,
      };
    },
  };
}
