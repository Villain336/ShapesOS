// ShapesOS — Phase 11 (bizsync): QuickBooks Online payloads (PURE).
//
// Documented shapes (developer.intuit.com … /api/accounting/all-entities):
//   Account   { Id, Name, AcctNum?, AccountType, AccountSubType, Classification, Active }
//   Customer / Vendor { Id, DisplayName, PrimaryEmailAddr?.Address,
//             PrimaryPhone?.FreeFormNumber, TaxIdentifier?, BillAddr?, MetaData.LastUpdatedTime }
//   Invoice / CreditMemo  Line[SalesItemLineDetail { ItemRef, Qty, UnitPrice }],
//             CustomerRef, TxnDate, DueDate, DocNumber (≤ 21), TxnTaxDetail.TotalTax
//   Bill      Line[AccountBasedExpenseLineDetail { AccountRef }], VendorRef
//   Payment   CustomerRef, TotalAmt, DepositToAccountRef, Line[{ Amount, LinkedTxn[{ TxnId, TxnType: "Invoice" }] }]
//   BillPayment VendorRef, PayType "Check", CheckPayment.BankAccountRef, Line[… TxnType "Bill"]
//   JournalEntry Line[JournalEntryLineDetail { PostingType Debit|Credit, AccountRef }]
// Amounts are decimals in the company currency (2 dp); dates are YYYY-MM-DD.
// Sales lines need an Item: ShapesOS uses one Service item per income
// account ("ShapesOS sales — <account>"), created on first use.
// Tax: the document's tax total goes in TxnTaxDetail.TotalTax. Companies on
// automated sales tax may recompute it (UNVERIFIED-LIVE).

import type { BillDoc, JournalDoc, LocalAccountClass, PaymentDoc, RemoteAccount, RemoteParty, SalesDoc } from "../accounting/types";

export const amt = (cents: number): number => Math.round(cents) / 100;
export const qboDate = (d: Date): string => d.toISOString().slice(0, 10);
const docNumber = (n: string | null | undefined) => (n ? n.slice(0, 21) : undefined);

const CLASS: Record<string, LocalAccountClass> = { Asset: "asset", Liability: "liability", Equity: "equity", Revenue: "income", Expense: "expense" };

export interface QboAccount {
  Id?: string;
  Name?: string;
  AcctNum?: string;
  AccountType?: string;
  AccountSubType?: string;
  Classification?: string;
  Active?: boolean;
}

export function accountFromQbo(a: QboAccount): RemoteAccount | null {
  if (!a.Id || !a.Name) return null;
  const cls = CLASS[a.Classification ?? ""] ?? (/income/i.test(a.AccountType ?? "") ? "income" : /expense|cost of goods/i.test(a.AccountType ?? "") ? "expense" : null);
  if (!cls) return null;
  const t = a.AccountType ?? "";
  const sub = a.AccountSubType ?? "";
  const role: RemoteAccount["role"] =
    t === "Accounts Receivable" ? "ar" : t === "Accounts Payable" ? "ap" : t === "Bank" ? "bank" : /SalesTaxPayable|GlobalTaxPayable/.test(sub) ? "tax" : sub === "RetainedEarnings" ? "retained" : null;
  return { id: String(a.Id), code: a.AcctNum?.trim() || null, name: a.Name, type: t || "Unknown", cls, role, active: a.Active !== false };
}

export interface QboParty {
  Id?: string;
  DisplayName?: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  TaxIdentifier?: string;
  BillAddr?: { Line1?: string; Line2?: string; City?: string; CountrySubDivisionCode?: string; PostalCode?: string; Country?: string };
  MetaData?: { LastUpdatedTime?: string };
}

export function partyFromQbo(p: QboParty, kind: "customer" | "vendor"): RemoteParty | null {
  if (!p.Id) return null;
  const a = p.BillAddr;
  const address = a ? [a.Line1, a.Line2, [a.City, a.CountrySubDivisionCode, a.PostalCode].filter(Boolean).join(" "), a.Country].filter((x) => x && x.trim()).join("\n") || null : null;
  return {
    id: String(p.Id),
    name: (p.DisplayName ?? p.CompanyName ?? `QuickBooks ${kind} ${p.Id}`).trim(),
    email: p.PrimaryEmailAddr?.Address?.trim() || null,
    phone: p.PrimaryPhone?.FreeFormNumber?.trim() || null,
    updatedAt: p.MetaData?.LastUpdatedTime ?? new Date(0).toISOString(),
    isCustomer: kind === "customer",
    isVendor: kind === "vendor",
    // QBO masks TaxIdentifier on read ("XXX-XX-1234") — keep only an unmasked value.
    taxId: p.TaxIdentifier && !/X/.test(p.TaxIdentifier) ? p.TaxIdentifier : null,
    address,
  };
}

export function salesToQbo(doc: SalesDoc, itemFor: (remoteAccountId: string) => string): Record<string, unknown> {
  return {
    CustomerRef: { value: doc.customerRemoteId },
    TxnDate: qboDate(doc.date),
    ...(doc.dueDate ? { DueDate: qboDate(doc.dueDate) } : {}),
    ...(docNumber(doc.number) ? { DocNumber: docNumber(doc.number) } : {}),
    Line: doc.lines.map((l) => ({
      DetailType: "SalesItemLineDetail",
      Amount: amt(l.amountCents),
      Description: l.description,
      SalesItemLineDetail: { ItemRef: { value: itemFor(l.account.id) }, Qty: l.qty, UnitPrice: amt(l.unitCents) },
    })),
    ...(doc.taxCents > 0 ? { TxnTaxDetail: { TotalTax: amt(doc.taxCents) } } : {}),
    ...(doc.creditsRemoteId ? { PrivateNote: `Credits QuickBooks invoice ${doc.creditsRemoteId}` } : {}),
  };
}

export function billToQbo(doc: BillDoc): Record<string, unknown> {
  return {
    VendorRef: { value: doc.vendorRemoteId },
    TxnDate: qboDate(doc.date),
    ...(doc.dueDate ? { DueDate: qboDate(doc.dueDate) } : {}),
    ...(docNumber(doc.number) ? { DocNumber: docNumber(doc.number) } : {}),
    Line: doc.lines.map((l) => ({
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: amt(l.amountCents),
      Description: l.description,
      AccountBasedExpenseLineDetail: { AccountRef: { value: l.account.id } },
    })),
    ...(doc.taxCents > 0 ? { TxnTaxDetail: { TotalTax: amt(doc.taxCents) } } : {}),
    ...(doc.memo ? { PrivateNote: doc.memo.slice(0, 4000) } : {}),
  };
}

export function paymentToQbo(doc: PaymentDoc): { entity: "payment" | "billpayment"; body: Record<string, unknown> } {
  const line = [{ Amount: amt(doc.amountCents), LinkedTxn: [{ TxnId: doc.targetRemoteId, TxnType: doc.kind === "payment" ? "Invoice" : "Bill" }] }];
  if (doc.kind === "payment") {
    return {
      entity: "payment",
      body: {
        CustomerRef: { value: doc.partyRemoteId },
        TotalAmt: amt(doc.amountCents),
        TxnDate: qboDate(doc.date),
        DepositToAccountRef: { value: doc.cashAccount.id },
        ...(doc.reference ? { PaymentRefNum: doc.reference.slice(0, 21) } : {}),
        Line: line,
      },
    };
  }
  return {
    entity: "billpayment",
    body: {
      VendorRef: { value: doc.partyRemoteId },
      PayType: "Check",
      CheckPayment: { BankAccountRef: { value: doc.cashAccount.id } },
      TotalAmt: amt(doc.amountCents),
      TxnDate: qboDate(doc.date),
      ...(doc.reference ? { PrivateNote: doc.reference.slice(0, 4000) } : {}),
      Line: line,
    },
  };
}

export function journalToQbo(doc: JournalDoc): Record<string, unknown> {
  return {
    TxnDate: qboDate(doc.date),
    ...(doc.memo ? { PrivateNote: doc.memo.slice(0, 4000) } : {}),
    ...(docNumber(doc.number) ? { DocNumber: docNumber(doc.number) } : {}),
    Line: doc.lines.map((l) => ({
      DetailType: "JournalEntryLineDetail",
      Amount: amt(l.debitCents > 0 ? l.debitCents : l.creditCents),
      ...(l.description ? { Description: l.description.slice(0, 4000) } : {}),
      JournalEntryLineDetail: { PostingType: l.debitCents > 0 ? "Debit" : "Credit", AccountRef: { value: l.account.id } },
    })),
  };
}

/** The ShapesOS service item that carries sales into one income account. */
export function incomeItemName(accountName: string): string {
  return `ShapesOS sales — ${accountName}`.replace(/[:\t\n]/g, " ").slice(0, 100);
}
