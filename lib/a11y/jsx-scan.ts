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
//
// Dev-only tooling: never imported by app code.

import ts from "typescript";

export type A11yRule = "clickable-non-interactive" | "img-alt" | "outline-none";

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
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}
