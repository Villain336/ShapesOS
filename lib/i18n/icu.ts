// ShapesOS — Phase 18.1 (WS=find): a small ICU MessageFormat subset.
//
// No new dependency: the shell needs only
//   {name}                                  interpolation
//   {count, plural, =0 {…} one {# item} other {# items}}   CLDR plurals via
//                                           Intl.PluralRules, `#` = the
//                                           number formatted for the locale
//   {kind, select, file {…} doc {…} other {…}}             select
// Nested arguments inside branches work. A quote is plain text (no ICU
// apostrophe escaping — the catalogues never need a literal brace).
// Values are inserted as text; React escapes them, so a value can never
// inject markup. Pure and client-safe.

export type MessageValues = Record<string, string | number | null | undefined>;

type Node =
  | { t: "text"; v: string }
  | { t: "arg"; name: string }
  | { t: "pound" }
  | { t: "plural"; name: string; offset: number; branches: Record<string, Node[]> }
  | { t: "select"; name: string; branches: Record<string, Node[]> };

const cache = new Map<string, Node[]>();

export class IcuSyntaxError extends Error {}

function parse(src: string): Node[] {
  let i = 0;

  function parseNodes(inPlural: boolean, untilBrace: boolean): Node[] {
    const out: Node[] = [];
    let text = "";
    const flush = () => {
      if (text) out.push({ t: "text", v: text });
      text = "";
    };
    while (i < src.length) {
      const c = src[i]!;
      if (c === "}") {
        if (!untilBrace) throw new IcuSyntaxError(`Unexpected "}" at ${i} in "${src}"`);
        break;
      }
      if (c === "{") {
        flush();
        i++;
        out.push(parseArg());
        continue;
      }
      if (c === "#" && inPlural) {
        flush();
        out.push({ t: "pound" });
        i++;
        continue;
      }
      text += c;
      i++;
    }
    flush();
    return out;
  }

  function skipWs() {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  }

  function readIdent(): string {
    skipWs();
    const start = i;
    while (i < src.length && /[A-Za-z0-9_=.-]/.test(src[i]!)) i++;
    const id = src.slice(start, i);
    if (!id) throw new IcuSyntaxError(`Expected a name at ${i} in "${src}"`);
    skipWs();
    return id;
  }

  function parseArg(): Node {
    const name = readIdent();
    if (src[i] === "}") {
      i++;
      return { t: "arg", name };
    }
    if (src[i] !== ",") throw new IcuSyntaxError(`Expected "," or "}" after {${name} in "${src}"`);
    i++;
    const type = readIdent();
    if (type !== "plural" && type !== "select") throw new IcuSyntaxError(`Unsupported argument type "${type}" in "${src}"`);
    if (src[i] !== ",") throw new IcuSyntaxError(`Expected "," after ${type} in "${src}"`);
    i++;
    let offset = 0;
    const branches: Record<string, Node[]> = {};
    skipWs();
    if (type === "plural" && src.startsWith("offset:", i)) {
      i += "offset:".length;
      const m = /^\s*(\d+)/.exec(src.slice(i));
      if (!m) throw new IcuSyntaxError(`Bad offset in "${src}"`);
      offset = Number(m[1]);
      i += m[0].length;
    }
    for (;;) {
      skipWs();
      if (src[i] === "}") {
        i++;
        break;
      }
      const key = readIdent();
      if (src[i] !== "{") throw new IcuSyntaxError(`Expected "{" after branch "${key}" in "${src}"`);
      i++;
      branches[key] = parseNodes(type === "plural", true);
      if (src[i] !== "}") throw new IcuSyntaxError(`Unclosed branch "${key}" in "${src}"`);
      i++;
    }
    if (!branches.other) throw new IcuSyntaxError(`{${name}, ${type}} needs an "other" branch in "${src}"`);
    return type === "plural" ? { t: "plural", name, offset, branches } : { t: "select", name, branches };
  }

  const nodes = parseNodes(false, false);
  if (i < src.length) throw new IcuSyntaxError(`Unexpected "}" at ${i} in "${src}"`);
  return nodes;
}

export function parseIcu(src: string): Node[] {
  let nodes = cache.get(src);
  if (!nodes) {
    nodes = parse(src);
    if (cache.size > 2000) cache.clear();
    cache.set(src, nodes);
  }
  return nodes;
}

/** The argument names a message uses (for catalogue parity tests). */
export function icuArgumentNames(src: string): string[] {
  const names = new Set<string>();
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.t === "arg") names.add(n.name);
      else if (n.t === "plural" || n.t === "select") {
        names.add(n.name);
        for (const b of Object.values(n.branches)) walk(b);
      }
    }
  };
  walk(parseIcu(src));
  return [...names].sort();
}

const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();

function rules(locale: string): Intl.PluralRules {
  let r = pluralRules.get(locale);
  if (!r) pluralRules.set(locale, (r = new Intl.PluralRules(locale)));
  return r;
}

function numFmt(locale: string): Intl.NumberFormat {
  let f = numberFormats.get(locale);
  if (!f) numberFormats.set(locale, (f = new Intl.NumberFormat(locale)));
  return f;
}

/** Format an ICU-subset message. Missing values render as empty text. */
export function formatIcu(src: string, values: MessageValues = {}, locale = "en"): string {
  const render = (nodes: Node[], pound: number | null): string => {
    let out = "";
    for (const n of nodes) {
      switch (n.t) {
        case "text":
          out += n.v;
          break;
        case "pound":
          out += pound === null ? "#" : numFmt(locale).format(pound);
          break;
        case "arg": {
          const v = values[n.name];
          out += v === null || v === undefined ? "" : typeof v === "number" ? numFmt(locale).format(v) : v;
          break;
        }
        case "plural": {
          const raw = Number(values[n.name] ?? 0);
          const num = Number.isFinite(raw) ? raw : 0;
          const exact = n.branches[`=${num}`];
          const branch = exact ?? n.branches[rules(locale).select(num - n.offset)] ?? n.branches.other!;
          out += render(branch, num - n.offset);
          break;
        }
        case "select": {
          const key = String(values[n.name] ?? "other");
          out += render(n.branches[key] ?? n.branches.other!, pound);
          break;
        }
      }
    }
    return out;
  };
  return render(parseIcu(src), null);
}
