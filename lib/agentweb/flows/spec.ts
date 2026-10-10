// ShapesOS — Phase 21A round 2 (WS=agentweb): "teach once" flows (PURE).
//
// A recorded browsing session becomes a flow: navigate / click / type steps with LOCATORS (what
// was clicked: role, name, stable attributes) instead of page-specific refs, so it can be run
// again and heal when the page changes (lib/agentweb/flows/locate.ts). Typed text is never
// recorded: each typed field becomes a parameter, and a sensitive one (password, card) is marked
// "asked at run time" and never stored. A flow only ever covers ONE site (the first one); a
// session that wandered off ends the flow there. Steps the safety gate refused or handed to the
// person are not part of the flow: money and sign-in stay the person's own act.

import type { ElementInfo } from "../types";
import { originOf } from "../capabilities";

export class FlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowError";
  }
}

export interface Locator {
  role: string;
  name: string;
  fieldName?: string;
  inputType?: string;
  /** Links: the address without query string or fragment. */
  href?: string;
}

export type FlowStep = { kind: "navigate"; url: string } | { kind: "click"; locator: Locator } | { kind: "type"; locator: Locator; param: string };

export interface FlowParam {
  key: string;
  label: string;
  /** Password or card field: never stored, asked for every run. */
  sensitive: boolean;
}

export interface FlowSpec {
  v: 1;
  name: string;
  origin: string;
  params: FlowParam[];
  steps: FlowStep[];
  truncated?: string;
}

export const MAX_FLOW_STEPS = 60;
const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

export function locatorOf(e: ElementInfo): Locator {
  let href: string | undefined;
  if (e.href) {
    try {
      const u = new URL(e.href);
      href = `${u.origin}${u.pathname}`;
    } catch {
      /* relative or odd: skip */
    }
  }
  return { role: e.role, name: clip(e.name, 120), ...(e.fieldName ? { fieldName: e.fieldName } : {}), ...(e.type ? { inputType: e.type } : {}), ...(href ? { href } : {}) };
}

interface EventLike {
  type: string;
  payload?: unknown;
}

const SENSITIVE_NAME = /passw|passcode|secret|card|cvv|cvc|iban|ssn|otp|2fa/i;

export function buildFlow(events: readonly EventLike[], opts: { name: string }): FlowSpec {
  const steps: FlowStep[] = [];
  const params: FlowParam[] = [];
  let origin = "";
  let truncated: string | undefined;
  for (const e of events) {
    if (e.type !== "browser") continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const tool = String(p.tool ?? "");
    if (p.decision === "handoff" || p.decision === "refuse" || p.blocked) continue; // the person's own act, or never done
    if (tool === "browser_navigate" && typeof p.url === "string") {
      const o = originOf(p.url);
      if (!o) continue;
      if (!origin) origin = o;
      if (o !== origin) {
        truncated = `The session left ${origin}; the flow stops there.`;
        break;
      }
      steps.push({ kind: "navigate", url: p.url });
    } else if ((tool === "browser_click" || tool === "browser_type") && p.locator && typeof p.locator === "object") {
      if (!origin) continue;
      const l = p.locator as Locator;
      if (typeof l.role !== "string" || typeof l.name !== "string") continue;
      const locator: Locator = { role: l.role, name: clip(l.name, 120), ...(l.fieldName ? { fieldName: String(l.fieldName).slice(0, 80) } : {}), ...(l.inputType ? { inputType: String(l.inputType).slice(0, 20) } : {}), ...(l.href ? { href: String(l.href).slice(0, 300) } : {}) };
      if (tool === "browser_click") steps.push({ kind: "click", locator });
      else {
        const key = `p${params.length + 1}`;
        params.push({ key, label: locator.name || locator.fieldName || key, sensitive: locator.inputType === "password" || SENSITIVE_NAME.test(`${locator.name} ${locator.fieldName ?? ""}`) });
        steps.push({ kind: "type", locator, param: key });
      }
    }
    if (steps.length >= MAX_FLOW_STEPS) {
      truncated = `The flow stops after ${MAX_FLOW_STEPS} steps.`;
      break;
    }
  }
  if (!steps.some((s) => s.kind === "click" || s.kind === "type")) throw new FlowError("There is nothing to teach: the session has no clicks or typing on a page.");
  return { v: 1, name: clip(opts.name, 120) || "Web flow", origin, params, steps, ...(truncated ? { truncated } : {}) };
}

/** Re-check a flow read back from storage or edited by hand. Throws FlowError. */
export function validateFlow(raw: unknown): FlowSpec {
  const f = (raw ?? {}) as Record<string, unknown>;
  if (f.v !== 1 || typeof f.name !== "string" || typeof f.origin !== "string" || !originOf(f.origin)) throw new FlowError("This is not a flow.");
  const steps = Array.isArray(f.steps) ? f.steps : [];
  if (steps.length < 1 || steps.length > MAX_FLOW_STEPS) throw new FlowError(`A flow has 1 to ${MAX_FLOW_STEPS} steps.`);
  const params = Array.isArray(f.params) ? (f.params as FlowParam[]) : [];
  const keys = new Set(params.map((p) => p.key));
  for (const s of steps as Array<Record<string, unknown>>) {
    if (s.kind === "navigate") {
      if (typeof s.url !== "string" || originOf(s.url) !== f.origin) throw new FlowError("A navigate step must stay on the flow's site.");
    } else if (s.kind === "click" || s.kind === "type") {
      const l = s.locator as Record<string, unknown> | undefined;
      if (!l || typeof l.role !== "string" || typeof l.name !== "string") throw new FlowError("A step needs a locator.");
      if (s.kind === "type" && (typeof s.param !== "string" || !keys.has(s.param))) throw new FlowError("A typing step needs a declared parameter.");
    } else throw new FlowError(`Unknown step kind.`);
  }
  return f as unknown as FlowSpec;
}
