// ShapesOS — Phase 21A (WS=agentweb): describe one element for the page-aware gate.
//
// DESCRIBE_ELEMENT runs INSIDE the page (Playwright's locator.evaluate), so it
// is self-contained: no imports, no closures. It returns what classify.ts needs
// and nothing else: role, accessible-ish name, input type and autocomplete, the
// link address, and the form with its destination and field kinds. Field VALUES
// are never read.

import type { ElementInfo } from "./types";

export type DescribedElement = Omit<ElementInfo, "ref">;

export const DESCRIBE_ELEMENT = (el: Element): DescribedElement => {
  const e = el as HTMLInputElement & HTMLAnchorElement;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  const labels = (e as HTMLInputElement).labels ? [...(e as HTMLInputElement).labels!].map((l) => l.textContent ?? "").join(" ") : "";
  const name = (
    el.getAttribute("aria-label") ||
    labels ||
    (tag === "input" && ["submit", "button", "reset"].includes(type) ? e.value : "") ||
    (el as HTMLElement).innerText ||
    el.getAttribute("placeholder") ||
    el.getAttribute("title") ||
    el.getAttribute("name") ||
    ""
  )
    .replace(/[​-‏‪-‮⁠-⁤﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const role = tag === "a" ? "link" : tag === "button" || (tag === "input" && ["submit", "button", "reset", "image"].includes(type)) ? "button" : tag === "select" ? "combobox" : type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : "textbox";
  const form = e.form ?? (el.closest("form") as HTMLFormElement | null);
  return {
    role,
    name,
    tag,
    ...(el.getAttribute("name") && tag !== "a" ? { fieldName: el.getAttribute("name")! } : {}),
    ...(type ? { type } : {}),
    ...(el.getAttribute("autocomplete") ? { autocomplete: el.getAttribute("autocomplete")!.toLowerCase() } : {}),
    ...(tag === "a" ? { href: (el as HTMLAnchorElement).href } : {}),
    ...(form
      ? {
          form: {
            action: form.action,
            method: (form.method || "get").toLowerCase(),
            fields: [...form.elements]
              .filter((f) => ["INPUT", "SELECT", "TEXTAREA"].includes(f.tagName) && !["submit", "button", "reset", "image", "hidden"].includes((f.getAttribute("type") ?? "").toLowerCase()))
              .map((f) => ({
                name: f.getAttribute("name") ?? undefined,
                type: f.tagName === "TEXTAREA" ? "textarea" : f.tagName === "SELECT" ? "select" : (f.getAttribute("type") ?? "text").toLowerCase(),
                autocomplete: f.getAttribute("autocomplete")?.toLowerCase() ?? undefined,
                label: (f.getAttribute("aria-label") ?? f.getAttribute("placeholder") ?? "").slice(0, 80),
              })),
          },
        }
      : {}),
  };
};
