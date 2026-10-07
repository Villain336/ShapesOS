// ShapesOS — Phase 19B (WS=panel): per-persona friction timelines.
// Commercial layer (entitlement dress_rehearsal). Licence boundary: CONTRIBUTING.md (open vs commercial; company-authored).
//
// Ported from the prototype's src/reporting/timeline.ts: the walk's steps and
// behaviour signals become a scrubbable timeline — where attention died,
// where confusion spiked, where the persona bounced. Every rule is
// deterministic (no model, no cost):
//   1 rage-click bursts → friction        4 dwell > 2× expected reading time → friction
//   2 hover > 3 s without a click → friction   5 failed in-character check → friction
//   3 not-found / unparsed → friction      6 the bounced run's last step → critical
// Per-section rollups feed the panel report's section heat.
//
// Changed: screenshots are blob refs (the walk uploads them as it goes), so
// there is no local-disk artifact step; the prototype's static HTML renderer
// is replaced by the dashboard's React view; cap-stopped and failed walks get
// a timeline too (their last step is marked, not counted as a bounce).

import { describeIntent } from "./intents";
import type { Observation } from "./pagemaster";
import type { WalkthroughResult, WalkthroughStep } from "./walk";

export type TimelineEventKind = "intent" | "thought" | "observation" | "signal" | "flag";
export type TimelineSeverity = "info" | "friction" | "critical";

const KIND_ORDER: Record<TimelineEventKind, number> = { intent: 0, thought: 1, observation: 2, signal: 3, flag: 4 };

export interface TimelineEvent {
  /** ms from the walk's first step. */
  t: number;
  stepIndex: number;
  kind: TimelineEventKind;
  section?: string;
  summary: string;
  detail?: string;
  /** Blob ref of the related screenshot. */
  screenshotRef?: string;
  severity: TimelineSeverity;
}

export interface SectionRollup {
  name: string;
  totalDwellMs: number;
  visits: number;
  frictionCount: number;
  maxScrollDepth: number;
}

export interface FrictionTimeline {
  version: "1.0.0";
  runId: string;
  personaKey: string;
  personaName: string;
  outcome: WalkthroughResult["outcome"];
  runDurationMs: number;
  events: TimelineEvent[];
  sections: SectionRollup[];
  frictionCount: number;
  criticalCount: number;
}

/** Same reading model as humanDwellMs (220 wpm), unclamped. */
export function expectedReadingMs(textExcerpt: string): number {
  const words = textExcerpt.trim().split(/\s+/).filter(Boolean).length;
  return Math.round((words / 220) * 60_000);
}

const ATTENTION_MIN_WORDS = 25;
const ATTENTION_MULTIPLIER = 2;
const HESITATION_HOVER_MS = 3_000;

function truncate(s: string, max = 220): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function sectionOf(o: Observation): string {
  return o.sectionMeta?.heading ?? o.sectionMeta?.sectionId ?? "(page)";
}

function detectFriction(step: WalkthroughStep): Array<Omit<TimelineEvent, "t">> {
  const section = sectionOf(step.observation);
  const s = step.signals;
  const shot = step.observation.screenshotRef;
  const out: Array<Omit<TimelineEvent, "t">> = [];
  const ev = (e: Omit<TimelineEvent, "t" | "stepIndex" | "section">) => out.push({ stepIndex: step.stepIndex, section, ...e });

  if (s.rageClickBursts > 0) {
    ev({ kind: "signal", summary: `Rage-click burst${s.rageClickBursts > 1 ? `s ×${s.rageClickBursts}` : ""} (${s.clicks} clicks this step)`, detail: "3+ clicks within 800ms on the same target — a classic frustration signal.", screenshotRef: shot, severity: "friction" });
  }
  if (s.hoverDwellMs > HESITATION_HOVER_MS && s.clicks === 0) {
    ev({ kind: "signal", summary: `Hesitation: ${(s.hoverDwellMs / 1000).toFixed(1)}s hovering without clicking`, detail: "The persona lingered on an interactive element but never committed — a conversion chokepoint.", screenshotRef: shot, severity: "friction" });
  }
  if (step.observation.type === "not-found" || step.observation.type === "unparsed") {
    ev({
      kind: "signal",
      summary: step.observation.type === "not-found" ? "Confusion: couldn't find what they were looking for" : "Confusion: intent unparsed — no clear path",
      detail: truncate(step.observation.detail ?? step.observation.textExcerpt ?? describeIntent(step.intent), 300),
      severity: "friction",
    });
  }
  const words = step.observation.textExcerpt.trim().split(/\s+/).filter(Boolean).length;
  if (words >= ATTENTION_MIN_WORDS) {
    const expected = expectedReadingMs(step.observation.textExcerpt);
    if (expected > 0 && s.dwellMs > ATTENTION_MULTIPLIER * expected) {
      ev({
        kind: "signal",
        summary: `Attention died: ${(s.dwellMs / 1000).toFixed(0)}s on ~${words} words (≈${(s.dwellMs / expected).toFixed(1)}× expected read time)`,
        detail: `Dwell ${s.dwellMs}ms vs expected ${expected}ms at 220 wpm. They stalled — unclear next action or disengaged.`,
        screenshotRef: shot,
        severity: "friction",
      });
    }
  }
  for (const flag of step.flags) {
    if (!flag.passed) ev({ kind: "flag", summary: `In-character check failed: ${flag.check}`, detail: flag.detail, severity: "friction" });
  }
  return out;
}

export function buildTimeline(result: WalkthroughResult): FrictionTimeline {
  const steps = result.steps;
  const runStart = steps[0]?.startedAt ?? 0;
  const runEnd = steps[steps.length - 1]?.endedAt ?? runStart;
  const events: TimelineEvent[] = [];

  steps.forEach((step, i) => {
    const t = Math.max(0, step.startedAt - runStart);
    const section = sectionOf(step.observation);
    const obs = step.observation;
    events.push({ t, stepIndex: step.stepIndex, kind: "intent", section, summary: truncate(describeIntent(step.intent)), severity: "info" });
    if (step.thinkAloud.trim()) events.push({ t, stepIndex: step.stepIndex, kind: "thought", section, summary: "Think-aloud", detail: truncate(step.thinkAloud, 600), severity: "info" });
    events.push({
      t,
      stepIndex: step.stepIndex,
      kind: "observation",
      section,
      summary: obs.type === "not-found" || obs.type === "unparsed" ? `${obs.type}: ${truncate(obs.detail ?? describeIntent(step.intent), 160)}` : `${obs.type}${obs.finishSignal ? ` (${obs.finishSignal})` : ""}`,
      ...(obs.textExcerpt ? { detail: truncate(obs.textExcerpt, 400) } : {}),
      ...(obs.screenshotRef ? { screenshotRef: obs.screenshotRef } : {}),
      severity: "info",
    });
    for (const f of detectFriction(step)) events.push({ ...f, t });
    const last = i === steps.length - 1;
    if (last && result.outcome === "bounced") {
      events.push({
        t,
        stepIndex: step.stepIndex,
        kind: "signal",
        section,
        summary: `Bounced at ${result.signals.dropOff.url}`,
        detail: `The persona left the page here${result.signals.dropOff.section ? ` (section: ${result.signals.dropOff.section})` : ""}. Max scroll depth: ${result.signals.maxScrollDepthPct}%.`,
        ...(obs.screenshotRef ? { screenshotRef: obs.screenshotRef } : {}),
        severity: "critical",
      });
    }
    if (last && (result.outcome === "cap-stopped" || result.outcome === "failed")) {
      events.push({
        t,
        stepIndex: step.stepIndex,
        kind: "signal",
        section,
        summary: result.outcome === "cap-stopped" ? "Stopped at the run's credit cap" : "Walk stopped by an error",
        ...(result.stopReason ? { detail: truncate(result.stopReason, 300) } : {}),
        severity: "info",
      });
    }
  });

  events.sort((a, b) => a.t - b.t || a.stepIndex - b.stepIndex || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  const bySection = new Map<string, SectionRollup>();
  for (const step of steps) {
    const name = sectionOf(step.observation);
    const roll = bySection.get(name) ?? { name, totalDwellMs: 0, visits: 0, frictionCount: 0, maxScrollDepth: 0 };
    roll.totalDwellMs += step.signals.dwellMs;
    roll.visits += 1;
    roll.maxScrollDepth = Math.max(roll.maxScrollDepth, step.signals.scrollDepthPct);
    bySection.set(name, roll);
  }
  for (const e of events) {
    if ((e.severity === "friction" || e.severity === "critical") && e.section !== undefined) {
      const roll = bySection.get(e.section);
      if (roll) roll.frictionCount += 1;
    }
  }

  return {
    version: "1.0.0",
    runId: result.runId,
    personaKey: result.personaKey,
    personaName: result.personaName,
    outcome: result.outcome,
    runDurationMs: Math.max(0, runEnd - runStart),
    events,
    sections: [...bySection.values()].sort((a, b) => b.totalDwellMs - a.totalDwellMs),
    frictionCount: events.filter((e) => e.severity === "friction").length,
    criticalCount: events.filter((e) => e.severity === "critical").length,
  };
}
