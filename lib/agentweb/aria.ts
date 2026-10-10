// ShapesOS — Phase 21A (WS=agentweb): read Playwright's AI-mode aria snapshot (PURE).
//
// page.ariaSnapshot({ mode: "ai" }) returns a YAML-like tree whose nodes carry
// stable element references:
//   - link "About us" [ref=e3] [cursor=pointer]:
//     - /url: /about
//   - textbox "Email" [ref=e5]
// (Playwright 1.63; the format was captured from a real page, see the test.)
// Only the controls an agent can act on are returned, in document order.

export interface AriaControl {
  ref: string;
  role: string;
  name: string;
  /** href from a following "/url:" line, as written on the page. */
  url?: string;
  disabled?: boolean;
}

const ACTIONABLE = new Set(["link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "menuitem", "tab", "slider", "spinbutton"]);
const LINE = /^\s*-\s+([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s+\[[^\]]*\])*)\s*:?\s*(.*)$/;

export function parseAriaSnapshot(tree: string): AriaControl[] {
  const out: AriaControl[] = [];
  let last: AriaControl | null = null;
  for (const raw of tree.split("\n")) {
    const urlLine = /^\s*-\s+\/url:\s*(.*)$/.exec(raw);
    if (urlLine) {
      if (last && last.role === "link") last.url = urlLine[1]!.trim();
      continue;
    }
    const m = LINE.exec(raw);
    if (!m) continue;
    const [, role, name, attrs] = m;
    const ref = /\[ref=(e\d+)\]/.exec(attrs ?? "")?.[1];
    if (!ref || !ACTIONABLE.has(role!)) {
      last = null;
      continue;
    }
    last = { ref, role: role!, name: (name ?? "").replace(/\\(["\\])/g, "$1"), ...(/\[disabled\]/.test(attrs ?? "") ? { disabled: true } : {}) };
    out.push(last);
  }
  return out;
}
