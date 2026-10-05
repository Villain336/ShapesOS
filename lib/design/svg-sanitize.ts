// ShapesOS — strict allowlist sanitizer for SVG fragments (H1).
//
// Design documents store an svg element's inner markup (`body`, from Iconify
// or anything an editor PUTs). It is inlined into exported SVG and was
// rendered as HTML on the public share page, so it is untrusted markup.
// The previous regex denylist could be bypassed; this is an ALLOWLIST
// re-serializer:
//
//   - the input is tokenized; only allowlisted SVG elements and attributes
//     survive, re-emitted with canonical names and freshly escaped values,
//     so nothing the parser didn't understand reaches the output;
//   - a non-allowlisted element is dropped WITH its whole subtree (script,
//     style, foreignObject, image, a, animate/set, filters, iframe, ...);
//   - comments, CDATA, doctypes and processing instructions are dropped;
//   - href / xlink:href may only be internal fragment refs (#id); url(...)
//     in presentation attributes may only reference #id; xmlns values are
//     pinned to the SVG/XLink namespaces;
//   - entities in values are decoded BEFORE checks (so "&#106;avascript:"
//     can't slip through) and re-escaped on output; text is escaped too,
//     so "</svg><img onerror=...>" in text stays text.
//
// Pure and dependency-free: it runs at validate time (write path) and again
// at render time (export-svg), so stored legacy bodies are cleaned on read.

const ELEMENTS = [
  "svg", "g", "defs", "symbol", "use", "title", "desc",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textPath",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "marker",
];

const ATTRIBUTES = [
  "id", "class", "d", "transform", "opacity", "visibility", "display", "color",
  "fill", "fill-opacity", "fill-rule", "clip-rule",
  "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit",
  "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "paint-order",
  "vector-effect", "shape-rendering", "text-rendering", "overflow",
  "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "dx", "dy",
  "fx", "fy", "fr", "width", "height", "points", "pathLength",
  "viewBox", "preserveAspectRatio", "version",
  "offset", "stop-color", "stop-opacity",
  "gradientUnits", "gradientTransform", "spreadMethod",
  "clip-path", "clipPathUnits", "mask", "maskUnits", "maskContentUnits",
  "patternUnits", "patternContentUnits", "patternTransform",
  "marker-start", "marker-mid", "marker-end", "markerWidth", "markerHeight",
  "markerUnits", "refX", "refY", "orient",
  "font-family", "font-size", "font-weight", "font-style", "text-anchor",
  "dominant-baseline", "alignment-baseline", "letter-spacing", "word-spacing",
  "text-decoration", "rotate", "startOffset", "lengthAdjust", "textLength",
  "href", "xlink:href", "xmlns", "xmlns:xlink",
  "role", "aria-hidden", "aria-label", "focusable",
];

const ELEMENT_MAP = new Map(ELEMENTS.map((e) => [e.toLowerCase(), e]));
const ATTRIBUTE_MAP = new Map(ATTRIBUTES.map((a) => [a.toLowerCase(), a]));

/** HTML void elements: dropped without opening a subtree (no end tag comes). */
const HTML_VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "keygen",
  "link", "meta", "param", "source", "track", "wbr",
]);

const NAMESPACE_VALUES: Record<string, string> = {
  xmlns: "http://www.w3.org/2000/svg",
  "xmlns:xlink": "http://www.w3.org/1999/xlink",
};

const FRAGMENT_REF = /^#[A-Za-z_][\w.:-]*$/;
const URL_FUNC = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;

const START_TAG =
  /<([A-Za-z][\w:.-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const END_TAG = /<\/\s*([A-Za-z][\w:.-]*)\s*>/y;
// Names and unquoted values exclude "<", so a failed tag match stops at the
// next "<" (keeps tokenizing linear on adversarial input).
const ATTR = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the XML/HTML character references that can appear in a value. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "�";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? m;
  });
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}

/** Strip control chars/whitespace a browser would ignore inside a URL. */
function compactValue(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000- \u007f-\u009f]+/g, "");
}

/** Returns the sanitized value, or null when the attribute must be dropped. */
function sanitizeAttrValue(name: string, raw: string): string | null {
  const value = decodeEntities(raw);
  if (name === "href" || name === "xlink:href") {
    const v = compactValue(value);
    return FRAGMENT_REF.test(v) ? v : null;
  }
  if (name in NAMESPACE_VALUES) {
    return value.trim() === NAMESPACE_VALUES[name] ? NAMESPACE_VALUES[name] : null;
  }
  const compact = compactValue(value).toLowerCase();
  if (compact.includes("javascript:") || compact.includes("expression(")) return null;
  if (/url\(/i.test(value)) {
    // Every url(...) must be an internal fragment ref.
    for (const m of value.matchAll(URL_FUNC)) {
      const target = compactValue(m[1] ?? m[2] ?? m[3] ?? "");
      if (!FRAGMENT_REF.test(target)) return null;
    }
    // A url( that the pattern above didn't fully parse is refused too.
    const opened = (value.match(/url\(/gi) ?? []).length;
    const parsed = [...value.matchAll(URL_FUNC)].length;
    if (opened !== parsed) return null;
  }
  return value;
}

function serializeAttrs(attrSource: string): string {
  let out = "";
  const seen = new Set<string>();
  ATTR.lastIndex = 0;
  for (;;) {
    const start = ATTR.lastIndex;
    const m = ATTR.exec(attrSource);
    if (!m || m.index !== start) break;
    const canonical = ATTRIBUTE_MAP.get(m[1].toLowerCase());
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    const raw = m[2] ?? m[3] ?? m[4];
    if (raw === undefined) continue; // bare boolean attributes are never needed
    const value = sanitizeAttrValue(canonical, raw);
    if (value === null) continue;
    out += ` ${canonical}="${escapeAttr(value)}"`;
  }
  return out;
}

/**
 * Sanitize an SVG fragment (the inner body of an <svg>) against the
 * allowlist above. Never throws; returns "" for non-string input.
 */
export function sanitizeSvgFragment(dirty: unknown): string {
  if (typeof dirty !== "string" || dirty.length === 0) return "";
  const s = dirty;
  const out: string[] = [];
  const stack: Array<{ name: string; keep: boolean }> = [];
  let dropDepth = 0;
  let i = 0;

  const skipTo = (marker: string, from: number) => {
    const at = s.indexOf(marker, from);
    return at === -1 ? s.length : at + marker.length;
  };

  while (i < s.length) {
    const lt = s.indexOf("<", i);
    const textEnd = lt === -1 ? s.length : lt;
    if (textEnd > i) {
      if (dropDepth === 0) out.push(escapeText(decodeEntities(s.slice(i, textEnd))));
      i = textEnd;
      continue;
    }
    // s[i] === "<"
    if (s.startsWith("<!--", i)) {
      i = skipTo("-->", i + 4);
      continue;
    }
    if (s.startsWith("<![CDATA[", i)) {
      i = skipTo("]]>", i + 9);
      continue;
    }
    if (s.startsWith("<!", i) || s.startsWith("<?", i)) {
      i = skipTo(">", i + 2);
      continue;
    }
    END_TAG.lastIndex = i;
    const end = END_TAG.exec(s);
    if (end) {
      i = END_TAG.lastIndex;
      const lname = end[1].toLowerCase();
      let idx = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name.toLowerCase() === lname) {
          idx = k;
          break;
        }
      }
      if (idx === -1) continue; // stray end tag: ignore
      while (stack.length > idx) {
        const top = stack.pop()!;
        if (top.keep) out.push(`</${top.name}>`);
        else dropDepth--;
      }
      continue;
    }
    START_TAG.lastIndex = i;
    const start = START_TAG.exec(s);
    if (!start) {
      // Not a tag we can parse: it is text.
      if (dropDepth === 0) out.push("&lt;");
      i += 1;
      continue;
    }
    i = START_TAG.lastIndex;
    const selfClosing = start[3] === "/";
    const canonical = ELEMENT_MAP.get(start[1].toLowerCase());
    const keep = dropDepth === 0 && canonical !== undefined;
    if (keep) {
      out.push(`<${canonical}${serializeAttrs(start[2])}${selfClosing ? "/>" : ">"}`);
      if (!selfClosing) stack.push({ name: canonical!, keep: true });
    } else if (!selfClosing && !HTML_VOID.has(start[1].toLowerCase())) {
      stack.push({ name: start[1], keep: false });
      dropDepth++;
    }
  }
  // Close anything left open so the fragment can't swallow following markup.
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (top.keep) out.push(`</${top.name}>`);
  }
  return out.join("").trim();
}
