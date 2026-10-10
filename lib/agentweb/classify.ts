// ShapesOS — Phase 21A (WS=agentweb): the page-aware tier classifier (PURE).
//
// Today `browser_act` always asks, which tells the person nothing and teaches
// them to click yes. This looks at WHAT a step would do on the page in front
// of it and decides how it is gated:
//
//   money        Tier 3  checkout, payment, plan subscribe, transfer
//   destructive  Tier 3  delete / close account / erase
//   credential   Tier 3  password, card and one-time-code fields, and the
//                        sign-in that submits a saved password. Values are
//                        NEVER supplied by a model.
//   send / post  Tier 2  always asks (never auto)
//   unknown      Tier 2  asks
//   benign       Tier 0  ordinary reading, same-origin links, search, typing
//
// Inputs: URL, form field types and autocomplete hints (cc-number, password),
// button text, the form's submit destination. Labels are folded
// (NFKC / homoglyphs / zero-width) the way authority.ts folds action names, and
// the Tier 3 verb scan of evaluateTier is a safety net on top: if it would call
// the label Tier 3 the step is never benign.
//
// This is a heuristic over page-controlled text. It errs towards asking; what
// it cannot do is read intent from an unfamiliar UI, which is why "unknown"
// exists and why the gate also sits behind origin capabilities and taint.

import { evaluateTier } from "@/lib/orchestrator/authority";
import { foldLabel } from "./fold";
import type { ElementInfo, FieldInfo, PageContext, StepClass, StepClassification } from "./types";

export interface StepInput {
  action: "click" | "type";
  element: ElementInfo;
  page: PageContext;
  /** For "type": the text. Never inspected for credentials (the FIELD decides). */
  value?: string;
}

const MONEY_LABEL =
  /\b(place (your |the )?order|pay( now| securely| with \w+)?|checkout|check out|buy( now| it now)?|purchase|complete (the |your )?(order|purchase|payment)|confirm (the |your )?(order|payment|purchase)|donate|send money|wire|top up|add (a )?payment|upgrade( now| plan| to \w+)?|start (a |your )?(free )?trial|make payment|transfer( funds| money)?)\b/;
const MONEY_PATH = /(^|\/)(checkout|payments?|pay|charge|purchase|buy|billing|order\/confirm|place-order|transfer|donate|subscribe\/plan)(\/|$|\?)/;
const PLAN_CONTEXT = /(pricing|plans?|billing|checkout|subscription|premium|upgrade)/;
const DESTRUCTIVE_LABEL =
  /\b(delete|erase|destroy|purge|wipe|deactivate|terminate|close (my |your |the )?account|cancel (my |your |the )?(account|subscription|plan|membership)|permanently remove|remove (my |your |the )?account|reset (all|account)|revoke (all|access))\b/;
const DESTRUCTIVE_PATH = /(^|\/)(delete|destroy|deactivate|close-account|terminate|erase|purge)(\/|$|\?)/;
const POST_LABEL = /\b(post|publish|comment|tweet|share|go live|submit (a )?review|submit (a )?post|reply publicly)\b/;
const SEND_LABEL = /\b(send|reply|forward|email|e mail|message|contact|request (a )?(quote|callback|call back|demo)|book( now| a)?|schedule|subscribe|invite|submit|sign up|apply|enquire|inquire)\b/;
const SEND_PATH = /(mail|message|contact|send|compose|inquiry|enquiry|quote|booking|newsletter|subscribe|invite|signup)/;
const SIGNIN_LABEL = /\b(sign in|log in|login|signin|continue|submit|next|verify|authorize|allow)\b/;
const BENIGN_BUTTON =
  /^(menu|open|close|expand|collapse|show( more| less| all)?|hide|more|less|next|previous|prev|back|forward|tab|filter|sort|search|go|add to (cart|basket|bag|wishlist|list)|accept( all)?( cookies)?|reject( all)?|dismiss|ok|okay|cancel|toggle|zoom( in| out)?|play|pause|mute|unmute|read more|learn more|view|view details|details|apply filters?|clear( filters)?|remove from (cart|basket|bag|wishlist|list))$/;

const CRED_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/;
const CRED_LABEL = /\b(password|passcode|card number|credit card|cvv|cvc|security code|expir(y|ation)|one time code|otp|2fa code)\b/;

function isCredentialField(el: { type?: string; autocomplete?: string; name?: string; label?: string }): boolean {
  if ((el.type ?? "").toLowerCase() === "password") return true;
  if (CRED_AUTOCOMPLETE.test((el.autocomplete ?? "").toLowerCase())) return true;
  return CRED_LABEL.test(foldLabel(`${el.name ?? ""} ${el.label ?? ""}`));
}

function pathOf(u: string | undefined): string {
  if (!u) return "";
  try {
    return new URL(u).pathname.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

function originOf(u: string | undefined): string | null {
  if (!u) return null;
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

const hit = (klass: StepClass, tier: 0 | 2 | 3, reasons: string[]): StepClassification => ({ klass, tier, reasons });

export function classifyStep(step: StepInput): StepClassification {
  const { element: el, page } = step;
  const label = foldLabel(el.name ?? "");
  const form = el.form;
  const action = pathOf(form?.action);
  const pagePath = pathOf(page.url);
  const formFields: FieldInfo[] = form?.fields ?? [];
  const hasCardField = formFields.some((f) => /^cc-/.test((f.autocomplete ?? "").toLowerCase()));
  const hasPasswordField = formFields.some((f) => isCredentialField(f) && !/^cc-/.test((f.autocomplete ?? "").toLowerCase()));

  // 1. Typing: the FIELD decides, never the value.
  if (step.action === "type") {
    if (isCredentialField(el)) {
      return hit("credential", 3, [`"${el.name || el.type || "field"}" is a password, card or code field: a model never supplies these; the person types them`]);
    }
    return hit("benign", 0, ["ordinary text entry (nothing leaves the page until a submit, which is gated)"]);
  }

  // 2. Clicks.
  if (el.href && /^\s*mailto:/i.test(el.href)) return hit("send", 2, ["mailto link: opens a message to someone"]);
  if (el.href && /^\s*(javascript|data|vbscript):/i.test(el.href)) return hit("unknown", 2, ["link runs script instead of navigating"]);

  // Money first: a card field in the form, a payment destination, or a payment label.
  if (hasCardField) return hit("money", 3, ["the form collects a card number"]);
  if (MONEY_PATH.test(action)) return hit("money", 3, [`the form submits to a payment destination (${action})`]);
  if (MONEY_LABEL.test(label)) return hit("money", 3, [`button text "${el.name}" looks like a payment`]);
  if (/\bsubscribe\b/.test(label) && (PLAN_CONTEXT.test(pagePath) || PLAN_CONTEXT.test(action))) {
    return hit("money", 3, ["subscribing to a plan on a pricing or billing page"]);
  }
  if (el.href && MONEY_PATH.test(pathOf(el.href)) && el.role === "link") return hit("money", 3, [`link goes to a payment page (${pathOf(el.href)})`]);

  // Destructive.
  if (DESTRUCTIVE_LABEL.test(label)) return hit("destructive", 3, [`button text "${el.name}" deletes or closes something`]);
  if (DESTRUCTIVE_PATH.test(action)) return hit("destructive", 3, [`the form submits to a delete destination (${action})`]);
  if (el.href && DESTRUCTIVE_PATH.test(pathOf(el.href))) return hit("destructive", 3, [`link goes to a delete action (${pathOf(el.href)})`]);

  // Saved-password sign-in: a form with a password field and a submit.
  if (hasPasswordField && el.role === "button") {
    return hit("credential", 3, ["this submits a password sign-in: ShapesOS does not fill saved passwords for an agent; the person signs in"]);
  }

  // The Tier 3 verb scan of the DoA evaluator is a backstop for anything above.
  if (evaluateTier({ kind: "browser_click", description: `${label} ${action}` }, { smallActionThresholdCents: 0 }) === 3) {
    return hit(/\b(delet|destroy|purg|wip|eras|shred|truncat)/.test(`${label} ${action}`) ? "destructive" : "money", 3, [`"${el.name}" matches a money or deletion verb`]);
  }

  // Posting and sending.
  if (POST_LABEL.test(label)) return hit("post", 2, [`button text "${el.name}" publishes content`]);
  const collectsMessage = formFields.some((f) => ["textarea", "email", "tel"].includes((f.type ?? "").toLowerCase()));
  if (el.role === "button" && SEND_LABEL.test(label) && (collectsMessage || SEND_PATH.test(action) || SEND_PATH.test(pagePath))) {
    return hit("send", 2, [`"${el.name}" sends what was entered to someone`]);
  }
  if (el.role === "button" && SIGNIN_LABEL.test(label) && hasPasswordField) return hit("credential", 3, ["sign-in"]);

  // Benign shapes.
  if (el.role === "link" && el.href) {
    return hit("benign", 0, ["a link (the navigation itself is checked against the task's allowed origins)"]);
  }
  if (["checkbox", "radio", "combobox"].includes(el.role)) return hit("benign", 0, ["a choice on the page"]);
  if (el.role === "button" && form && form.method === "get" && (originOf(form.action) ?? page.origin) === page.origin) {
    return hit("benign", 0, ["a same-origin GET form (a search or filter)"]);
  }
  if (el.role === "button" && !form && BENIGN_BUTTON.test(label.trim())) return hit("benign", 0, [`"${el.name}" is an ordinary page control`]);

  // Everything else: ask.
  if (!label.trim()) return hit("unknown", 2, ["a control with no readable name"]);
  if (form && form.method !== "get" && (originOf(form.action) ?? page.origin) !== page.origin) {
    return hit("unknown", 2, [`the form submits to another origin (${originOf(form.action)})`]);
  }
  return hit("unknown", 2, [`could not tell what "${el.name}" does on this page`]);
}
