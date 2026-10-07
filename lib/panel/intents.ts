// ShapesOS — Phase 19B (WS=panel): structured persona intents.
// Commercial layer (entitlement dress_rehearsal). See lib/panel/README.md.
//
// Replaces the prototype's regex intent parser (src/simulation/pagemaster.ts
// parseIntent): the persona used to write free text like `click "Choose Pro"`
// and a set of regexes guessed the verb, target and value (and a stray
// "I'm done." became a finish). Now each step is a submit_step tool call with
// a typed intent; validateIntent() checks the fields each action needs, and
// an intent that fails is an honest "unparsed" observation (friction), never
// a guess.

import { z } from "zod";

export const INTENT_ACTIONS = ["scroll", "read", "click", "fill", "back", "finish"] as const;
export type IntentAction = (typeof INTENT_ACTIONS)[number];

export const FINISH_SIGNALS = ["checkout-attempted", "bounced", "goal-complete"] as const;
export type FinishSignal = (typeof FINISH_SIGNALS)[number];

export const IntentSchema = z.object({
  action: z.enum(INTENT_ACTIONS).describe("scroll / read a section, click a button or link, fill a form field, go back, or finish"),
  target: z
    .string()
    .nullable()
    .describe('Section heading (or "#id") for scroll/read, the button or link name for click, the field label for fill; null for back/finish'),
  value: z.string().nullable().describe("The text to type (fill only); null otherwise"),
  finish: z.enum(FINISH_SIGNALS).nullable().describe("finish only: checkout-attempted (you would pay or sign up), bounced (the page lost you), goal-complete (done without buying); null otherwise"),
});
export type Intent = z.infer<typeof IntentSchema>;

export const StepOutputSchema = z.object({
  thinkAloud: z.string().describe("Your private reasoning, in character"),
  intent: IntentSchema,
});
export type StepOutput = z.infer<typeof StepOutputSchema>;

export const STEP_TOOL = {
  name: "submit_step",
  description: "Submit what you think and what you do next on the page.",
  schema: StepOutputSchema,
};

/** Fields each action needs. null = fine; else the reason the intent can't be acted on. */
export function validateIntent(intent: Intent): string | null {
  const t = intent.target?.trim() ?? "";
  switch (intent.action) {
    case "scroll":
    case "read":
    case "click":
      return t ? null : `${intent.action} needs a target`;
    case "fill":
      if (!t) return "fill needs a field label";
      return intent.value !== null && intent.value !== undefined ? null : "fill needs a value";
    case "back":
      return null;
    case "finish":
      return intent.finish ? null : "finish needs a signal (checkout-attempted, bounced or goal-complete)";
  }
}

/** One readable line for the timeline and the memory stream, e.g. `read "Pricing"`. */
export function describeIntent(intent: Intent | null): string {
  if (!intent) return "(no intent)";
  const q = (s: string | null) => `"${(s ?? "").trim()}"`;
  switch (intent.action) {
    case "scroll":
      return `scroll to ${q(intent.target)}`;
    case "read":
      return `read ${q(intent.target)}`;
    case "click":
      return `click ${q(intent.target)}`;
    case "fill":
      return `fill ${q(intent.target)} with ${q(intent.value)}`;
    case "back":
      return "go back";
    case "finish":
      return `finish: ${intent.finish ?? "?"}`;
  }
}
