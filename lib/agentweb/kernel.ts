// ShapesOS — Phase 21A (WS=agentweb): the safety kernel facade.
//
// Assumption: a prompt injection will sometimes succeed against the model.
// The design limits what that can DO, using structure, not detection:
//
//   reader / actor split   the actor sees validated fields, never raw page text
//   taint tracking         page-derived values need a confirmation before they
//                          reach a sensitive sink; secrets never reach one
//   origin capabilities    a task has its origins; a new one pauses and asks
//   page-aware tiers       money / destructive / credential steps are handed
//                          to the person (Tier 3); send / post / unknown ask
//   output hygiene         an answer cannot carry data out in an image or link
//
// authorize() is PURE and is the one call a tool makes before it acts. The
// kernel never executes anything; callers run what it allows, ask for what it
// says to confirm, and stop at what it refuses or hands off.

import { classifyStep } from "./classify";
import { checkNavigation, grantOrigin, originOf, type TaskCapabilities } from "./capabilities";
import { sanitizeModelOutput } from "./redact";
import { actorView, readPage, wrapUntrusted, type PageReading, type ReadPageOptions, type ReaderModel } from "./reader";
import { TaintLedger, checkFlow } from "./taint";
import type { ElementInfo, ProposedStep, StepClass, StepDecision, TaintHit } from "./types";

export interface KernelOptions {
  caps: TaskCapabilities;
  /** Share a taint ledger (the task's) instead of starting a fresh one. */
  ledger?: TaintLedger;
  /** Credentials and tokens that must never reach an outward sink. */
  secrets?: readonly string[];
}

const hit = <K extends StepDecision["decision"]>(
  decision: K,
  tier: 0 | 2 | 3,
  klass: StepClass,
  reasons: string[],
  taint?: TaintHit[],
): StepDecision => ({ decision, tier, klass, reasons, ...(taint?.length ? { taint } : {}) }) as StepDecision;

export class SafetyKernel {
  readonly caps: TaskCapabilities;
  readonly ledger: TaintLedger;

  constructor(opts: KernelOptions) {
    this.caps = opts.caps;
    this.ledger = opts.ledger ?? new TaintLedger();
    for (const s of opts.secrets ?? []) this.ledger.registerSecret(s);
  }

  grantOrigin(origin: string): void {
    grantOrigin(this.caps, origin);
  }

  /** Reader step: page in, validated fields out; everything read becomes tracked untrusted data. */
  async readPage(page: { url: string; html: string }, reader: ReaderModel, opts?: ReadPageOptions): Promise<PageReading> {
    const reading = await readPage(page, reader, opts);
    const f = reading.fields;
    const origin = reading.origin || "unknown";
    for (const s of [f.title, f.summary, ...f.emails, ...f.phones, ...f.facts.map((x) => x.value), ...f.links.map((l) => l.url)]) this.ledger.register(s, origin, "untrusted");
    return reading;
  }

  /** The only page-derived text the actor model receives. */
  actorView(reading: PageReading): string {
    return actorView(reading);
  }

  /** Third-party text (a search snippet, anything not from the person) as data. */
  wrapUntrusted(text: string, origin: string): string {
    this.ledger.register(text, origin, "untrusted");
    return wrapUntrusted(text, origin);
  }

  /** The page's controls, for the actor to choose among. Labels are page-controlled: short, printable, wrapped. */
  renderControls(controls: readonly ElementInfo[], pageUrl: string): string {
    const origin = originOf(pageUrl) ?? "unknown";
    const lines = controls.slice(0, 120).map((c) => `${c.ref} ${c.role} "${c.name.slice(0, 80)}"${c.href ? ` -> ${c.href.slice(0, 200)}` : ""}${c.type ? ` [${c.type}]` : ""}`);
    for (const c of controls) {
      if (c.name.length >= 12) this.ledger.register(c.name, origin, "untrusted");
      if (c.href && originOf(c.href) !== origin) this.ledger.register(c.href, origin, "untrusted");
    }
    return wrapUntrusted(`Controls on the page:\n${lines.join("\n")}`, origin);
  }

  sanitizeOutput(text: string): string {
    return sanitizeModelOutput(text, { allowedOrigins: this.caps.allowedOrigins, ledger: this.ledger });
  }

  /** May the task start at this address? (Before any origin is fixed.) */
  authorizeStart(url: string): StepDecision {
    const o = originOf(url);
    if (!o) return hit("refuse", 2, "unknown", ["only http and https addresses can be opened"]);
    const flow = checkFlow(this.ledger, { name: "browser_navigate", kind: "navigate", sameOrigin: false }, { url });
    if (flow.verdict === "refuse") return hit("refuse", 2, "unknown", ["the address carries a secret"], flow.hits);
    if (flow.verdict === "confirm") return hit("confirm", 2, "unknown", ["the address was taken from a web page or search result, not given by you"], flow.hits);
    return hit("allow", 0, "benign", ["an address you gave"]);
  }

  /** Fix the task's first origin. Call after authorizeStart allowed (or the person confirmed). */
  startAt(url: string): void {
    const o = originOf(url);
    if (o) this.caps.allowedOrigins.add(o);
  }

  authorize(step: ProposedStep): StepDecision {
    switch (step.kind) {
      case "navigate":
        return this.navigation(step.url, "navigate");
      case "click": {
        if (!this.caps.allowedActions.has("interact")) return hit("refuse", 2, "unknown", ["this task may only read pages"]);
        const c = classifyStep({ action: "click", element: step.element, page: step.page });
        if (c.tier === 3) return hit("handoff", 3, c.klass, c.reasons);
        if (c.tier === 2) return hit("confirm", 2, c.klass, c.reasons);
        if (step.element.role === "link" && step.element.href) {
          const nav = this.navigation(step.element.href, "navigate");
          if (nav.decision !== "allow") return nav;
        }
        return hit("allow", 0, c.klass, c.reasons);
      }
      case "type": {
        if (!this.caps.allowedActions.has("interact")) return hit("refuse", 2, "unknown", ["this task may only read pages"]);
        const c = classifyStep({ action: "type", element: step.element, page: step.page, value: step.value });
        if (c.tier === 3) return hit("handoff", 3, c.klass, c.reasons);
        const flow = checkFlow(this.ledger, { name: "browser_type", kind: "type" }, { value: step.value });
        if (flow.verdict === "refuse") return hit("refuse", 2, "credential", ["the text contains a secret that must never be typed into a page"], flow.hits);
        if (flow.verdict === "confirm") return hit("confirm", 2, "unknown", ["the text was taken from a web page; confirm before typing it into one"], flow.hits);
        return hit("allow", 0, "benign", c.reasons);
      }
      case "tool":
        return this.tool(step);
    }
  }

  private navigation(url: string, kind: "navigate" | "fetch"): StepDecision {
    const nav = checkNavigation(this.caps, url);
    if (!nav.ok && nav.reason !== "new-origin") {
      return hit("refuse", 2, "unknown", [nav.reason === "bad-scheme" ? "only http and https addresses can be opened" : "that is not a web address"]);
    }
    const flow = checkFlow(this.ledger, { name: "browser_navigate", kind, sameOrigin: nav.ok }, { url });
    if (flow.verdict === "refuse") return hit("refuse", 2, "unknown", ["the address carries a secret"], flow.hits);
    if (!nav.ok) {
      return hit("confirm", 2, "unknown", [`opens a new origin: ${nav.origin}`], flow.hits);
    }
    return hit("allow", 0, "benign", ["an address on the task's origin"]);
  }

  private tool(step: Extract<ProposedStep, { kind: "tool" }>): StepDecision {
    const { effect } = step;
    if (effect === "money" || effect === "delete") return hit("handoff", 3, effect === "money" ? "money" : "destructive", [`${step.tool} moves money or destroys data: it goes to the platform's own approval card, never auto`]);
    const flow = checkFlow(this.ledger, { name: step.tool, kind: effect }, step.args);
    if (flow.verdict === "refuse") return hit("refuse", 2, effect === "send" ? "send" : "unknown", [`${step.tool} would carry a secret out`], flow.hits);
    if (effect === "read") return hit("allow", 0, "benign", ["a read"]);
    if (effect === "fetch") {
      const url = typeof step.args.url === "string" ? step.args.url : undefined;
      if (url) {
        const nav = this.navigation(url, "fetch");
        if (nav.decision !== "allow") return nav;
      } else {
        return hit("confirm", 2, "unknown", ["an outward request with no readable address"], flow.hits);
      }
      return flow.verdict === "confirm" ? hit("confirm", 2, "unknown", ["the request carries data taken from a web page"], flow.hits) : hit("allow", 0, "benign", ["a request to the task's origin"]);
    }
    const klass: StepClass = effect === "send" ? "send" : effect === "post" ? "post" : "unknown";
    const why = effect === "send" ? "sends something to someone" : effect === "post" ? "publishes something" : "writes a file";
    return hit("confirm", 2, klass, [`${step.tool} ${why}: always asks`], flow.hits);
  }
}
