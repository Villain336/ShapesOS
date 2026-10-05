// ShapesOS — Phase 11 (bizsync): the provider-neutral accounting shapes
// shared by QuickBooks Online and Xero. The export engine
// (./export.ts) builds these documents from the local append-only journal
// and the documents it was posted for; each provider (lib/bizsync/quickbooks,
// lib/bizsync/xero) only translates them into its own API payloads.

export type AccountingProviderKey = "quickbooks" | "xero";
export type LocalAccountClass = "asset" | "liability" | "equity" | "income" | "expense";

/** A remote chart account, normalized. */
export interface RemoteAccount {
  id: string;
  code: string | null;
  name: string;
  /** The provider's own type label (QBO AccountType / Xero Type). */
  type: string;
  cls: LocalAccountClass;
  /** Special role the provider marks: receivable, payable, bank, tax, retained earnings. */
  role: "ar" | "ap" | "bank" | "tax" | "retained" | null;
  active: boolean;
}

/** The remote account a local account is confirmed to map to. */
export interface RemoteAccountRef {
  id: string;
  code: string | null;
  name: string;
}

export interface ExportLine {
  description: string;
  qty: number;
  unitCents: number;
  /** qty × unit (net of tax). */
  amountCents: number;
  /** This line's share of the document tax. */
  taxCents: number;
  account: RemoteAccountRef;
}

export interface SalesDoc {
  kind: "invoice" | "credit_note";
  number: string | null;
  date: Date;
  dueDate: Date | null;
  customerRemoteId: string;
  lines: ExportLine[];
  taxCents: number;
  totalCents: number;
  /** The remote invoice a credit note credits (when exported). */
  creditsRemoteId?: string | null;
  memo?: string | null;
}

export interface BillDoc {
  /** The vendor's own invoice number (OpsVendorBill.vendorRef) or our number. */
  number: string | null;
  date: Date;
  dueDate: Date | null;
  vendorRemoteId: string;
  lines: ExportLine[];
  taxCents: number;
  totalCents: number;
  memo?: string | null;
}

export interface PaymentDoc {
  kind: "payment" | "bill_payment";
  date: Date;
  amountCents: number;
  /** Where the money landed / left (the posted entry's cash line). */
  cashAccount: RemoteAccountRef;
  /** The remote invoice / bill it settles. */
  targetRemoteId: string;
  /** The remote customer / vendor. */
  partyRemoteId: string;
  reference: string | null;
}

export interface JournalDoc {
  date: Date;
  memo: string | null;
  number: string | null;
  lines: Array<{ account: RemoteAccountRef; debitCents: number; creditCents: number; description: string | null }>;
}

export interface RemoteRef {
  id: string;
  number?: string | null;
}

export interface RemoteParty {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  updatedAt: string;
  isCustomer: boolean;
  isVendor: boolean;
  /** Vendor extras (Xero/QBO tax number, address text). */
  taxId?: string | null;
  address?: string | null;
}

/**
 * What a provider implements for the shared engines. Every create receives a
 * stable idempotency key (source key + attempt): QuickBooks sends it as
 * ?requestid=, Xero as the Idempotency-Key header — a retried create returns
 * the original document instead of posting twice.
 */
export interface AccountingProvider {
  key: AccountingProviderKey;
  label: string;
  listAccounts(): Promise<RemoteAccount[]>;
  /** Find a customer / vendor by name, else create it (idempotent by key). */
  findOrCreateParty(kind: "customer" | "vendor", p: { name: string; email: string | null }, key: string): Promise<string>;
  createSales(doc: SalesDoc, key: string): Promise<RemoteRef>;
  createBill(doc: BillDoc, key: string): Promise<RemoteRef>;
  createPayment(doc: PaymentDoc, key: string): Promise<RemoteRef>;
  createJournal(doc: JournalDoc, key: string): Promise<RemoteRef>;
  /** One page (1-based) of customers or vendors for the contact import. */
  listParties(kind: "customer" | "vendor", page: number): Promise<{ parties: RemoteParty[]; more: boolean }>;
}
