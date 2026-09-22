// Marketr — newsletter block model (milestone 19).
//
// The editable source of truth for every newsletter is Tiptap JSON, the same
// pattern as milestone 12 report templates. The doc's top-level nodes are
// email blocks; each maps to one react-email component at render time
// (see ./render.tsx). Plain-text JSON here stays dependency-free so fixture
// tests run without React.

/** Top-level block node types in a newsletter Tiptap doc. */
export type EmailBlockType =
  | "emailHeader"
  | "emailHero"
  | "emailText"
  | "emailImage"
  | "emailButton"
  | "emailDivider"
  | "emailFooter";

export const EMAIL_BLOCK_TYPES: EmailBlockType[] = [
  "emailHeader",
  "emailHero",
  "emailText",
  "emailImage",
  "emailButton",
  "emailDivider",
  "emailFooter",
];

export interface EmailBlockNode {
  type: EmailBlockType;
  attrs?: Record<string, unknown>;
  /** Inline Tiptap content (used by emailText). */
  content?: unknown[];
}

export interface EmailTiptapDoc {
  type: "doc";
  content: EmailBlockNode[];
}

/** Brand resolved from a milestone 12 BrandKit (colors/fonts JSON). */
export interface NewsletterBrand {
  colors: { primary: string; secondary: string; accent: string; text: string; muted: string };
  fonts: { heading: string; body: string };
  logoUrl?: string | null;
  companyName?: string | null;
}

export const DEFAULT_BRAND: NewsletterBrand = {
  colors: {
    primary: "#111827",
    secondary: "#374151",
    accent: "#4f46e5",
    text: "#111827",
    muted: "#6b7280",
  },
  fonts: { heading: "Georgia, 'Times New Roman', serif", body: "Arial, Helvetica, sans-serif" },
};

/** Map a BrandKit row (colors/fonts JSON) onto a NewsletterBrand. */
export function brandFromKit(kit: {
  colors?: unknown;
  fonts?: unknown;
  logoPath?: string | null;
  name?: string | null;
}): NewsletterBrand {
  const colors = (kit.colors ?? {}) as Record<string, string>;
  const fonts = (kit.fonts ?? {}) as Record<string, string>;
  return {
    colors: {
      primary: colors.primary || DEFAULT_BRAND.colors.primary,
      secondary: colors.secondary || DEFAULT_BRAND.colors.secondary,
      accent: colors.accent || DEFAULT_BRAND.colors.accent,
      text: colors.text || DEFAULT_BRAND.colors.text,
      muted: colors.muted || DEFAULT_BRAND.colors.muted,
    },
    fonts: {
      heading: fonts.heading || DEFAULT_BRAND.fonts.heading,
      body: fonts.body || DEFAULT_BRAND.fonts.body,
    },
    logoUrl: kit.logoPath ?? null,
    companyName: kit.name ?? null,
  };
}

/** Human label for the block palette. */
export function blockLabel(type: EmailBlockType): string {
  switch (type) {
    case "emailHeader": return "Header";
    case "emailHero": return "Hero";
    case "emailText": return "Text section";
    case "emailImage": return "Image";
    case "emailButton": return "CTA button";
    case "emailDivider": return "Divider";
    case "emailFooter": return "Footer";
  }
}

/** Blank block factory for the composer UI. */
export function createBlock(type: EmailBlockType): EmailBlockNode {
  switch (type) {
    case "emailHeader":
      return { type, attrs: { logoUrl: "", tagline: "" } };
    case "emailHero":
      return { type, attrs: { title: "Your headline here", subtitle: "", imageUrl: "" } };
    case "emailText":
      return {
        type,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Write your section…" }] }],
      };
    case "emailImage":
      return { type, attrs: { src: "", alt: "", caption: "" } };
    case "emailButton":
      return { type, attrs: { label: "Read more", href: "https://" } };
    case "emailDivider":
      return { type, attrs: {} };
    case "emailFooter":
      return { type, attrs: { companyName: "", address: "" } };
  }
}

/** Coerce unknown JSON into an EmailTiptapDoc (drops unknown node types). */
export function normalizeDoc(input: unknown): EmailTiptapDoc {
  if (!input || typeof input !== "object") return { type: "doc", content: [] };
  const raw = input as { content?: unknown[] };
  const content: EmailBlockNode[] = [];
  for (const node of raw.content ?? []) {
    if (!node || typeof node !== "object") continue;
    const n = node as { type?: unknown; attrs?: unknown; content?: unknown };
    if (typeof n.type !== "string" || !(EMAIL_BLOCK_TYPES as string[]).includes(n.type)) continue;
    content.push({
      type: n.type as EmailBlockType,
      attrs: n.attrs && typeof n.attrs === "object" ? (n.attrs as Record<string, unknown>) : {},
      content: Array.isArray(n.content) ? n.content : undefined,
    });
  }
  return { type: "doc", content };
}

/** Read a string attr safely. */
export function attr(node: EmailBlockNode, key: string, fallback = ""): string {
  const v = node.attrs?.[key];
  return typeof v === "string" ? v : fallback;
}

// ---------------------------------------------------------------------------
// Inline text: Tiptap paragraph/heading → renderable runs
// ---------------------------------------------------------------------------

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  href?: string;
}

export interface TextLine {
  kind: "paragraph" | "heading";
  runs: InlineRun[];
}

/** Flatten an emailText block's Tiptap content into styled runs. */
export function textLines(node: EmailBlockNode): TextLine[] {
  const out: TextLine[] = [];
  const content = Array.isArray(node.content) ? node.content : [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const el = raw as { type?: string; content?: unknown[] };
    if (el.type !== "paragraph" && el.type !== "heading") continue;
    const runs: InlineRun[] = [];
    for (const c of el.content ?? []) {
      if (!c || typeof c !== "object") continue;
      const t = c as { type?: string; text?: string; marks?: { type?: string; attrs?: { href?: string } }[] };
      if (t.type !== "text" || typeof t.text !== "string") continue;
      const marks = t.marks ?? [];
      const has = (m: string) => marks.some((mk) => mk.type === m);
      const link = marks.find((mk) => mk.type === "link");
      runs.push({
        text: t.text,
        bold: has("bold"),
        italic: has("italic"),
        underline: has("underline"),
        strike: has("strike"),
        href: link?.attrs?.href,
      });
    }
    out.push({ kind: el.type === "heading" ? "heading" : "paragraph", runs });
  }
  return out;
}

/** Word count across all text blocks (thin-content signal for guardrails). */
export function docWordCount(doc: EmailTiptapDoc): number {
  let words = 0;
  for (const node of doc.content) {
    if (node.type === "emailHero") {
      words += (attr(node, "title") + " " + attr(node, "subtitle")).trim().split(/\s+/).filter(Boolean).length;
    } else if (node.type === "emailText") {
      for (const line of textLines(node)) {
        for (const run of line.runs) words += run.text.trim().split(/\s+/).filter(Boolean).length;
      }
    }
  }
  return words;
}

// ---------------------------------------------------------------------------
// Unsubscribe enforcement — render-time, never UI-only
// ---------------------------------------------------------------------------

/**
 * The unsubscribe URL embedded in every send. The token is the subscriber's
 * per-recipient capability (public route, no auth).
 */
export function unsubscribeUrlFor(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/newsletter/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * True when the doc already carries an unsubscribe link (a footer block whose
 * attrs.unsubUrl is set, or any emailText/emailButton link pointing at an
 * unsubscribe path).
 */
export function docHasUnsubscribe(doc: EmailTiptapDoc): boolean {
  for (const node of doc.content) {
    if (node.type === "emailFooter") {
      const u = attr(node, "unsubUrl");
      if (u && /unsubscribe/i.test(u)) return true;
    }
    if (node.type === "emailButton") {
      if (/unsubscribe/i.test(attr(node, "href"))) return true;
    }
    if (node.type === "emailText") {
      for (const line of textLines(node)) {
        for (const run of line.runs) {
          if (run.href && /unsubscribe/i.test(run.href)) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Return a copy of the doc guaranteed to contain an unsubscribe link:
 * if the doc lacks one, append a footer block carrying the URL. The renderer
 * calls this on every send, so a template can never go out without one.
 */
export function ensureUnsubscribe(doc: EmailTiptapDoc, unsubscribeUrl: string): EmailTiptapDoc {
  if (docHasUnsubscribe(doc)) return doc;
  const footer: EmailBlockNode = {
    type: "emailFooter",
    attrs: { companyName: "", address: "", unsubUrl: unsubscribeUrl, autoUnsub: true },
  };
  return { type: "doc", content: [...doc.content, footer] };
}

// ---------------------------------------------------------------------------
// Subscriber CSV import
// ---------------------------------------------------------------------------

/** Hard cap on rows per subscriber import (abuse + cost control). */
export const SUBSCRIBER_CSV_CAP = 10_000;

export interface ParsedSubscriberRow {
  email: string;
  name: string | null;
  /** Row number in the source CSV (1-based, header = 1). */
  row: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim().toLowerCase());
}

/**
 * Parse subscriber CSV rows. Expects a header with `email` and optional
 * `name` columns (case-insensitive). Returns valid rows plus per-row errors.
 * Enforces the 10k cap.
 */
export function parseSubscriberCsv(
  rows: { row: number; values: Record<string, string> }[],
): { valid: ParsedSubscriberRow[]; errors: { row: number; message: string }[] } {
  const valid: ParsedSubscriberRow[] = [];
  const errors: { row: number; message: string }[] = [];
  for (const { row, values } of rows) {
    if (valid.length + errors.length >= SUBSCRIBER_CSV_CAP) {
      errors.push({ row, message: `Import capped at ${SUBSCRIBER_CSV_CAP.toLocaleString()} rows.` });
      break;
    }
    const email = (values.email ?? "").trim().toLowerCase();
    if (!email) {
      errors.push({ row, message: "Missing email." });
      continue;
    }
    if (!isValidEmail(email)) {
      errors.push({ row, message: `Invalid email: ${email}` });
      continue;
    }
    if (valid.some((v) => v.email === email)) {
      errors.push({ row, message: `Duplicate email in file: ${email}` });
      continue;
    }
    valid.push({ email, name: (values.name ?? "").trim() || null, row });
  }
  return { valid, errors };
}

/** Map raw CSV header names to the canonical `email`/`name` columns. */
export function mapSubscriberColumns(headers: string[]): Record<string, string> | null {
  const norm = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const lower = headers.map(norm);
  const emailIdx = lower.findIndex((h) => ["email", "emailaddress"].includes(h));
  if (emailIdx === -1) return null;
  const nameIdx = lower.findIndex((h) =>
    ["name", "fullname", "firstname", "contactname"].includes(h),
  );
  const mapping: Record<string, string> = { email: headers[emailIdx] };
  if (nameIdx !== -1) mapping.name = headers[nameIdx];
  return mapping;
}

// ---------------------------------------------------------------------------
// Broadcast guardrails — enforced server-side before any send
// ---------------------------------------------------------------------------

export interface GuardrailInput {
  domainStatus: string;
  testSentAt: Date | string | null;
  subscriberCount: number;
  doc: EmailTiptapDoc;
  unsubscribeUrl: string;
}

export interface GuardrailResult {
  ok: boolean;
  failures: string[];
}

/**
 * No broadcast without: a verified sending domain, a completed test send,
 * at least one subscribed recipient, and an unsubscribe link (checked after
 * the render-time ensureUnsubscribe, so this is a belt-and-suspenders gate).
 */
export function checkBroadcastGuardrails(input: GuardrailInput): GuardrailResult {
  const failures: string[] = [];
  if (input.domainStatus !== "verified") {
    failures.push("Sending domain is not verified — complete the SPF/DKIM/DMARC setup first.");
  }
  if (!input.testSentAt) {
    failures.push("No test send has completed for this broadcast — send a test to yourself first.");
  }
  if (input.subscriberCount < 1) {
    failures.push("The list has no subscribed recipients.");
  }
  const withUnsub = ensureUnsubscribe(input.doc, input.unsubscribeUrl);
  if (!docHasUnsubscribe(withUnsub)) {
    failures.push("Unsubscribe link is missing and could not be injected.");
  }
  return { ok: failures.length === 0, failures };
}
