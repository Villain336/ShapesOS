// ShapesOS — Phase 11 (bizsync): Xero payloads (PURE).
//
// Documented shapes (developer.xero.com/documentation/api/accounting/*):
//   Account  { AccountID, Code, Name, Type, Class, Status, SystemAccount }
//            Class ASSET|LIABILITY|EQUITY|REVENUE|EXPENSE; SystemAccount
//            DEBTORS|CREDITORS|GST|RETAINEDEARNINGS|…; Type BANK for bank accounts.
//   Contact  { ContactID, Name, EmailAddress, Phones[], TaxNumber,
//            Addresses[], IsCustomer, IsSupplier, UpdatedDateUTC "/Date(ms+0000)/" }
//   Invoices { Type ACCREC (sale) | ACCPAY (bill), Contact{ContactID}, Date,
//            DueDate, InvoiceNumber, LineAmountTypes "Exclusive", Status
//            "AUTHORISED", LineItems[{ Description, Quantity, UnitAmount,
//            AccountCode, TaxAmount | TaxType "NONE" }] }
//   CreditNotes { Type ACCRECCREDIT, CreditNoteNumber, … same lines }
//   Payments { Invoice{InvoiceID} | CreditNote, Account{AccountID}, Date, Amount, Reference }
//   ManualJournals { Narration, Date, Status "POSTED", LineAmountTypes "NoTax",
//            JournalLines[{ LineAmount (+debit / −credit), AccountCode, Description }] }
// Tax: each line's share of the document tax goes in TaxAmount; untaxed
// lines say TaxType "NONE" so Xero doesn't add the account's default rate
// (UNVERIFIED-LIVE per region).

import type { BillDoc, JournalDoc, LocalAccountClass, PaymentDoc, RemoteAccount, RemoteParty, SalesDoc } from "../accounting/types";

export const amt = (cents: number): number => Math.round(cents) / 100;
export const xeroDate = (d: Date): string => d.toISOString().slice(0, 10);

/** "/Date(1696000000000+0000)/" (or ISO) → ISO string. PURE. */
export function xeroDateToIso(v: unknown): string {
  if (typeof v !== "string") return new Date(0).toISOString();
  const m = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(v);
  const d = m ? new Date(Number(m[1])) : new Date(v);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

const CLASS: Record<string, LocalAccountClass> = { ASSET: "asset", LIABILITY: "liability", EQUITY: "equity", REVENUE: "income", EXPENSE: "expense" };

export interface XeroAccount {
  AccountID?: string;
  Code?: string;
  Name?: string;
  Type?: string;
  Class?: string;
  Status?: string;
  SystemAccount?: string;
}

export function accountFromXero(a: XeroAccount): RemoteAccount | null {
  const cls = CLASS[a.Class ?? ""];
  if (!a.AccountID || !a.Name || !cls) return null;
  const sys = a.SystemAccount ?? "";
  const role: RemoteAccount["role"] =
    sys === "DEBTORS" ? "ar" : sys === "CREDITORS" ? "ap" : a.Type === "BANK" ? "bank" : sys === "GST" ? "tax" : sys === "RETAINEDEARNINGS" ? "retained" : null;
  return { id: a.AccountID, code: a.Code?.trim() || null, name: a.Name, type: a.Type ?? "UNKNOWN", cls, role, active: (a.Status ?? "ACTIVE") === "ACTIVE" };
}

export interface XeroContact {
  ContactID?: string;
  Name?: string;
  EmailAddress?: string;
  Phones?: Array<{ PhoneType?: string; PhoneNumber?: string; PhoneAreaCode?: string; PhoneCountryCode?: string }>;
  TaxNumber?: string;
  Addresses?: Array<{ AddressType?: string; AddressLine1?: string; AddressLine2?: string; City?: string; Region?: string; PostalCode?: string; Country?: string }>;
  IsCustomer?: boolean;
  IsSupplier?: boolean;
  ContactStatus?: string;
  UpdatedDateUTC?: string;
}

export function partyFromXero(c: XeroContact): RemoteParty | null {
  if (!c.ContactID || !c.Name) return null;
  const phone = (c.Phones ?? []).find((p) => p.PhoneNumber?.trim() && (p.PhoneType ?? "DEFAULT") === "DEFAULT") ?? (c.Phones ?? []).find((p) => p.PhoneNumber?.trim());
  const addr = (c.Addresses ?? []).find((a) => a.AddressType === "POBOX") ?? (c.Addresses ?? [])[0];
  const address = addr
    ? [addr.AddressLine1, addr.AddressLine2, [addr.City, addr.Region, addr.PostalCode].filter(Boolean).join(" "), addr.Country].filter((x) => x && x.trim()).join("\n") || null
    : null;
  return {
    id: c.ContactID,
    name: c.Name.trim(),
    email: c.EmailAddress?.trim() || null,
    phone: phone ? [phone.PhoneCountryCode, phone.PhoneAreaCode, phone.PhoneNumber].filter((x) => x && x.trim()).join(" ") : null,
    updatedAt: xeroDateToIso(c.UpdatedDateUTC),
    isCustomer: c.IsCustomer === true,
    isVendor: c.IsSupplier === true,
    taxId: c.TaxNumber?.trim() || null,
    address,
  };
}

/** Xero manual journals and line items address accounts by Code. */
export function codeOf(account: { code: string | null; name: string }): string {
  if (!account.code) throw new Error(`The Xero account "${account.name}" has no code — give it one in Xero, then export again.`);
  return account.code;
}

function lineItems(doc: { lines: SalesDoc["lines"] }) {
  return doc.lines.map((l) => ({
    Description: l.description,
    Quantity: l.qty,
    UnitAmount: amt(l.unitCents),
    AccountCode: codeOf(l.account),
    ...(l.taxCents > 0 ? { TaxAmount: amt(l.taxCents) } : { TaxType: "NONE" }),
  }));
}

export function salesToXero(doc: SalesDoc): { path: "Invoices" | "CreditNotes"; body: Record<string, unknown> } {
  if (doc.kind === "credit_note") {
    return {
      path: "CreditNotes",
      body: {
        CreditNotes: [{
          Type: "ACCRECCREDIT",
          Contact: { ContactID: doc.customerRemoteId },
          Date: xeroDate(doc.date),
          ...(doc.number ? { CreditNoteNumber: doc.number.slice(0, 255) } : {}),
          ...(doc.creditsRemoteId ? { Reference: `Credits ${doc.creditsRemoteId}` } : {}),
          LineAmountTypes: "Exclusive",
          Status: "AUTHORISED",
          LineItems: lineItems(doc),
        }],
      },
    };
  }
  return {
    path: "Invoices",
    body: {
      Invoices: [{
        Type: "ACCREC",
        Contact: { ContactID: doc.customerRemoteId },
        Date: xeroDate(doc.date),
        DueDate: xeroDate(doc.dueDate ?? doc.date),
        ...(doc.number ? { InvoiceNumber: doc.number.slice(0, 255) } : {}),
        LineAmountTypes: "Exclusive",
        Status: "AUTHORISED",
        LineItems: lineItems(doc),
      }],
    },
  };
}

export function billToXero(doc: BillDoc): Record<string, unknown> {
  return {
    Invoices: [{
      Type: "ACCPAY",
      Contact: { ContactID: doc.vendorRemoteId },
      Date: xeroDate(doc.date),
      DueDate: xeroDate(doc.dueDate ?? doc.date),
      ...(doc.number ? { InvoiceNumber: doc.number.slice(0, 255) } : {}),
      ...(doc.memo ? { Reference: doc.memo.slice(0, 255) } : {}),
      LineAmountTypes: "Exclusive",
      Status: "AUTHORISED",
      LineItems: lineItems(doc),
    }],
  };
}

export function paymentToXero(doc: PaymentDoc): Record<string, unknown> {
  return {
    Payments: [{
      Invoice: { InvoiceID: doc.targetRemoteId },
      Account: { AccountID: doc.cashAccount.id },
      Date: xeroDate(doc.date),
      Amount: amt(doc.amountCents),
      ...(doc.reference ? { Reference: doc.reference.slice(0, 255) } : {}),
    }],
  };
}

export function journalToXero(doc: JournalDoc): Record<string, unknown> {
  return {
    ManualJournals: [{
      Narration: (doc.memo ?? "ShapesOS journal entry").slice(0, 4000),
      Date: xeroDate(doc.date),
      Status: "POSTED",
      LineAmountTypes: "NoTax",
      JournalLines: doc.lines.map((l) => ({
        LineAmount: l.debitCents > 0 ? amt(l.debitCents) : -amt(l.creditCents),
        AccountCode: codeOf(l.account),
        ...(l.description ? { Description: l.description.slice(0, 4000) } : {}),
      })),
    }],
  };
}

/** Xero `where` string literal (double quotes, backslash-escaped). PURE. */
export function xeroQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
