// ShapesOS — static accessibility checks over TSX source (TypeScript AST).
//
// Used by lib/a11y/__tests__/a11y-scan.test.ts as a regression guard over
// app/ and components/. Three rules, matching FULL-AUDIT-2026-10-03 §7:
//
//   clickable-non-interactive  a div/span/li/tr/td/… with onClick must be a
//                              real <button>/<a>, or carry a role + tabIndex +
//                              a key handler (tr keeps its row role). Purely
//                              decorative mouse targets (backdrops) are marked
//                              aria-hidden; onClick that only stops
//                              propagation isn't an action.
//   img-alt                    <img> / next/image needs alt ("" when decorative).
//   outline-none               removing the outline needs a visible focus
//                              replacement in the same className, or
//                              data-focus-ring="container" when a wrapper
//                              draws it with focus-within.
//   icon-button-name           (Phase 18.1) a <button> / <a> / <Link> whose
//                              only content is an icon needs an accessible
//                              name: aria-label, aria-labelledby or title
//                              (or visible / sr-only text inside).
//   positive-tabindex          (Phase 18.1) tabIndex > 0 breaks the natural
//                              tab order; use 0 or -1.
//
// Dev-only tooling: never imported by app code.

import ts from "typescript";

export type A11yRule = "clickable-non-interactive" | "img-alt" | "outline-none" | "icon-button-name" | "positive-tabindex";

export interface A11yFinding {
  rule: A11yRule;
  line: number;
  tag: string;
  snippet: string;
}

const NON_INTERACTIVE = new Set([
  "div",
  "span",
  "li",
  "ul",
  "ol",
  "tr",
  "td",
  "th",
  "p",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "main",
  "nav",
  "img",
  "svg",
  "i",
  "strong",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "figure",
  "dl",
  "dt",
  "dd",
]);

/** Classes that give an element a visible focus indicator. */
const FOCUS_REPLACEMENT =
  /(?:^|[\s"'`])(?:[\w-]+:)*(?:focus|focus-visible|focus-within|group-focus-within|group-focus-visible|has-\[:focus-visible\]):(?:ring|outline-(?!none)|border|shadow|bg-|underline)/;
const OUTLINE_NONE = /(?:^|[\s"'`])(?:[\w-]+:)*outline-none(?=$|[\s"'`])/;
const STOP_PROPAGATION_ONLY = /^\(?\s*\w*\s*(?::\s*[\w.<>]+)?\)?\s*=>\s*\{?\s*\w+\.stopPropagation\(\)\s*;?\s*\}?$/;

function attrs(node: ts.JsxOpeningLikeElement): Map<string, ts.JsxAttribute> {
  const out = new Map<string, ts.JsxAttribute>();
  for (const p of node.attributes.properties) {
    if (ts.isJsxAttribute(p)) out.set(p.name.getText(), p);
  }
  return out;
}

function hasSpread(node: ts.JsxOpeningLikeElement): boolean {
  return node.attributes.properties.some((p) => ts.isJsxSpreadAttribute(p));
}

function initText(a: ts.JsxAttribute | undefined): string {
  if (!a?.initializer) return "";
  return a.initializer.getText();
}

function isTruthyAttr(a: ts.JsxAttribute | undefined): boolean {
  if (!a) return false;
  if (!a.initializer) return true; // <div aria-hidden>
  const t = initText(a).replace(/^\{|\}$/g, "").trim();
  return t !== "false" && t !== '"false"';
}

/** Elements that render an icon and no text (Lucide components, svg). */
function isIconElement(el: ts.JsxChild, sf: ts.SourceFile): boolean {
  if (ts.isJsxSelfClosingElement(el)) {
    const tag = el.tagName.getText(sf);
    if (tag === "svg" || tag === "img") return true;
    // A capitalized component with an icon-ish name or used as one (className size-*/h-* only).
    if (/^[A-Z]/.test(tag)) {
      const a = attrs(el);
      // Components that carry their own label/text props are not "just an icon".
      if (a.has("label") || a.has("aria-label") || a.has("title") || a.has("children") || a.has("name") || a.has("text")) return false;
      return /(Icon|^[A-Z][a-zA-Z0-9]*)$/.test(tag) && !/(Badge|Avatar|Label|Text|Title|Pill|Chip|KeyCap|Count|Tooltip|Shape)/.test(tag);
    }
    return false;
  }
  if (ts.isJsxElement(el)) {
    const tag = el.openingElement.tagName.getText(sf);
    if (tag === "svg") return true;
    return false;
  }
  return false;
}

/** True when the children are only icons (whitespace text ignored, no expressions). */
function onlyIcons(children: ts.NodeArray<ts.JsxChild>, sf: ts.SourceFile): boolean {
  let icons = 0;
  for (const c of children) {
    if (ts.isJsxText(c)) {
      if (c.getText(sf).trim()) return false;
      continue;
    }
    if (ts.isJsxExpression(c)) {
      // {cond ? <A/> : <B/>} of icons only still counts; any other expression may be text.
      const e = c.expression;
      if (!e) continue;
      if (ts.isConditionalExpression(e) && [e.whenTrue, e.whenFalse].every((b) => ts.isJsxSelfClosingElement(b) && isIconElement(b, sf))) {
        icons++;
        continue;
      }
      return false;
    }
    if (isIconElement(c, sf)) {
      icons++;
      continue;
    }
    return false;
  }
  return icons > 0;
}

export function scanTsx(source: string, fileName = "file.tsx"): A11yFinding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: A11yFinding[] = [];
  // <Image> only counts when it is next/image (icon sets export "Image" too).
  const nextImageNames = new Set<string>();
  for (const st of sf.statements) {
    if (
      ts.isImportDeclaration(st) &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      st.moduleSpecifier.text === "next/image" &&
      st.importClause?.name
    ) {
      nextImageNames.add(st.importClause.name.text);
    }
  }

  const push = (rule: A11yRule, node: ts.Node, tag: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({ rule, line: line + 1, tag, snippet: node.getText(sf).split("\n")[0]!.slice(0, 140) });
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      const a = attrs(node);

      // --- clickable non-interactive elements
      if (NON_INTERACTIVE.has(tag) && a.has("onClick")) {
        const onClick = initText(a.get("onClick")).replace(/^\{|\}$/g, "").trim();
        const decorative = isTruthyAttr(a.get("aria-hidden")) || a.get("role") && /presentation|none/.test(initText(a.get("role")));
        const stopOnly = STOP_PROPAGATION_ONLY.test(onClick);
        const keyboard =
          a.has("tabIndex") && (a.has("onKeyDown") || a.has("onKeyUp")) && (a.has("role") || tag === "tr");
        // Listbox options driven by aria-activedescendant from a combobox
        // input: the input owns focus and the arrow/Enter keys.
        const managedOption = /"option"/.test(initText(a.get("role"))) && a.has("aria-selected");
        if (!decorative && !stopOnly && !keyboard && !managedOption) push("clickable-non-interactive", node, tag);
      }

      // --- images without alt
      if ((tag === "img" || nextImageNames.has(tag)) && !a.has("alt") && !hasSpread(node)) {
        push("img-alt", node, tag);
      }

      // --- outline-none without a focus replacement
      const cls = initText(a.get("className"));
      // data-focus-ring="container": the field sits in a wrapper that draws
      // the ring via focus-within (composers, palettes) — an explicit,
      // reviewable claim rather than a silent exemption.
      const containerRing = /"container"/.test(initText(a.get("data-focus-ring")));
      if (cls && OUTLINE_NONE.test(cls) && !FOCUS_REPLACEMENT.test(cls) && !containerRing) {
        push("outline-none", node, tag);
      }

      // --- positive tabIndex
      const tabIndex = initText(a.get("tabIndex")).replace(/^\{|\}$/g, "").replace(/^"|"$/g, "").trim();
      if (/^[1-9]\d*$/.test(tabIndex)) push("positive-tabindex", node, tag);
    }

    // --- icon-only buttons / links need an accessible name
    if (ts.isJsxElement(node)) {
      const open = node.openingElement;
      const tag = open.tagName.getText(sf);
      if (tag === "button" || tag === "a" || tag === "Link") {
        const a = attrs(open);
        const named = a.has("aria-label") || a.has("aria-labelledby") || a.has("title") || hasSpread(open);
        if (!named && onlyIcons(node.children, sf)) push("icon-button-name", open, tag);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}
