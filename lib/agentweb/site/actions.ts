// ShapesOS — Phase 21A (WS=agentweb): schema.org potentialAction and declarative
// WebMCP form annotations for SiteBuilder pages (PURE).
//
// WebMCP, declarative API (Chrome WebMCP docs; the spec lives in
// webmachinelearning/webmcp): a <form> is a tool when it has `toolname` and
// `tooldescription`; fields may carry `toolparamdescription`; `toolautosubmit`
// lets the agent submit without the visitor. We never emit toolautosubmit: the
// visitor reviews and submits.
//
// Scope is deliberately narrow and safe. Only the three tasks a service site
// wants agents to start (contact, booking, quote) are annotated; login, payment,
// account and destructive forms are never touched, and the schema.org actions we
// emit are CommunicateAction / ReserveAction / QuoteAction, never a buy, order
// or pay action (storefront checkout is a later phase).

import type { JsonLd } from "@/lib/seo/jsonld";
import { foldLabel } from "../fold";

export type SiteTaskKind = "contact" | "booking" | "quote";

export interface FormField {
  name: string;
  type: string;
  label: string;
  required: boolean;
}
export interface FormInfo {
  kind: SiteTaskKind | null;
  action: string;
  method: "GET" | "POST";
  fields: FormField[];
  /** Already carries `toolname` (the owner's own annotation, or ours from a previous run). */
  annotated: boolean;
  /** The submit button's text. */
  button: string;
  /** Offsets of the whole <form>…</form> in the source. */
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Tiny, tolerant tag scanning (we rewrite the source in place, so no DOM round trip)
// ---------------------------------------------------------------------------

const ATTRS = `((?:[^>"']|"[^"]*"|'[^']*')*)`;
const FORM_RE = new RegExp(`<form\\b${ATTRS}>([\\s\\S]*?)<\\/form\\s*>`, "gi");
const FIELD_RE = new RegExp(`<(input|select|textarea)\\b${ATTRS}>`, "gi");
const LABEL_RE = /<label\b([^>]*)>([\s\S]*?)<\/label\s*>/gi;
const BUTTON_RE = new RegExp(`<button\\b${ATTRS}>([\\s\\S]*?)<\\/button\\s*>`, "gi");

function attrOf(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`, "i").exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : undefined;
}
const hasFlag = (attrs: string, name: string) => new RegExp(`(?:^|\\s)${name}(?=[\\s=/]|$)`, "i").test(attrs);

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const plain = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, " ")
    .trim();

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const humanize = (name: string) => {
  const s = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_[\]]+/g, " ").trim().toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : name;
};

const SKIP_TYPES = new Set(["hidden", "submit", "button", "reset", "image", "file", "password"]);

function fieldsOf(body: string): (FormField & { attrs: string; tag: string; index: number; length: number })[] {
  const labelsFor = new Map<string, string>();
  const wrapping: { start: number; end: number; text: string }[] = [];
  for (const m of body.matchAll(LABEL_RE)) {
    const target = attrOf(m[1], "for");
    if (target) labelsFor.set(target, plain(m[2]));
    else wrapping.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, text: plain(m[2]) });
  }
  const out: (FormField & { attrs: string; tag: string; index: number; length: number })[] = [];
  for (const m of body.matchAll(FIELD_RE)) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const type = (attrOf(attrs, "type") ?? (tag === "input" ? "text" : tag)).toLowerCase();
    const name = attrOf(attrs, "name");
    if (!name) continue;
    const id = attrOf(attrs, "id");
    const at = m.index ?? 0;
    const wrap = wrapping.find((w) => at >= w.start && at < w.end);
    const label = (id ? labelsFor.get(id) : undefined) || wrap?.text || attrOf(attrs, "aria-label") || attrOf(attrs, "placeholder") || humanize(name);
    out.push({ name, type, label, required: hasFlag(attrs, "required"), attrs, tag, index: at, length: m[0].length });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

// Anything about identity, payment or destruction is out, whatever else it looks like.
const NEVER = /\b(log ?in|sign ?in|sign ?up|register|password|passwd|checkout|payment|pay|card|billing|iban|cvv|cvc|delete|remove|cancel|unsubscribe|subscribe|newsletter|account|purchase|buy|order|donate|refund|transfer)\b/;
const QUOTE = /\b(quote|quotation|estimate)\b/;
const BOOKING = /\b(book|booking|reserve|reservation|appointment|schedule|consultation|table)\b/;
const CONTACT = /\b(contact|enquir\w*|inquir\w*|message|get in touch|callback|call back|send|support|question)\b/;

function classify(form: { action: string; fields: FormField[]; button: string }): SiteTaskKind | null {
  if (form.fields.some((f) => f.type === "password" || /(card|cvv|cvc|iban|passw|ssn)/i.test(f.name))) return null;
  const words = foldLabel(`${form.action} ${form.button} ${form.fields.map((f) => `${f.name} ${f.label}`).join(" ")}`).toLowerCase();
  const head = foldLabel(`${form.action} ${form.button}`).toLowerCase();
  if (NEVER.test(head)) return null;
  const emailish = form.fields.some((f) => f.type === "email" || /e-?mail/i.test(f.name));
  const textarea = form.fields.some((f) => f.type === "textarea" || /(message|details|comments?)/i.test(f.name));
  if (QUOTE.test(words) && (emailish || textarea || form.fields.length > 1)) return "quote";
  const dated = form.fields.some((f) => ["date", "datetime-local", "time"].includes(f.type));
  if (dated || BOOKING.test(head)) return dated || form.fields.length ? "booking" : null;
  if ((textarea && emailish) || (CONTACT.test(words) && (emailish || textarea))) return "contact";
  return null;
}

export function findForms(html: string): FormInfo[] {
  const out: FormInfo[] = [];
  for (const m of html.matchAll(FORM_RE)) {
    const attrs = m[1];
    const body = m[2];
    const fields = fieldsOf(body);
    // Payment-ish autocomplete hints are on the raw tags.
    const hinted = [...body.matchAll(FIELD_RE)].some((f) => /^cc-/i.test(attrOf(f[2], "autocomplete") ?? "") || /password/i.test(attrOf(f[2], "autocomplete") ?? ""));
    const buttons = [...body.matchAll(BUTTON_RE)].map((b) => plain(b[2]));
    const submits = [...body.matchAll(FIELD_RE)].filter((f) => /^(submit|button|image)$/i.test(attrOf(f[2], "type") ?? "")).map((f) => attrOf(f[2], "value") ?? "");
    const button = [...buttons, ...submits].filter(Boolean).join(" ");
    const action = attrOf(attrs, "action") ?? "";
    const base = { action, fields: fields.map(({ name, type, label, required }) => ({ name, type, label, required })), button };
    const kind = hinted ? null : classify(base);
    out.push({
      kind,
      action,
      method: (attrOf(attrs, "method") ?? "get").toUpperCase() === "POST" ? "POST" : "GET",
      fields: base.fields,
      annotated: attrOf(attrs, "toolname") !== undefined,
      button,
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Declarative WebMCP annotation
// ---------------------------------------------------------------------------

const TOOL_NAME: Record<SiteTaskKind, string> = { contact: "contact_us", booking: "request_booking", quote: "request_quote" };
const TOOL_TEXT = (kind: SiteTaskKind, site: string): string =>
  ({
    contact: `Send a message to ${site}. The visitor reviews and submits it.`,
    booking: `Request a booking with ${site}. The visitor reviews and submits it.`,
    quote: `Ask ${site} for a quote. The visitor reviews and submits it.`,
  })[kind];

const addAttrs = (attrs: string, extra: string): string => {
  const tail = /\s*\/?\s*$/.exec(attrs);
  const at = tail ? tail.index : attrs.length;
  return `${attrs.slice(0, at)}${extra}${attrs.slice(at)}`;
};

export interface AnnotateResult {
  html: string;
  annotated: number;
}

/**
 * Add `toolname` / `tooldescription` / `toolparamdescription` to contact,
 * booking and quote forms. Idempotent: a form that already has `toolname` is
 * left exactly as written. Never adds `toolautosubmit`.
 */
export function annotateForms(html: string, opts: { siteName: string }): AnnotateResult {
  const site = oneLine(opts.siteName) || "this site";
  const used = new Map<string, number>();
  // Names already taken on the page (ours or the owner's) so new ones stay unique.
  for (const m of html.matchAll(/\btoolname\s*=\s*"([^"]*)"/gi)) used.set(m[1], (used.get(m[1]) ?? 0) + 1);
  let annotated = 0;
  const out = html.replace(FORM_RE, (whole, attrs: string, body: string) => {
    const info = findForms(whole)[0];
    if (!info || info.annotated || !info.kind) return whole;
    const base = TOOL_NAME[info.kind];
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.set(name, 1);
    const newBody = body.replace(FIELD_RE, (tag, el: string, fAttrs: string) => {
      const type = (attrOf(fAttrs, "type") ?? (el.toLowerCase() === "input" ? "text" : el)).toLowerCase();
      const fname = attrOf(fAttrs, "name");
      if (!fname || SKIP_TYPES.has(type) || attrOf(fAttrs, "toolparamdescription") !== undefined) return tag;
      const field = info.fields.find((f) => f.name === fname);
      const description = field?.label || humanize(fname);
      return `<${el}${addAttrs(fAttrs, ` toolparamdescription="${escapeAttr(description)}"`)}>`;
    });
    annotated++;
    const open = `<form${addAttrs(attrs, ` toolname="${name}" tooldescription="${escapeAttr(TOOL_TEXT(info.kind, site))}"`)}>`;
    return `${open}${newBody}</form>`;
  });
  return { html: out, annotated };
}

// ---------------------------------------------------------------------------
// schema.org potentialAction
// ---------------------------------------------------------------------------

export interface SiteTask {
  kind: SiteTaskKind;
  /** Absolute http(s) URL the form submits to. */
  target: string;
  method: "GET" | "POST";
}

const ACTION_TYPE: Record<SiteTaskKind, string> = { contact: "CommunicateAction", booking: "ReserveAction", quote: "QuoteAction" };
const ACTION_NAME = (kind: SiteTaskKind, site: string): string =>
  ({ contact: `Contact ${site}`, booking: `Book with ${site}`, quote: `Ask ${site} for a quote` })[kind];

const isWeb = (u: string) => {
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
};

export function potentialActions(tasks: SiteTask[], siteName: string): JsonLd[] {
  const site = oneLine(siteName) || "this site";
  const seen = new Set<string>();
  const out: JsonLd[] = [];
  for (const t of tasks) {
    if (!isWeb(t.target)) continue;
    const key = `${t.kind}|${t.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      "@type": ACTION_TYPE[t.kind],
      name: ACTION_NAME(t.kind, site),
      target: { "@type": "EntryPoint", urlTemplate: t.target, httpMethod: t.method, contentType: "application/x-www-form-urlencoded" },
    });
  }
  return out;
}

const targetOf = (a: unknown): string => {
  const t = (a as { target?: unknown } | null)?.target;
  return typeof t === "string" ? t : String((t as { urlTemplate?: unknown; url?: unknown } | null)?.urlTemplate ?? (t as { url?: unknown } | null)?.url ?? "");
};

/** Merge actions into a block's potentialAction: same type + target replaces, others stay. Does not mutate. */
export function addPotentialActions(block: JsonLd, actions: JsonLd[]): JsonLd {
  const existing = ([] as JsonLd[]).concat((block.potentialAction as JsonLd | JsonLd[] | undefined) ?? []);
  const key = (a: JsonLd) => `${String(a["@type"])}|${targetOf(a)}`;
  const fresh = new Map(actions.map((a) => [key(a), a]));
  const kept = existing.filter((a) => !fresh.has(key(a)));
  const merged = [...kept, ...actions];
  return merged.length ? { ...block, potentialAction: merged } : block;
}
