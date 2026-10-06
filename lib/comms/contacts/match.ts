// ShapesOS — Phase 18.2 (WS=comms): Contacts — who is the same person?
// (PURE: normalization, evidence, scores, candidate pairs.)
//
// The address book links records from four stores (CRM leads, Ops contacts,
// Network people, funding contacts). Two records are SUGGESTED as one person
// when they share evidence:
//
//   same email (normalized)                     0.95
//   same phone (last 10 digits, ≥ 7 digits)     0.90
//   same name AND same company                  0.80
//   same name AND same email domain (not free)  0.70
//   same name only (two or more words)          0.55  — below the bar alone
//
// Several kinds of evidence add up (each extra one +0.04, capped at 0.99).
// Only pairs at or above SUGGEST_THRESHOLD are suggested — and a suggestion
// is only ever a suggestion: a person confirms or rejects it (never
// automatic), and a rejection is remembered for the record pair.

export const RECORD_KINDS = ["lead", "ops_contact", "connector_person", "funding_contact"] as const;
export type ContactRecordKind = (typeof RECORD_KINDS)[number];

export function isContactRecordKind(v: unknown): v is ContactRecordKind {
  return typeof v === "string" && (RECORD_KINDS as readonly string[]).includes(v);
}

export interface PersonRecord {
  kind: ContactRecordKind;
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  company: string | null;
  title: string | null;
  updatedAt: Date | null;
}

export const SUGGEST_THRESHOLD = 0.6;

export type EvidenceReason = "email" | "phone" | "name_company" | "name_domain" | "name";

export const REASON_SCORES: Readonly<Record<EvidenceReason, number>> = {
  email: 0.95,
  phone: 0.9,
  name_company: 0.8,
  name_domain: 0.7,
  name: 0.55,
};

const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "qq.com",
  "163.com",
]);

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** Lower-case, trimmed; Gmail dots and +tags are NOT folded (they can be different people's aliases). */
export function normalizeEmail(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /<([^>]+)>/.exec(v);
  const e = (m ? m[1]! : v).trim().toLowerCase().replace(/^mailto:/, "");
  return EMAIL_RE.test(e) ? e : null;
}

/** Digits only; the last 10 (so +1 415… and (415)… match); null under 7 digits. */
export function normalizePhone(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = v.replace(/\D/g, "");
  if (d.length < 7) return null;
  return d.length > 10 ? d.slice(-10) : d;
}

/** "Dr. Ana  María O'Neil-Ruiz" → "ana maria oneil ruiz" (accents and punctuation folded). */
export function normalizeName(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|dr|prof|sr|sra|jr)\.?\s+/g, " ")
    .replace(/['’`.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return s || null;
}

/** "Acme, Inc." / "ACME Incorporated" → "acme". */
export function normalizeCompany(v: string | null | undefined): string | null {
  const n = normalizeName(v);
  if (!n) return null;
  const s = n.replace(/\b(inc|incorporated|llc|ltd|limited|gmbh|sa|sl|sas|bv|corp|corporation|co|company|plc|ag)\b/g, " ").replace(/\s+/g, " ").trim();
  return s || null;
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1) : null;
}

/** Every email-looking value in a list of handles (Network people keep emails among handles). */
export function emailsIn(values: readonly (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    const e = normalizeEmail(v);
    if (e) out.add(e);
  }
  return [...out];
}

export interface PairEvidence {
  score: number;
  reasons: EvidenceReason[];
}

/** The evidence that two records are one person (score 0 = none). */
export function compareRecords(a: PersonRecord, b: PersonRecord): PairEvidence {
  const reasons: EvidenceReason[] = [];
  const ae = new Set(a.emails.map((e) => normalizeEmail(e)).filter((e): e is string => !!e));
  const be = b.emails.map((e) => normalizeEmail(e)).filter((e): e is string => !!e);
  if (be.some((e) => ae.has(e))) reasons.push("email");
  const ap = new Set(a.phones.map((p) => normalizePhone(p)).filter((p): p is string => !!p));
  if (b.phones.map((p) => normalizePhone(p)).some((p) => !!p && ap.has(p))) reasons.push("phone");
  const an = normalizeName(a.name);
  const bn = normalizeName(b.name);
  if (an && bn && an === bn) {
    const ac = normalizeCompany(a.company);
    const bc = normalizeCompany(b.company);
    const domains = (emails: Iterable<string>) => new Set([...emails].map(emailDomain).filter((d): d is string => !!d && !FREE_MAIL.has(d)));
    const ad = domains(ae);
    if (ac && bc && ac === bc) reasons.push("name_company");
    else if ([...domains(be)].some((d) => ad.has(d))) reasons.push("name_domain");
    else if (an.includes(" ")) reasons.push("name");
  }
  if (!reasons.length) return { score: 0, reasons };
  const sorted = [...reasons].sort((x, y) => REASON_SCORES[y] - REASON_SCORES[x]);
  const score = Math.min(0.99, REASON_SCORES[sorted[0]!] + 0.04 * (sorted.length - 1));
  return { score: Math.round(score * 100) / 100, reasons: sorted };
}

export function recordKey(r: Pick<PersonRecord, "kind" | "id">): string {
  return `${r.kind}:${r.id}`;
}

/** Canonical order for a pair (the suggestion's unique key). */
export function orderPair<T extends Pick<PersonRecord, "kind" | "id">>(a: T, b: T): [T, T] {
  return recordKey(a) <= recordKey(b) ? [a, b] : [b, a];
}

export interface CandidatePair {
  a: PersonRecord;
  b: PersonRecord;
  evidence: PairEvidence;
}

/**
 * Candidate pairs among records, by blocking on email, phone and name (no
 * all-pairs scan): only pairs in DIFFERENT identities (identityOf) that score
 * at or above the threshold, and not in a remembered rejection (rejected
 * holds "identityA|identityB" keys in both orders). One pair per identity
 * pair — the strongest.
 */
export function candidatePairs(
  records: readonly PersonRecord[],
  identityOf: (r: PersonRecord) => string,
  rejected: ReadonlySet<string> = new Set(),
  threshold = SUGGEST_THRESHOLD,
  maxBlock = 50,
): CandidatePair[] {
  const blocks = new Map<string, PersonRecord[]>();
  const add = (key: string | null, r: PersonRecord) => {
    if (!key) return;
    const list = blocks.get(key);
    if (list) list.push(r);
    else blocks.set(key, [r]);
  };
  for (const r of records) {
    for (const e of r.emails) {
      const n = normalizeEmail(e);
      add(n ? `e:${n}` : null, r);
    }
    for (const p of r.phones) {
      const n = normalizePhone(p);
      add(n ? `p:${n}` : null, r);
    }
    const n = normalizeName(r.name);
    add(n ? `n:${n}` : null, r);
  }
  const best = new Map<string, CandidatePair>();
  for (const [key, list] of blocks) {
    // A huge block (a shared info@ address, a common name) is not evidence of one person.
    if (list.length < 2 || list.length > maxBlock) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = list[i]!;
        const y = list[j]!;
        const ix = identityOf(x);
        const iy = identityOf(y);
        if (ix === iy) continue;
        const idKey = ix < iy ? `${ix}|${iy}` : `${iy}|${ix}`;
        if (rejected.has(idKey)) continue;
        const evidence = compareRecords(x, y);
        if (evidence.score < threshold) continue;
        const prior = best.get(idKey);
        if (!prior || evidence.score > prior.evidence.score) {
          const [a, b] = orderPair(x, y);
          best.set(idKey, { a, b, evidence });
        }
      }
    }
  }
  return [...best.values()].sort((p, q) => q.evidence.score - p.evidence.score);
}

/** The identity's search cache from its records: best name, all emails / phones / companies. */
export function identitySummary(records: readonly PersonRecord[]): { displayName: string; emails: string[]; phones: string[]; companies: string[] } {
  const prefer: Record<ContactRecordKind, number> = { ops_contact: 0, lead: 1, connector_person: 2, funding_contact: 3 };
  const sorted = [...records].sort((a, b) => prefer[a.kind] - prefer[b.kind] || b.name.length - a.name.length);
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x && !!x.trim()))];
  return {
    displayName: sorted.find((r) => r.name.trim())?.name.trim() ?? sorted[0]?.emails[0] ?? "Unknown",
    emails: uniq(records.flatMap((r) => r.emails.map((e) => normalizeEmail(e)))).slice(0, 20),
    phones: uniq(records.flatMap((r) => r.phones.map((p) => p.trim()))).slice(0, 20),
    companies: uniq(records.map((r) => r.company?.trim() ?? null)).slice(0, 10),
  };
}
