// ShapesOS — Phase 21A (WS=agentweb): shared types of the agent web layer
// and its safety kernel. Plain data, no I/O.

/** Where a value came from: a person / the system, a page, or a credential. */
export type Trust = "trusted" | "untrusted" | "secret";

/** A value that remembers its origin (taint tracking). */
export interface Tainted<T = string> {
  value: T;
  /** "https://example.com", or "user" / "system" for trusted values. */
  origin: string;
  trust: Trust;
}

export type Tier = 0 | 1 | 2 | 3;

/** The page an element lives on. */
export interface PageContext {
  url: string;
  origin: string;
  title?: string;
}

/** One control on a page, as the provider reports it (never the page's prose). */
export interface FieldInfo {
  name?: string;
  type?: string;
  autocomplete?: string;
  label?: string;
}

export interface ElementInfo {
  /** Stable reference within one snapshot (e12). */
  ref: string;
  /** ARIA role: button, link, textbox, checkbox, combobox, … */
  role: string;
  /** Accessible name (page-controlled text: untrusted, length-capped). */
  name: string;
  tag?: string;
  /** The field's name attribute (what a form submits it under). */
  fieldName?: string;
  /** input type attribute. */
  type?: string;
  autocomplete?: string;
  href?: string;
  /** Does it sit in a <form>? The form's destination and fields. */
  form?: { action?: string; method?: string; fields: FieldInfo[] };
  disabled?: boolean;
}

/** What the page-aware classifier concludes about one proposed step. */
export type StepClass =
  | "benign" // reads, same-origin links, ordinary typing, GET searches
  | "money" // checkout, payment, subscribe, transfer
  | "destructive" // delete / close account / erase
  | "credential" // password / card / one-time-code fields, sign-in with a saved password
  | "send" // sends a message to someone
  | "post" // publishes / posts / comments
  | "unknown"; // we cannot tell: ask

export interface StepClassification {
  klass: StepClass;
  /** 0 = may run; 2 = always asks; 3 = money / irreversible, never auto. */
  tier: 0 | 2 | 3;
  reasons: string[];
}

export type StepDecision =
  | { decision: "allow"; tier: 0; klass: StepClass; reasons: string[] }
  | { decision: "confirm"; tier: 2; klass: StepClass; reasons: string[]; taint?: TaintHit[] }
  | { decision: "handoff"; tier: 3; klass: StepClass; reasons: string[] }
  | { decision: "refuse"; tier: 2 | 3; klass: StepClass; reasons: string[] };

/** An untrusted (or secret) value found flowing into a sensitive sink. */
export interface TaintHit {
  /** The registered value (shortened for display) and where it came from. */
  value: string;
  origin: string;
  trust: Trust;
  /** Which argument carried it. */
  arg: string;
}

/** A step the model proposes. Browser steps and other sensitive tool calls. */
export type ProposedStep =
  | { kind: "navigate"; url: string }
  | { kind: "click"; element: ElementInfo; page: PageContext }
  | { kind: "type"; element: ElementInfo; page: PageContext; value: string }
  | { kind: "tool"; tool: string; effect: ToolEffect; args: Record<string, unknown> };

/** What a non-browser tool does to the world (decides its sink class). */
export type ToolEffect = "read" | "send" | "post" | "file_write" | "delete" | "money" | "fetch";
