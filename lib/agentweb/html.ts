// ShapesOS — Phase 21A (WS=agentweb): a small tolerant HTML reader (PURE).
//
// Channel detection, the page classifier and the reader's input all need to
// look inside a page without a browser, and the repo has no HTML parser
// dependency (and none may be added in this phase). This is a tokenizer that
// builds a tree: it never throws, keeps <script>/<style> bodies raw, decodes
// the common entities and survives unclosed or stray tags. It is NOT a
// spec-compliant parser — it reads what pages declare, it does not render them.

export interface HtmlNode {
  type: "element" | "text" | "comment";
  tag?: string;
  attrs?: Record<string, string>;
  children: HtmlNode[];
  text?: string;
  parent?: HtmlNode;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const AUTO_CLOSE: Record<string, string[]> = { li: ["li"], option: ["option"], p: ["p"], tr: ["tr"], td: ["td", "th"], th: ["td", "th"], dt: ["dt", "dd"], dd: ["dt", "dd"] };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1]!.toLowerCase();
    if (name in attrs) continue; // first one wins, like browsers
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { type: "element", tag: "#root", attrs: {}, children: [] };
  let cur = root;
  const push = (n: HtmlNode) => {
    n.parent = cur;
    cur.children.push(n);
  };
  const re = /<!--([\s\S]*?)(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][^\s>/]*)[^>]*>|<([a-zA-Z][^\s>/]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const text = (s: string) => {
    if (s) push({ type: "text", text: decodeEntities(s), children: [] });
  };
  while ((m = re.exec(html))) {
    text(html.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] !== undefined) {
      push({ type: "comment", text: m[1], children: [] });
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      let n: HtmlNode | undefined = cur;
      while (n && n !== root && n.tag !== tag) n = n.parent;
      if (n && n !== root) cur = n.parent ?? root; // stray end tags are ignored
    } else if (m[3]) {
      const tag = m[3].toLowerCase();
      const closers = AUTO_CLOSE[tag];
      if (closers && cur.tag && closers.includes(cur.tag)) cur = cur.parent ?? root;
      const el: HtmlNode = { type: "element", tag, attrs: parseAttrs(m[4] ?? ""), children: [] };
      push(el);
      const selfClosed = /\/\s*$/.test(m[4] ?? "");
      if (VOID.has(tag) || selfClosed) continue;
      if (RAW.has(tag)) {
        const close = new RegExp(`</${tag}\\s*>`, "i");
        const rest = html.slice(last);
        const c = close.exec(rest);
        const body = c ? rest.slice(0, c.index) : rest;
        if (body) el.children.push({ type: "text", text: tag === "title" || tag === "textarea" ? decodeEntities(body) : body, children: [], parent: el });
        last += c ? c.index + c[0].length : rest.length;
        re.lastIndex = last;
        continue;
      }
      cur = el;
    }
  }
  text(html.slice(last));
  return root;
}

export function walk(node: HtmlNode, fn: (n: HtmlNode) => void): void {
  fn(node);
  for (const c of node.children) walk(c, fn);
}

export function findAll(node: HtmlNode, pred: (n: HtmlNode) => boolean): HtmlNode[] {
  const out: HtmlNode[] = [];
  walk(node, (n) => {
    if (pred(n)) out.push(n);
  });
  return out;
}

export function attr(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.[name];
}

/** All text under a node (including script bodies), whitespace untouched. */
export function textOf(node: HtmlNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "comment") return "";
  return node.children.map(textOf).join("");
}

/** Does the element's own markup hide it from a person looking at the page? */
export function isHiddenElement(n: HtmlNode): boolean {
  const a = n.attrs ?? {};
  if ("hidden" in a || a["aria-hidden"] === "true") return true;
  if (n.tag === "input" && (a.type ?? "").toLowerCase() === "hidden") return true;
  const style = (a.style ?? "").toLowerCase().replace(/\s+/g, "");
  if (!style) return false;
  return (
    /display:none/.test(style) ||
    /visibility:hidden/.test(style) ||
    /opacity:0(?![.\d])/.test(style) ||
    /font-size:0(px|em|rem|pt|%)?(;|$)/.test(style) ||
    /(left|top|text-indent):-\d{3,}/.test(style) ||
    /(width|height):0(px)?(;|$).*overflow:hidden|overflow:hidden.*(width|height):0(px)?(;|$)/.test(style)
  );
}

const NON_TEXT = new Set(["script", "style", "head", "noscript", "template", "svg", "title"]);

/** The text a person sees: hidden, script, style and comment content left out. */
export function visibleText(node: HtmlNode): string {
  const parts: string[] = [];
  const go = (n: HtmlNode) => {
    if (n.type === "text") {
      parts.push(n.text ?? "");
      return;
    }
    if (n.type !== "element") return;
    if (n.tag && NON_TEXT.has(n.tag)) return;
    if (isHiddenElement(n)) return;
    const block = /^(p|div|li|tr|h[1-6]|section|article|br|ul|ol|table|form|header|footer|main|nav)$/.test(n.tag ?? "");
    if (block) parts.push("\n");
    n.children.forEach(go);
    if (block) parts.push("\n");
  };
  go(node);
  return parts.join("").replace(/[ \t\f\v ]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{2,}/g, "\n").trim();
}
