// Marketr — Growth Memory anonymization transform (Phase 8 G3, spec §9.3).
//
// playbook_learnings is the ONLY cross-tenant table. Rows enter it ONLY
// through this transform AND a human review gate. The transform strips:
// names, domains, emails, URLs, spend figures, phone numbers, street
// addresses. Adversarial fixtures live in fixtures/adversarial.ts; the
// battery asserts none of the planted identifiers survive.
//
// Design note: this is a deterministic, reviewable transform — not an LLM
// call. Anything it cannot confidently strip, it quarantines: if the input
// still matches a high-risk pattern after one pass, the candidate is marked
// needsManualReview and is NOT proposed.

export interface AnonymizeResult {
  title: string;
  body: string;
  /** Tokens the transform removed (kinds only — never echoed into output). */
  removedKinds: string[];
  /** True when a high-risk pattern survived the pass: do NOT propose. */
  needsManualReview: boolean;
}

const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const URL = /\bhttps?:\/\/[^\s)>\]"]+/gi;
const BARE_DOMAIN = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|ai|dev|app|shop|store|biz|info|us|uk|ca|au|de|fr)\b/gi;
const PHONE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
// Spend figures: $12,400 · $1.2M · 50k spend · USD 4,000 · "spent 12000"
const MONEY =
  /(?:\$|USD\s?|€|£)\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:k|K|m|M|million|billion))?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:k|K)\s?(?:spend|spent|budget|cost|cac|roas|cpa)\b|\b(?:spend|spent|budget|cost)\s?(?:of|was|:)?\s?\$?\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:k|K|m|M))?/gi;
const ADDRESS = /\b\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Way|Ct|Court)\b/g;
// Person names: two+ capitalized words (conservative — catches "Jane Smith").
// Single capitalized words are NOT stripped (too many false positives).
const PERSON_NAME = /\b([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})+)\b/g;
// Company-ish names: "Acme Corp", "Acme Inc", "Acme LLC", "Acme Co"
const COMPANY = /\b([A-Z][A-Za-z0-9&'.-]{1,30}\s+(?:Inc|Corp|LLC|Co|Ltd|GmbH|Pty|LLP|PA|PLLC)\.?)\b/g;

// Words that look like names but are marketing vocabulary — never strip.
const ALLOWLIST = new Set([
  "Meta Ads", "Google Ads", "TikTok Ads", "LinkedIn Ads", "Facebook Ads",
  "Instagram Ads", "Apple Search", "Black Friday", "Cyber Monday",
  "New Year", "Prime Day", "Memorial Day", "Labor Day", "Thanksgiving Day",
  "Christmas Day", "Mother Day", "Father Day", "Valentine Day",
  "Test Lab", "Growth Memory", "North Carolina", "New York", "Los Angeles",
  "San Francisco", "Las Vegas", "Salt Lake",
]);

function protectAllowlist(text: string): { text: string; restore: (s: string) => string } {
  const slots: string[] = [];
  let out = text;
  for (const phrase of ALLOWLIST) {
    const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    out = out.replace(re, (m) => {
      slots.push(m);
      return `\u0000${slots.length - 1}\u0000`;
    });
  }
  return { text: out, restore: (s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]) };
}

/** Anonymize a learning into a playbook-pattern candidate. */
export function anonymizeForPlaybook(title: string, body: string): AnonymizeResult {
  const removedKinds = new Set<string>();
  const step = (text: string): string => {
    let out = text;
    const { text: protected_, restore } = protectAllowlist(out);
    out = protected_;
    const apply = (re: RegExp, kind: string, token: string) => {
      re.lastIndex = 0;
      if (re.test(out)) {
        removedKinds.add(kind);
        re.lastIndex = 0;
        out = out.replace(re, token);
      }
    };
    apply(EMAIL, "email", "[EMAIL]");
    apply(URL, "url", "[URL]");
    apply(BARE_DOMAIN, "domain", "[DOMAIN]");
    apply(PHONE, "phone", "[PHONE]");
    apply(MONEY, "spend", "[SPEND]");
    apply(ADDRESS, "address", "[ADDRESS]");
    apply(COMPANY, "company", "[CLIENT]");
    apply(PERSON_NAME, "person_name", "[PERSON]");
    return restore(out);
  };

  const anonTitle = step(title);
  const anonBody = step(body);

  // Quarantine check: any high-risk pattern surviving the pass?
  const risky = [EMAIL, BARE_DOMAIN, PHONE, MONEY];
  let needsManualReview = false;
  for (const re of risky) {
    re.lastIndex = 0;
    const { text: p } = protectAllowlist(anonBody);
    re.lastIndex = 0;
    if (re.test(p)) {
      needsManualReview = true;
      break;
    }
  }
  // Person-name quarantine: only if it looks like a real name context
  // (e.g. "CEO [PERSON]" already handled; raw surviving names + contact
  // words like "contact", "owner", "founder" nearby).
  if (!needsManualReview) {
    PERSON_NAME.lastIndex = 0;
    const m = anonBody.match(PERSON_NAME);
    if (m && /(contact|owner|founder|ceo|client|account|manager)\b/i.test(anonBody)) {
      needsManualReview = true;
    }
  }
  // Density quarantine: a candidate that is mostly placeholders is either a
  // PII-dense source (partial-scrub risk) or has no pattern value left —
  // refuse and let a human look at the source learning.
  if (!needsManualReview) {
    const placeholders = anonBody.match(/\[(?:EMAIL|URL|DOMAIN|PHONE|SPEND|ADDRESS|CLIENT|PERSON)\]/g) ?? [];
    if (placeholders.length >= 5) {
      needsManualReview = true;
    }
  }

  return {
    title: anonTitle,
    body: anonBody,
    removedKinds: [...removedKinds],
    needsManualReview,
  };
}

/**
 * Propose a playbook pattern from a learning. Returns the row payload to
 * insert (unreviewed) or null when quarantined. The human review gate
 * (reviewPlaybookPattern) is the only path to publication.
 */
export function proposePlaybookPattern(input: {
  patternTitle: string;
  patternBody: string;
  supportingClientCount?: number;
}): { title: string; body: string; supportingClientCount: number } | null {
  const r = anonymizeForPlaybook(input.patternTitle, input.patternBody);
  if (r.needsManualReview) return null;
  return {
    title: r.title,
    body: r.body,
    supportingClientCount: input.supportingClientCount ?? 1,
  };
}
