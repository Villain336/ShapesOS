// Marketr — Resend port (milestone 19).
//
// Thin wrapper around the Resend SDK so the newsletter service never touches
// the SDK directly: tests inject MockResendPort (no network, no spend) and
// production injects createResendPort(decryptedKey). Every SDK response is
// checked for `error` and thrown as an Error — callers never see the
// `{ data, error }` union.

import { Resend } from "resend";

export interface NewsletterDnsRecord {
  name: string;
  type: string;
  value: string;
  /** spf | dkim | receiving | tracking | dmarc-note */
  purpose: string;
}

export interface BatchEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  headers?: Record<string, string>;
}

export interface ResendPort {
  createSegment(name: string): Promise<{ id: string }>;
  removeSegment(id: string): Promise<void>;
  createContact(
    segmentId: string,
    args: { email: string; firstName?: string; lastName?: string; unsubscribed?: boolean },
  ): Promise<{ id: string }>;
  setContactUnsubscribed(email: string, unsubscribed: boolean): Promise<void>;
  /**
   * Bulk delivery. NOTE on the milestone-19 spec ("Resend Broadcasts"): the
   * Broadcasts API sends a single HTML payload to a segment, which cannot
   * carry the spec-mandated per-recipient unsubscribe token. Delivery therefore
   * uses batched personalized sends — one email per subscribed recipient, each
   * with their tokenized unsubscribe link plus RFC 8058 List-Unsubscribe
   * headers — while list/segment management still goes through Resend's
   * Audiences→Segments API for dashboard parity.
   */
  sendBatch(emails: BatchEmail[]): Promise<{ ids: string[] }>;
  createDomain(name: string): Promise<{ id: string; records: NewsletterDnsRecord[] }>;
  getDomain(id: string): Promise<{ id: string; status: string; records: NewsletterDnsRecord[] }>;
  /** Ask Resend to re-check DNS (its verify endpoint returns no status — call getDomain after). */
  verifyDomain(id: string): Promise<void>;
  /** Single test email (emails.send, not a batch). */
  sendEmail(args: { from: string; to: string; subject: string; html: string }): Promise<{ id: string }>;
}

function throwIfError(res: { error: unknown }, op: string): void {
  if (res.error) {
    const e = res.error as { message?: string; name?: string };
    throw new Error(`Resend ${op} failed: ${e.message ?? e.name ?? "unknown error"}`);
  }
}

function toDnsRecords(records: Array<{ record: string; name: string; type: string; value: string }>): NewsletterDnsRecord[] {
  const out: NewsletterDnsRecord[] = records.map((r) => ({
    name: r.name,
    type: r.type,
    value: r.value,
    purpose:
      r.record === "SPF"
        ? "spf"
        : r.record === "DKIM"
          ? "dkim"
          : r.record === "Receiving"
            ? "receiving"
            : "tracking",
  }));
  return out;
}

/**
 * DMARC is not issued by Resend — every sending domain needs its own DMARC
 * TXT record. We surface it as a `dmarc-note` pseudo-record in the setup
 * wizard so the operator copies it into DNS alongside the Resend records.
 */
export function dmarcRecordFor(domain: string): NewsletterDnsRecord {
  return {
    name: `_dmarc.${domain}`,
    type: "TXT",
    value: "v=DMARC1; p=none; rua=mailto:dmarc@" + domain,
    purpose: "dmarc-note",
  };
}

/** Production port backed by the real Resend SDK. */
export function createResendPort(apiKey: string): ResendPort {
  const resend = new Resend(apiKey);
  return {
    async createSegment(name: string) {
      const res = await resend.segments.create({ name });
      throwIfError(res, "segments.create");
      return { id: (res.data as { id: string }).id };
    },
    async removeSegment(id: string) {
      const res = await resend.segments.remove(id);
      throwIfError(res, "segments.remove");
    },
    async createContact(segmentId, args) {
      const res = await resend.contacts.create({
        email: args.email,
        firstName: args.firstName,
        lastName: args.lastName,
        unsubscribed: args.unsubscribed,
        segments: [{ id: segmentId }],
      });
      throwIfError(res, "contacts.create");
      return { id: (res.data as { id: string }).id };
    },
    async setContactUnsubscribed(email: string, unsubscribed: boolean) {
      const res = await resend.contacts.update({ email, unsubscribed });
      throwIfError(res, "contacts.update");
    },
    async sendBatch(emails: BatchEmail[]) {
      // Resend batch caps at 100 recipients per call — chunk server-side.
      const ids: string[] = [];
      for (let i = 0; i < emails.length; i += 100) {
        const chunk = emails.slice(i, i + 100);
        const res = await resend.batch.send(
          chunk.map((e) => ({
            from: e.from,
            to: e.to,
            subject: e.subject,
            html: e.html,
            headers: e.headers,
          })),
        );
        throwIfError(res, "batch.send");
        // SDK shape: { data: { data: [{ id }] } } — data.data is the id list.
        const rows = (res.data?.data ?? []) as { id: string }[];
        for (const row of rows) ids.push(row.id ?? "");
        // Rate-limit courtesy between chunks.
        if (i + 100 < emails.length) await new Promise((r) => setTimeout(r, 600));
      }
      return { ids };
    },
    async createDomain(name: string) {
      const res = await resend.domains.create({ name });
      throwIfError(res, "domains.create");
      const data = res.data as { id: string; records: Array<{ record: string; name: string; type: string; value: string }> };
      return { id: data.id, records: [...toDnsRecords(data.records), dmarcRecordFor(name)] };
    },
    async getDomain(id: string) {
      const res = await resend.domains.get(id);
      throwIfError(res, "domains.get");
      const data = res.data as { id: string; status: string; records: Array<{ record: string; name: string; type: string; value: string }> };
      return { id: data.id, status: data.status, records: toDnsRecords(data.records) };
    },
    async verifyDomain(id: string) {
      const res = await resend.domains.verify(id);
      throwIfError(res, "domains.verify");
    },
    async sendEmail(args) {
      const res = await resend.emails.send({
        from: args.from,
        to: args.to,
        subject: args.subject,
        html: args.html,
      });
      throwIfError(res, "emails.send");
      return { id: (res.data as { id: string }).id };
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory mock — records every call for fixture tests. No network.
// ---------------------------------------------------------------------------

export class MockResendPort implements ResendPort {
  calls: { op: string; args: unknown }[] = [];
  segments = new Map<string, string>();
  contacts: { segmentId: string; email: string; unsubscribed: boolean }[] = [];
  batchSends: BatchEmail[][] = [];
  testEmails: { from: string; to: string; subject: string; html: string }[] = [];
  domains = new Map<string, { status: string; records: NewsletterDnsRecord[] }>();
  private seq = 0;

  private next(prefix: string): string {
    this.seq += 1;
    return `mock_${prefix}_${this.seq}`;
  }

  async createSegment(name: string) {
    this.calls.push({ op: "createSegment", args: { name } });
    const id = this.next("seg");
    this.segments.set(id, name);
    return { id };
  }
  async removeSegment(id: string) {
    this.calls.push({ op: "removeSegment", args: { id } });
    this.segments.delete(id);
  }
  async createContact(segmentId: string, args: { email: string; firstName?: string; lastName?: string; unsubscribed?: boolean }) {
    this.calls.push({ op: "createContact", args: { segmentId, ...args } });
    this.contacts.push({ segmentId, email: args.email, unsubscribed: !!args.unsubscribed });
    return { id: this.next("contact") };
  }
  async setContactUnsubscribed(email: string, unsubscribed: boolean) {
    this.calls.push({ op: "setContactUnsubscribed", args: { email, unsubscribed } });
    for (const c of this.contacts) if (c.email === email) c.unsubscribed = unsubscribed;
  }
  async sendBatch(emails: BatchEmail[]) {
    this.calls.push({ op: "sendBatch", args: { count: emails.length, to: emails.map((e) => e.to) } });
    this.batchSends.push(emails);
    return { ids: emails.map(() => this.next("email")) };
  }
  async createDomain(name: string) {
    this.calls.push({ op: "createDomain", args: { name } });
    const id = this.next("domain");
    const records: NewsletterDnsRecord[] = [
      { name: `send.${name}`, type: "MX", value: "feedback-smtp.resend.com", purpose: "receiving" },
      { name: "resend._domainkey", type: "TXT", value: "p=MOCKDKIMKEY", purpose: "dkim" },
      { name, type: "TXT", value: "v=spf1 include:resend.com ~all", purpose: "spf" },
      dmarcRecordFor(name),
    ];
    this.domains.set(id, { status: "pending", records });
    return { id, records };
  }
  async getDomain(id: string) {
    this.calls.push({ op: "getDomain", args: { id } });
    const d = this.domains.get(id);
    if (!d) throw new Error(`Resend domains.get failed: unknown domain ${id}`);
    return { id, status: d.status, records: d.records };
  }
  async verifyDomain(id: string) {
    this.calls.push({ op: "verifyDomain", args: { id } });
    const d = this.domains.get(id);
    if (!d) throw new Error(`Resend domains.verify failed: unknown domain ${id}`);
    d.status = "verified";
  }
  async sendEmail(args: { from: string; to: string; subject: string; html: string }) {
    this.calls.push({ op: "sendEmail", args: { ...args, html: `<${args.html.length} chars>` } });
    this.testEmails.push(args);
    return { id: this.next("email") };
  }
}
