// ShapesOS — Phase 19B (WS=panel): the PageMaster (the page as the world).
// Commercial layer (entitlement dress_rehearsal). Licence boundary: CONTRIBUTING.md (open vs commercial; company-authored).
//
// Ported from the prototype's src/simulation/pagemaster.ts (Concordia-style
// game master): the persona emits an intent, the PageMaster resolves it into
// a grounded action against the real page and returns an observation. Page
// facts enter the persona's context ONLY through observations; a missing
// target is an honest "not-found" (never invented content) and an intent
// that can't be acted on is "unparsed".
//
// Changed: intents are structured (./intents.ts), not regex-parsed; the
// browser is behind the WalkPage interface (Playwright implementation in
// ./browser.server.ts, a fake in tests); screenshots go to blob storage via
// an injected saveShot (never to local disk); the persona also gets the
// page's real outline (title, headings, buttons, fields) when it lands, so
// it can name things that exist.

import { describeIntent, validateIntent, type FinishSignal, type Intent } from "./intents";
import type { TrackerState } from "./tracker";

export type ObservationType = "landed" | "scrolled" | "read" | "clicked" | "filled" | "went-back" | "finished" | "not-found" | "unparsed";

export interface SectionMeta {
  sectionId?: string;
  heading?: string;
  url: string;
}

export interface Observation {
  type: ObservationType;
  /** DOM-derived text only. Never invented. */
  textExcerpt: string;
  /** Blob ref of the screenshot taken for this observation (read / click). */
  screenshotRef?: string;
  sectionMeta?: SectionMeta;
  url: string;
  finishSignal?: FinishSignal;
  /** Human-readable detail for not-found / unparsed observations. */
  detail?: string;
}

export interface PageOutline {
  title: string;
  headings: string[];
  /** Visible buttons and links, by accessible name. */
  actions: string[];
  /** Form fields, by label. */
  fields: string[];
}

export interface SectionHit {
  heading: string;
  sectionId?: string;
  text: string;
}

/** What the PageMaster needs from a browser page. */
export interface WalkPage {
  url(): string;
  outline(): Promise<PageOutline>;
  /** Find a section by heading text (or "#id"), scroll it into view, return its text. */
  scrollTo(target: string): Promise<SectionHit | null>;
  /** scrollTo + a screenshot of the section. */
  read(target: string): Promise<(SectionHit & { shot: Buffer | null }) | null>;
  /** Click a button or link by accessible name. */
  click(name: string): Promise<{ status: "clicked" | "not-found" | "hidden"; shot: Buffer | null }>;
  /** Fill a form field by label. */
  fill(label: string, value: string): Promise<boolean>;
  /** History back; false when there is no previous page. */
  goBack(): Promise<boolean>;
  trackerState(): Promise<TrackerState>;
}

/** Stores a step screenshot; returns its blob ref. */
export type SaveShot = (stepIndex: number, verb: string, bytes: Buffer) => Promise<string>;

export interface ResolveIntentArgs {
  page: WalkPage;
  intent: Intent | null;
  stepIndex: number;
  saveShot?: SaveShot;
  /** Why there is no intent (the model's answer failed its schema). */
  unparsedReason?: string;
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function notFound(page: WalkPage, detail: string): Observation {
  return { type: "not-found", textExcerpt: detail, detail, url: page.url() };
}

async function store(saveShot: SaveShot | undefined, stepIndex: number, verb: string, bytes: Buffer | null): Promise<string | undefined> {
  if (!saveShot || !bytes) return undefined;
  try {
    return await saveShot(stepIndex, verb, bytes);
  } catch {
    // A failed upload loses one picture, never the step.
    return undefined;
  }
}

/** The first observation: where the persona landed, from the real DOM. */
export async function landingObservation(page: WalkPage): Promise<Observation> {
  const o = await page.outline();
  const lines = [
    `You landed on ${page.url()}.`,
    o.title ? `Page title: ${o.title}.` : "",
    o.headings.length ? `Section headings: ${o.headings.slice(0, 20).map((h) => `"${h}"`).join(", ")}.` : "No section headings found.",
    o.actions.length ? `Buttons and links: ${o.actions.slice(0, 20).map((a) => `"${a}"`).join(", ")}.` : "",
    o.fields.length ? `Form fields: ${o.fields.slice(0, 10).map((f) => `"${f}"`).join(", ")}.` : "",
  ].filter(Boolean);
  return { type: "landed", textExcerpt: lines.join(" "), url: page.url() };
}

/** Resolve one intent against the page. Never throws for a missing target. */
export async function resolveIntent(args: ResolveIntentArgs): Promise<Observation> {
  const { page, intent, stepIndex, saveShot } = args;
  const url = () => page.url();
  if (!intent) {
    const detail = `The PageMaster could not act on this step${args.unparsedReason ? ` (${args.unparsedReason})` : ""}. No page content was read or changed.`;
    return { type: "unparsed", textExcerpt: detail, detail, url: url() };
  }
  const problem = validateIntent(intent);
  if (problem) {
    const detail = `The PageMaster could not map the intent "${describeIntent(intent)}" to a page action (${problem}). No page content was read or changed.`;
    return { type: "unparsed", textExcerpt: detail, detail, url: url() };
  }
  const target = clean(intent.target ?? "");

  switch (intent.action) {
    case "finish": {
      const signal = intent.finish!;
      return { type: "finished", textExcerpt: `Persona signaled finish: ${signal}.`, url: url(), finishSignal: signal };
    }
    case "back": {
      const before = url();
      const ok = await page.goBack().catch(() => false);
      const after = url();
      return { type: "went-back", textExcerpt: ok ? `Went back from ${before} to ${after}.` : `No previous page in history; stayed at ${after}.`, url: after };
    }
    case "scroll": {
      const hit = await page.scrollTo(target);
      if (!hit) return notFound(page, `No section or heading matching "${target}" found on the page.`);
      return { type: "scrolled", textExcerpt: clean(hit.text).slice(0, 400), sectionMeta: { sectionId: hit.sectionId, heading: hit.heading, url: url() }, url: url() };
    }
    case "read": {
      const hit = await page.read(target);
      if (!hit) return notFound(page, `No section or heading matching "${target}" found on the page.`);
      const ref = await store(saveShot, stepIndex, "read", hit.shot);
      return {
        type: "read",
        textExcerpt: clean(hit.text).slice(0, 1500),
        ...(ref ? { screenshotRef: ref } : {}),
        sectionMeta: { sectionId: hit.sectionId, heading: hit.heading, url: url() },
        url: url(),
      };
    }
    case "click": {
      const r = await page.click(target);
      if (r.status === "not-found") return notFound(page, `No button or link named "${target}" found on the page.`);
      if (r.status === "hidden") return notFound(page, `"${target}" exists on the page but is not visible; it cannot be clicked.`);
      const ref = await store(saveShot, stepIndex, "click", r.shot);
      return { type: "clicked", textExcerpt: `Clicked "${target}". Current URL: ${url()}.`, ...(ref ? { screenshotRef: ref } : {}), url: url() };
    }
    case "fill": {
      const value = intent.value ?? "";
      const ok = await page.fill(target, value);
      if (!ok) return notFound(page, `No form field labeled "${target}" found on the page.`);
      // Typed values stay out of the record beyond their length (they may be personal).
      return { type: "filled", textExcerpt: `Filled "${target}" (${value.length} characters).`, url: url() };
    }
  }
}
