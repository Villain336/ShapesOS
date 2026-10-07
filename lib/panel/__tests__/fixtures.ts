// ShapesOS — Phase 19B (WS=panel): shared test fixtures for lib/panel tests.
// FakeWalkPage is a labelled fake of the browser (a system boundary): a
// landing page described as data, so the walk loop runs without Chromium.
// The real browser runs in lib/panel/__tests__/browser-db.test.ts.

import type { PersonaSpec } from "../persona";
import type { PageOutline, SectionHit, WalkPage } from "../pagemaster";
import type { Observation } from "../pagemaster";
import { emptyTrackerState, type TrackerState } from "../tracker";
import type { StepSignals, WalkthroughOutcome, WalkthroughResult, WalkthroughStep } from "../walk";

export function validSpec(over: Partial<PersonaSpec> = {}): PersonaSpec {
  return {
    identity: { name: "Dana Reyes", role: "Ops Manager", company: "Acme Co", age: 34 },
    goals: ["cut reporting time", "get team buy-in"],
    occupation: "Operations Manager",
    bigFive: { openness: 0.6, conscientiousness: 0.8, extraversion: 0.4, agreeableness: 0.5, neuroticism: 0.3 },
    preferences: { likes: ["dashboards"], dislikes: ["spreadsheets"], interests: ["automation"] },
    skills: ["excel", "stakeholder management"],
    beliefs: ["data beats opinions"],
    behaviors: { general: ["reads docs first"], routines: ["checks metrics Mondays"] },
    budget: { currency: "USD", monthlyMax: 200, hardCap: false },
    skepticism: 0.5,
    knownObjections: [{ text: "Too expensive for our team size", severity: "medium" }],
    sourceTranscriptIds: ["t1"],
    ...over,
  };
}

export const SKEPTIC: PersonaSpec = validSpec({
  identity: { name: "Dana Skeptic", role: "Operations Manager" },
  goals: ["find an affordable project management tool"],
  bigFive: { openness: 0.5, conscientiousness: 0.6, extraversion: 0.4, agreeableness: 0.5, neuroticism: 0.3 },
  preferences: { likes: [], dislikes: ["vague pricing"], interests: [] },
  skills: ["spreadsheets"],
  beliefs: ["Tools should prove value before I pay"],
  behaviors: { general: ["compares options carefully"], routines: [] },
  budget: { currency: "USD", monthlyMax: 100, hardCap: false },
  skepticism: 0.7,
  knownObjections: [{ text: "I don't trust 'setup in minutes' claims.", severity: "high", sourceTranscriptId: "t1" }],
  sourceTranscriptIds: ["t1"],
});

export const INTERVIEW_TEXT = [
  "Interviewer: Tell me about how reporting works for you today.",
  "Priya Nair: I'm the ops manager at a 40-person logistics company. Every Monday I spend about three hours stitching together spreadsheets from three different systems.",
  "Interviewer: What does that cost you?",
  "Priya Nair: We pay $49 a month for a dashboard tool, but honestly the real cost is my time. Onboarding took my team two full weeks of spreadsheet cleanup.",
  "Interviewer: What would make you switch?",
  "Priya Nair: I need something that actually connects to our warehouse system without a consultant. And anything over $100 a month needs our CFO to sign off.",
  "Interviewer: Any bad experiences with vendors?",
  "Priya Nair: Oh yes. Our last vendor promised setup in five minutes. It took three weeks and two support tickets. I don't believe setup-time claims anymore.",
  "Interviewer: What else did you consider?",
  "Priya Nair: We looked at Acme Analytics but their per-seat pricing would have been $300 a month for our team. Total non-starter.",
].join("\n");

// ---------------------------------------------------------------------------
// Fabricated walk results (timeline / verdict / aggregate tests)
// ---------------------------------------------------------------------------

export function mkSignals(over: Partial<StepSignals> = {}): StepSignals {
  return { dwellMs: 1000, modelMs: 0, scrollDepthPct: 20, clicks: 0, rageClickBursts: 0, hoverDwellMs: 200, url: "https://example.com/", ...over };
}

export function mkObs(over: Partial<Observation> = {}): Observation {
  return { type: "scrolled", textExcerpt: "some page text", url: "https://example.com/", ...over };
}

export function mkStep(i: number, over: Partial<WalkthroughStep> = {}): WalkthroughStep {
  return {
    stepIndex: i,
    startedAt: 1000 + i * 10_000,
    endedAt: 1000 + i * 10_000 + 1000,
    intent: { action: "read", target: `section ${i}`, value: null, finish: null },
    thinkAloud: `thinking ${i}`,
    observation: mkObs(),
    signals: mkSignals(),
    flags: [],
    ...over,
  };
}

export function mkResult(outcome: WalkthroughOutcome, steps: WalkthroughStep[], runId = "run-v1", personaKey = "p-dana", personaName = "Dana Skeptic"): WalkthroughResult {
  const last = steps[steps.length - 1];
  return {
    runId,
    personaKey,
    personaName,
    outcome,
    steps,
    signals: {
      totalDwellMs: steps.reduce((s, x) => s + x.signals.dwellMs, 0),
      maxScrollDepthPct: 40,
      totalClicks: 0,
      rageClickBursts: 0,
      totalHoverDwellMs: 0,
      sectionsVisited: [],
      dropOff: { url: last?.observation.url ?? "https://example.com/", ...(last?.observation.sectionMeta?.heading ? { section: last.observation.sectionMeta.heading } : {}) },
      llmCalls: steps.length,
    },
  };
}

// ---------------------------------------------------------------------------
// FakeWalkPage — the "TaskTide" fixture landing page as data
// ---------------------------------------------------------------------------

export interface FakeSection {
  id: string;
  heading: string;
  text: string;
}

export interface FakePageSpec {
  url: string;
  title: string;
  sections: FakeSection[];
  /** name → anchor (#id) it navigates to; hidden buttons can't be clicked. */
  buttons: Array<{ name: string; href: string; hidden?: boolean }>;
  fields: string[];
}

export const TASKTIDE: FakePageSpec = {
  url: "https://landing-page.rehearsal.invalid/index.html",
  title: "TaskTide — Project management for small teams",
  sections: [
    { id: "hero", heading: "Ship projects faster with TaskTide", text: "Ship projects faster with TaskTide The project management tool your team will actually use. Set up in minutes — no credit card required." },
    { id: "features", heading: "Features", text: "Features Kanban boards Drag-and-drop boards. Timeline view See every deadline. One-click reports Weekly status reports." },
    { id: "pricing", heading: "Pricing", text: "Pricing Pro $49/mo Unlimited projects, unlimited team members, priority support. *Billed annually. $588 charged today. Monthly billing is not available on this plan. Choose Pro" },
    { id: "faq", heading: "FAQ", text: "FAQ Can I cancel anytime? You can cancel whenever you like — just contact support." },
    { id: "checkout", heading: "Start your free trial", text: "Start your free trial Full name Work email Complete signup" },
  ],
  buttons: [
    { name: "Start free trial", href: "#checkout" },
    { name: "See pricing", href: "#pricing" },
    { name: "Choose Pro", href: "#checkout" },
    { name: "Secret admin", href: "#hero", hidden: true },
  ],
  fields: ["Full name", "Work email"],
};

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

/** A fake browser page over FakePageSpec: deterministic, no Chromium. */
export class FakeWalkPage implements WalkPage {
  private history: string[];
  private tracker: TrackerState = emptyTrackerState();
  readonly filled = new Map<string, string>();

  constructor(private readonly spec: FakePageSpec = TASKTIDE) {
    this.history = [spec.url];
  }

  url(): string {
    return this.history[this.history.length - 1]!;
  }

  async outline(): Promise<PageOutline> {
    return { title: this.spec.title, headings: this.spec.sections.map((s) => s.heading), actions: this.spec.buttons.filter((b) => !b.hidden).map((b) => b.name), fields: this.spec.fields };
  }

  private find(target: string): FakeSection | undefined {
    const t = target.trim().toLowerCase();
    if (t.startsWith("#")) return this.spec.sections.find((s) => `#${s.id}` === t);
    return this.spec.sections.find((s) => s.heading.toLowerCase().includes(t));
  }

  async scrollTo(target: string): Promise<SectionHit | null> {
    const s = this.find(target);
    if (!s) return null;
    const idx = this.spec.sections.indexOf(s);
    this.tracker.maxScrollDepthPct = Math.max(this.tracker.maxScrollDepthPct, Math.round(((idx + 1) / this.spec.sections.length) * 100));
    this.tracker.sections[s.id] = { totalMs: 0, lastEnter: 0, views: 1 };
    return { heading: s.heading, sectionId: s.id, text: s.text };
  }

  async read(target: string): Promise<(SectionHit & { shot: Buffer | null }) | null> {
    const hit = await this.scrollTo(target);
    return hit ? { ...hit, shot: PNG } : null;
  }

  async click(name: string): Promise<{ status: "clicked" | "not-found" | "hidden"; shot: Buffer | null }> {
    const b = this.spec.buttons.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
    if (!b) return { status: "not-found", shot: null };
    if (b.hidden) return { status: "hidden", shot: null };
    this.tracker.clicks.push({ t: Date.now(), target: b.name, x: 0, y: 0 });
    this.history.push(`${this.spec.url.split("#")[0]}${b.href}`);
    return { status: "clicked", shot: PNG };
  }

  async fill(label: string, value: string): Promise<boolean> {
    if (!this.spec.fields.includes(label)) return false;
    this.filled.set(label, value);
    return true;
  }

  async goBack(): Promise<boolean> {
    if (this.history.length < 2) return false;
    this.history.pop();
    return true;
  }

  async trackerState(): Promise<TrackerState> {
    return structuredClone(this.tracker);
  }
}
