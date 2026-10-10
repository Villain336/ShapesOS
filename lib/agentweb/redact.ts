// ShapesOS — Phase 21A (WS=agentweb): credential redaction and output hygiene (PURE).
//
// Password and card values are never given to a model and never logged. The
// primary guarantee is structural (a model cannot type into a credential
// field at all: classify.ts). This is the belt over those braces: whatever
// text is about to be logged or sent to a model passes through Redactor, and
// whatever a model writes passes through sanitizeModelOutput before a person
// sees it, so an image or link cannot carry data out.

import { checkFlow, type TaintLedger } from "./taint";

const FIELD_NAMES = "password|passwd|pwd|passcode|pin|cvv|cvc|card[_-]?number|cc[_-]?number|cardnumber|security[_-]?code|otp|one[_-]?time[_-]?code";

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export class Redactor {
  private readonly literals: string[];

  constructor(secrets: readonly string[] = []) {
    const out = new Set<string>();
    for (const s of secrets) {
      if (!s || s.length < 4) continue;
      const b = Buffer.from(s);
      for (const v of [s, encodeURIComponent(s), b.toString("base64"), b.toString("base64url"), b.toString("hex")]) out.add(v);
    }
    this.literals = [...out].sort((a, b) => b.length - a.length);
  }

  text(input: string): string {
    let s = input;
    for (const lit of this.literals) s = s.split(lit).join("[redacted]");
    // form-encoded and JSON fields by name
    s = s.replace(new RegExp(`((?:^|[?&;\\s"'])(?:${FIELD_NAMES})=)[^&\\s"']*`, "gi"), "$1[redacted]");
    s = s.replace(new RegExp(`("(?:${FIELD_NAMES})"\\s*:\\s*")[^"]*(")`, "gi"), "$1[redacted]$2");
    // card numbers: 13-19 digits, optional single spaces or dashes, Luhn-valid
    s = s.replace(/(?<![\d-])(\d(?:[ -]?\d){12,18})(?![\d-])/g, (m) => {
      const digits = m.replace(/[ -]/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? "[redacted]" : m;
    });
    return s;
  }

  /** The same shape, every string cleaned; values under credential-named keys are replaced outright. */
  deep<T>(value: T): T {
    const go = (v: unknown, key = ""): unknown => {
      if (typeof v === "string") return new RegExp(`^(?:${FIELD_NAMES})$`, "i").test(key) ? "[redacted]" : this.text(v);
      if (Array.isArray(v)) return v.map((x) => go(x));
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, go(x, k)]));
      return v;
    };
    return go(value) as T;
  }
}

export interface OutputPolicy {
  allowedOrigins: ReadonlySet<string>;
  ledger?: TaintLedger;
}

const originOfUrl = (u: string): string | null => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

/** Make a model's answer safe to render: no external images, frames or scripts, no secret in any address. */
export function sanitizeModelOutput(text: string, policy: OutputPolicy): string {
  let s = text;
  const carriesSecret = (url: string) => !!policy.ledger && checkFlow(policy.ledger, { name: "output", kind: "fetch" }, url).verdict === "refuse";
  const imageOk = (url: string) => {
    const o = originOfUrl(url);
    return !!o && policy.allowedOrigins.has(o) && !carriesSecret(url);
  };
  // active html
  s = s.replace(/<(iframe|object|embed|script|style|form)\b[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<\/?(iframe|object|embed|script|style|link|meta|form)\b[^>]*>/gi, "");
  s = s.replace(/<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)["']?[^>]*>/gi, (_m, url: string) => (imageOk(url) ? _m : "[image removed]"));
  // reference-style images: drop the image and every definition it used
  const refs = new Map<string, string>();
  s = s.replace(/^\s{0,3}\[([^\]]+)\]:\s*(\S+).*$/gm, (_m, id: string, url: string) => {
    refs.set(id.toLowerCase(), url);
    return "\u0000DEF\u0000";
  });
  s = s.replace(/!\[[^\]]*\]\[([^\]]*)\]/g, (_m, id: string) => {
    const url = refs.get(id.toLowerCase());
    return url && imageOk(url) ? `![](${url})` : "[image removed]";
  });
  // inline images
  s = s.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (m, _alt: string, url: string) => (imageOk(url) ? m : "[image removed]"));
  // inline links that carry a secret
  s = s.replace(/\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (m, label: string, url: string) => (carriesSecret(url) ? `${label} (link removed)` : m));
  // restore or drop the definitions (kept only if some non-image link still uses them)
  s = s.replace(/\n?\u0000DEF\u0000\n?/g, "");
  // bare addresses that carry a secret
  s = s.replace(/https?:\/\/[^\s)"'<>\]]+/g, (m) => (carriesSecret(m) ? "[address removed]" : m));
  return s.replace(/\n{3,}/g, "\n\n").trim();
}
