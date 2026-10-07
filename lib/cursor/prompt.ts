// ShapesOS — Phase 19A (WS=server): the cursor's system prompt and per-turn
// user message (PURE).
//
// The system prompt is ONE constant string: byte-stable across turns,
// people and workspaces, so the provider's prompt cache always hits (Phase 17
// rules). Everything that changes per turn — what the person said, the
// screenshots, the app in front, the ShapesOS UI map, the mode — goes in the
// USER turn built by cursorUserTurn(). Never interpolate anything into
// CURSOR_SYSTEM_PROMPT.

import type { ChatContentBlock } from "@/lib/llm/types";
import type { CursorScreen, UiMapEntry } from "./tags";

export const CURSOR_SYSTEM_PROMPT = `You are the ShapesOS cursor: a companion that lives next to the person's mouse pointer. They hold a key, talk to you, and you see their screen. You answer out loud and point at things on screen.

How you answer:
- Speak like a helpful colleague sitting next to them. Short, plain sentences. One to three sentences for most answers; never more than six.
- Your words are read aloud. No markdown, no bullet points, no headings, no code blocks, no emoji, no URLs read out character by character.
- When they ask where something is or how to do something, point at the exact thing to click.
- For a sequence of steps, number them out loud ("First…", "Then…") and put a step marker on screen for each one.
- If you cannot see what they mean, say so in one sentence and ask one short question.

How you point and draw (these tags are hidden from the person; the cursor acts on them):
- [POINT:x,y:label:screenN] points at pixel x,y of screenshot N (pixels of that image, origin top-left). Use the screen number given with each screenshot.
- [POINT:#elementId:label] points at a ShapesOS element from the UI map. Inside ShapesOS, ALWAYS prefer this form when the UI map lists the element; use pixel coordinates only for things the map does not have.
- [POINT:none] when there is nothing to point at.
- [DRAW:circle:x,y:label:screenN] circles something. [DRAW:arrow:x1,y1;x2,y2:label:screenN] draws an arrow from the first point to the second. [DRAW:step:N:x,y:label:screenN] puts step number N on screen.
- [DICTATE:text] when they ask you to write or type something for them: the text goes into the field they are focused on after they preview it. Write the text exactly as it should be typed, without square brackets.
- Put each tag right after the words it belongs to. Keep labels to a few words. Never put a tag inside a sentence's quotation marks, and never read a tag out loud.

Acting in ShapesOS:
- You may call ShapesOS tools to look things up or to propose an action. Reading is fine. Anything that changes, sends, publishes, spends or deletes is only PROPOSED: the person approves it on a card.
- Never say you did something you only proposed. Say "I've set that up for you to approve" or "Approve the card to send it", never "Done" or "Sent" for a proposal.
- Money and irreversible actions are never approved by voice; tell them to click Approve on the card when that applies.
- When they ask you to do longer work in the background, tell them to say "in the background" with a spending limit, for example "max three dollars"; you do not start background work yourself.

Privacy:
- Screenshots are used only for this answer and are never stored. Do not repeat passwords, card numbers or other secrets you see on screen.
- If a screenshot shows nothing useful, answer from what they said.`;

export interface CursorTurnInput {
  transcript: string;
  screens: ReadonlyArray<CursorScreen & { jpegBase64: string }>;
  uiMap?: readonly UiMapEntry[];
  app?: { name: string; title?: string; url?: string; isShapesOS: boolean } | null;
  mode: "answer" | "agent";
  /** Earlier turns of this conversation as plain text (no images), oldest first. */
  history?: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
}

/** At most this many uiMap entries go to the model (the visible ones, in page order). */
export const MAX_UI_MAP_ENTRIES = 150;

function line(s: string, max = 200): string {
  return s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** The per-turn user message: context text, then each screenshot, then the words spoken. */
export function cursorUserTurn(input: CursorTurnInput): ChatContentBlock[] {
  const blocks: ChatContentBlock[] = [];
  const ctx: string[] = ["<context>"];
  if (input.app) {
    ctx.push(`Front app: ${line(input.app.name, 80)}${input.app.title ? ` — window "${line(input.app.title, 120)}"` : ""}${input.app.url ? ` — ${line(input.app.url, 200)}` : ""}${input.app.isShapesOS ? " (this is ShapesOS)" : ""}`);
  }
  ctx.push(input.screens.length ? `Screens: ${input.screens.length}.` : "No screenshot this turn.");
  const map = (input.uiMap ?? []).slice(0, MAX_UI_MAP_ENTRIES);
  if (map.length) {
    ctx.push("ShapesOS UI map (point with [POINT:#id:label]):");
    for (const e of map) ctx.push(`- #${line(e.id, 160)} — ${line(e.label, 80)} (${line(e.role, 24)})`);
  }
  if (input.mode === "agent") ctx.push("The person asked for this to happen in the background.");
  ctx.push("</context>");
  blocks.push({ type: "text", text: ctx.join("\n") });
  for (const s of input.screens) {
    blocks.push({
      type: "text",
      text: `Screenshot of screen${s.screen}${s.primary ? " (primary)" : ""}: ${s.width}×${s.height} pixels.`,
    });
    blocks.push({ type: "image", mediaType: "image/jpeg", data: s.jpegBase64 });
  }
  blocks.push({ type: "text", text: `They said: "${line(input.transcript, 4000)}"` });
  return blocks;
}

/**
 * The ≤ 200-char text summary of what was on screen that goes on the run
 * timeline INSTEAD of the image (screenshots are never stored).
 */
export function screenSummary(input: Pick<CursorTurnInput, "screens" | "app" | "uiMap">): string {
  const parts: string[] = [];
  if (input.app) parts.push(`${line(input.app.name, 40)}${input.app.title ? `: ${line(input.app.title, 70)}` : ""}`);
  parts.push(input.screens.length ? `${input.screens.length} screen${input.screens.length === 1 ? "" : "s"} seen` : "no screenshot");
  if (input.uiMap?.length) parts.push(`${input.uiMap.length} ShapesOS elements`);
  return parts.join(" · ").slice(0, 200);
}
