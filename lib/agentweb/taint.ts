// ShapesOS — Phase 21A (WS=agentweb): taint tracking (PURE).
//
// Every value taken from a page is registered with where it came from. A tool
// call whose arguments carry such a value into a sensitive sink (send, post,
// pay, delete, a file write, a request to another origin, typing into a page)
// does not run without a person's confirmation on a card that shows the value
// and its source. A SECRET (a credential, an API token) never flows to an
// outward sink at all.
//
// This is best effort on a model that can paraphrase: matching finds the value
// itself (case, spacing, zero-width and encoding changes folded), emails, URLs
// and phone numbers lifted out of page text, and long verbatim runs. What it
// does not find is an idea restated in new words. That is why it is the second
// line: Tier 2 and Tier 3 steps ask regardless, and origins are fenced.

import { foldLabel } from "./fold";
import type { TaintHit, ToolEffect, Trust } from "./types";

export interface Sink {
  name: string;
  kind: ToolEffect | "navigate" | "type";
  /** A navigation that stays on an origin the task already allows. */
  sameOrigin?: boolean;
}

export interface FlowResult {
  verdict: "allow" | "confirm" | "refuse";
  hits: TaintHit[];
}

const MIN_ATOM = 6;
const SHINGLE = 24;
const MAX_ARG_CHARS = 50_000;
const SECRET_MIN = 8;
const OUTWARD: ReadonlySet<Sink["kind"]> = new Set(["send", "post", "file_write", "delete", "money", "fetch", "navigate", "type"]);

interface Entry {
  canon: string;
  display: string;
  origin: string;
  trust: Trust;
}

const alnum = (s: string) => foldLabel(s).replace(/[^a-z0-9]/g, "");

function atomsOf(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) out.add(m[0]);
  for (const m of text.matchAll(/https?:\/\/[^\s)"'<>]+/g)) out.add(m[0].replace(/[.,;]+$/, ""));
  for (const m of text.matchAll(/\+?\d[\d\s().-]{6,}\d/g)) out.add(m[0]);
  return [...out];
}

export class TaintLedger {
  private entries: Entry[] = [];
  private shingles = new Map<string, Entry>();
  private secrets: { raw: string; variants: string[]; alnum: string }[] = [];
  private chars = 0;
  private readonly maxChars: number;

  constructor(opts: { maxChars?: number } = {}) {
    this.maxChars = opts.maxChars ?? 200_000;
  }

  size(): number {
    return this.chars;
  }

  /** Register a value read from somewhere. Trusted values are not tracked. */
  register(value: string, origin: string, trust: Trust = "untrusted"): void {
    if (trust === "trusted" || !value) return;
    const text = value.slice(0, 20_000);
    const push = (display: string, canonSrc: string) => {
      const canon = foldLabel(canonSrc);
      if (canon.length < MIN_ATOM) return;
      this.entries.push({ canon, display: display.slice(0, 60), origin, trust });
      this.chars += canon.length;
    };
    if (text.length <= 200) push(text, text);
    for (const a of atomsOf(text)) push(a, a);
    const canon = foldLabel(text);
    if (canon.length >= SHINGLE) {
      const e: Entry = { canon: "", display: text.slice(0, 60), origin, trust };
      for (let i = 0; i + SHINGLE <= canon.length && i < 6000; i++) this.shingles.set(canon.slice(i, i + SHINGLE), e);
    }
    // Keep memory bounded: drop the oldest registrations first.
    while (this.chars > this.maxChars && this.entries.length) this.chars -= this.entries.shift()!.canon.length;
    if (this.shingles.size > 50_000) for (const k of [...this.shingles.keys()].slice(0, 10_000)) this.shingles.delete(k);
  }

  /** A credential or token: it must not reach any outward sink. */
  registerSecret(value: string): void {
    if (value.length < SECRET_MIN) return;
    const b = Buffer.from(value);
    this.secrets.push({ raw: value, variants: [value, encodeURIComponent(value), b.toString("base64"), b.toString("base64url"), b.toString("hex")].filter((v) => v.length >= SECRET_MIN), alnum: alnum(value) });
  }

  /** Every registered value found in the arguments. */
  scan(args: unknown): TaintHit[] {
    const hits: TaintHit[] = [];
    const walk = (v: unknown, path: string) => {
      if (typeof v === "string") {
        this.scanString(v.slice(0, MAX_ARG_CHARS), path, hits);
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => walk(x, path ? `${path}.${i}` : String(i)));
      } else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
      }
    };
    walk(args, "");
    return hits;
  }

  private scanString(s: string, path: string, hits: TaintHit[]): void {
    const canon = foldLabel(s);
    const flat = alnum(s);
    for (const sec of this.secrets) {
      if (sec.variants.some((v) => s.includes(v)) || (sec.alnum.length >= SECRET_MIN && flat.includes(sec.alnum))) {
        hits.push({ value: "[secret]", origin: "user", trust: "secret", arg: path });
      }
    }
    const seen = new Set<Entry>();
    // A short code or identifier copied out of a registered page value (a voucher code, an id).
    const excerpt = canon.length >= 8 && canon.length <= 200 && /\d/.test(canon);
    for (const e of this.entries) {
      if (!seen.has(e) && (canon.includes(e.canon) || (excerpt && e.canon.includes(canon)))) {
        seen.add(e);
        hits.push({ value: e.display, origin: e.origin, trust: e.trust, arg: path });
      }
    }
    if (canon.length >= SHINGLE && this.shingles.size) {
      for (let i = 0; i + SHINGLE <= canon.length; i++) {
        const e = this.shingles.get(canon.slice(i, i + SHINGLE));
        if (e && !seen.has(e)) {
          seen.add(e);
          hits.push({ value: e.display, origin: e.origin, trust: e.trust, arg: path });
        }
      }
    }
  }
}

/** May these arguments flow into this sink? */
export function checkFlow(ledger: TaintLedger, sink: Sink, args: unknown): FlowResult {
  if (!OUTWARD.has(sink.kind)) return { verdict: "allow", hits: [] };
  const hits = ledger.scan(args);
  if (hits.some((h) => h.trust === "secret")) return { verdict: "refuse", hits: hits.filter((h) => h.trust === "secret") };
  const untrusted = hits.filter((h) => h.trust === "untrusted");
  if (untrusted.length === 0) return { verdict: "allow", hits: [] };
  if (sink.kind === "navigate" && sink.sameOrigin) return { verdict: "allow", hits: [] };
  return { verdict: "confirm", hits: untrusted };
}
