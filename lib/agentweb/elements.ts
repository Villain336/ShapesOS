// ShapesOS — Phase 21A (WS=agentweb): the control list of a page from its
// HTML alone (PURE). It approximates the accessibility tree of a rendered
// page: links, fields, buttons, each with a stable ref (e1, e2, …) in document
// order, the form it belongs to, and the attributes the page-aware classifier
// reads (input type, autocomplete). Hidden elements are left out.
//
// The live providers report the same ElementInfo from a real browser; this is
// what fixtures, the evals and the plain-HTTP reading path use.

import { attr, findAll, isHiddenElement, parseHtml, textOf, type HtmlNode } from "./html";
import type { ElementInfo, FieldInfo } from "./types";

const NAME_CAP = 120;

/** Page-controlled text becomes a short, printable label. */
export function cleanLabel(s: string, cap = NAME_CAP): string {
  return s
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "") // invisible format characters vanish
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, cap);
}

function resolve(base: string, href: string | undefined): string | undefined {
  if (href === undefined) return undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

function hiddenByAncestor(n: HtmlNode): boolean {
  for (let p: HtmlNode | undefined = n; p; p = p.parent) if (p.type === "element" && isHiddenElement(p)) return true;
  return false;
}

function labelFor(root: HtmlNode, n: HtmlNode): string {
  const id = attr(n, "id");
  if (id) {
    const l = findAll(root, (x) => x.tag === "label" && attr(x, "for") === id)[0];
    if (l) return cleanLabel(textOf(l));
  }
  for (let p = n.parent; p; p = p.parent) if (p.tag === "label") return cleanLabel(textOf(p));
  return "";
}

const FIELD_TYPES_NO_TEXTBOX = new Set(["submit", "button", "reset", "image", "checkbox", "radio", "hidden", "file", "range", "color"]);

function fieldInfo(root: HtmlNode, f: HtmlNode): FieldInfo {
  return {
    name: attr(f, "name"),
    type: f.tag === "textarea" ? "textarea" : f.tag === "select" ? "select" : (attr(f, "type") ?? "text").toLowerCase(),
    autocomplete: attr(f, "autocomplete")?.toLowerCase(),
    label: labelFor(root, f) || cleanLabel(attr(f, "aria-label") ?? attr(f, "placeholder") ?? ""),
  };
}

export interface ControlNode {
  info: ElementInfo;
  node: HtmlNode;
  formNode?: HtmlNode;
}

export function controlsOf(html: string, pageUrl: string): ElementInfo[] {
  return scanControls(html, pageUrl).map((c) => c.info);
}

/** The values a browser would submit for a form before the person types anything. */
export function formDefaults(form: HtmlNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of findAll(form, (n) => ["input", "textarea", "select"].includes(n.tag ?? ""))) {
    const name = attr(f, "name");
    if (!name) continue;
    const type = (attr(f, "type") ?? "text").toLowerCase();
    if (["submit", "button", "reset", "image", "file"].includes(type)) continue;
    if ((type === "checkbox" || type === "radio") && !("checked" in (f.attrs ?? {}))) continue;
    if (f.tag === "select") {
      const opts = findAll(f, (n) => n.tag === "option");
      const chosen = opts.find((o) => "selected" in (o.attrs ?? {})) ?? opts[0];
      if (chosen) out[name] = attr(chosen, "value") ?? textOf(chosen).trim();
    } else if (f.tag === "textarea") {
      out[name] = textOf(f);
    } else {
      out[name] = attr(f, "value") ?? (type === "checkbox" || type === "radio" ? "on" : "");
    }
  }
  return out;
}

export function scanControls(html: string, pageUrl: string): ControlNode[] {
  const root = parseHtml(html);
  const out: ControlNode[] = [];
  const nodes = findAll(root, (n) => n.type === "element" && ["a", "button", "input", "textarea", "select", "summary"].includes(n.tag ?? ""));
  for (const n of nodes) {
    if (hiddenByAncestor(n)) continue;
    const tag = n.tag!;
    const type = (attr(n, "type") ?? "").toLowerCase();
    if (tag === "a" && attr(n, "href") === undefined) continue;
    if (tag === "input" && type === "hidden") continue;
    let role: string;
    let name: string;
    if (tag === "a") {
      role = "link";
      name = cleanLabel(attr(n, "aria-label") ?? "") || cleanLabel(textOf(n)) || cleanLabel(attr(n, "title") ?? "");
    } else if (tag === "button" || tag === "summary" || (tag === "input" && ["submit", "button", "reset", "image"].includes(type))) {
      role = "button";
      name = cleanLabel(attr(n, "aria-label") ?? "") || cleanLabel(tag === "input" ? (attr(n, "value") ?? "") : textOf(n)) || cleanLabel(attr(n, "title") ?? "");
    } else {
      role = tag === "select" ? "combobox" : type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : "textbox";
      if (tag === "input" && FIELD_TYPES_NO_TEXTBOX.has(type) && role === "textbox") continue;
      name = labelFor(root, n) || cleanLabel(attr(n, "aria-label") ?? "") || cleanLabel(attr(n, "placeholder") ?? "") || cleanLabel(attr(n, "name") ?? "");
    }
    const el: ElementInfo = {
      ref: `e${out.length + 1}`,
      role,
      name,
      tag,
      ...(attr(n, "name") && tag !== "a" ? { fieldName: attr(n, "name") } : {}),
      ...(type ? { type } : {}),
      ...(attr(n, "autocomplete") ? { autocomplete: attr(n, "autocomplete")!.toLowerCase() } : {}),
      ...(tag === "a" ? { href: resolve(pageUrl, attr(n, "href")) } : {}),
      ...("disabled" in (n.attrs ?? {}) ? { disabled: true } : {}),
    };
    let form: HtmlNode | undefined;
    for (let p = n.parent; p; p = p.parent) if (p.tag === "form") { form = p; break; }
    if (form) {
      const fields = findAll(form, (x) => ["input", "textarea", "select"].includes(x.tag ?? "") && !["submit", "button", "reset", "image", "hidden"].includes((attr(x, "type") ?? "").toLowerCase())).map((f) => fieldInfo(root, f));
      el.form = { action: resolve(pageUrl, attr(form, "action") ?? ""), method: (attr(form, "method") ?? "get").toLowerCase(), fields };
    }
    out.push({ info: el, node: n, formNode: form });
  }
  return out;
}
