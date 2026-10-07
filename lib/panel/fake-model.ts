// ShapesOS — Phase 19B (WS=panel): the FAKE model (labelled; tests and smoke only).
// Commercial layer (entitlement dress_rehearsal). Licence boundary: CONTRIBUTING.md (open vs commercial; company-authored).
//
// A deterministic stand-in for the router so the whole pipeline (derive →
// walk → verdict → report) can run without a model: unit tests, the DB
// end-to-end suite and the browser smoke (PANEL_FAKE_MODEL=1, refused in
// production). It is a MockLlmProvider whose chat() answers each structured
// tool from the prompt text with simple rules — it copies interview sentences
// and page text verbatim, so quote tracing is exercised for real. It is NEVER
// a real persona: every run that uses it is labelled "Fake model" in the
// report, and the router never meters it (nothing was spent). Its usage is
// priced at FAKE_MODEL_PRICED_AS so the credit cap and estimate paths run
// exactly as they would live.

import { MockLlmProvider } from "@/lib/llm/mock";
import type { ChatRequest, ChatResponse } from "@/lib/llm/types";
import { sentences } from "./trace";

export const FAKE_MODEL_LABEL = "Fake model (deterministic test model — no AI model was called)";
/** The fake's usage is priced like this router model so cap maths stay real. */
export const FAKE_MODEL_PRICED_AS = "claude-haiku-4-5";

/** May the fake model be used here? Never in production. */
export function fakeModelAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.PANEL_FAKE_MODEL === "1" && env.NODE_ENV !== "production";
}

const OBJECTION_CUE = /(don'?t believe|too expensive|non-starter|worried|hate|annual|hidden|not sure|can'?t afford|over my budget|took (three|two|\d+) weeks|promised|surprise|no way|refuse)/i;
const LENS_CUES: Record<string, RegExp> = {
  "price-skeptic": /(\$\d|price|pricing|cost|budget|month|annual|afford|cfo)/i,
  "workflow-fit": /(workflow|spreadsheet|tool|hours|process|monday|report|onboard)/i,
  "trust-auditor": /(trust|believe|promise|claim|vendor|burn|support)/i,
  "competitor-comparer": /(looked at|competitor|switch|alternative|instead|acme|other tool)/i,
};

/** Speaker turns, one per line. Memory chunks are word-joined, so turns are split inline on "Name:" too. */
function speakerLines(text: string): string[] {
  return text
    .replace(/\s(?=(?:Interviewer|[A-Z][\w.'-]*(?: [A-Z][\w.'-]*)?):\s)/g, "\n")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^interviewer\s*:/i.test(l) && !/^\[(chunk|reflection)/i.test(l) && !/^(TRANSCRIPT ID|INTERVIEWEE|EVIDENCE CHUNKS)/i.test(l))
    .map((l) => l.replace(/^[A-Z][\w .'-]{0,40}:\s*/, ""));
}

function interviewSentences(text: string): string[] {
  return speakerLines(text).flatMap((l) => sentences(l)).filter((s) => s.split(/\s+/).length >= 4);
}

function words(s: string, n: number): string {
  return s.split(/\s+/).slice(0, n).join(" ");
}

interface PersonaState {
  headings: string[];
  actions: string[];
  stage: number;
}

/** The deterministic answers, by tool name. Exported for tests. */
export function fakeToolAnswer(req: ChatRequest, states: Map<string, PersonaState>): Record<string, unknown> {
  const tool = req.tools?.[0]?.name ?? "";
  const system = typeof req.system === "string" ? req.system : (req.system ?? []).map((b) => b.text).join("\n");
  const user = req.messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");

  if (tool === "submit_observations") {
    const lens = Object.entries(LENS_CUES).find(([id]) => system.includes(id.split("-")[0]!)) ?? Object.entries(LENS_CUES)[0]!;
    const picks = interviewSentences(user).filter((s) => lens[1].test(s));
    return { observations: picks.slice(0, 20).map((s) => words(s, 25)) };
  }

  if (tool === "submit_persona") {
    const tid = /TRANSCRIPT ID:\s*(\S+)/.exec(user)?.[1] ?? "unknown";
    const name = /INTERVIEWEE:\s*(.+)/.exec(user)?.[1]?.trim();
    const all = interviewSentences(user);
    const role = /I'?m (?:the |an? )?([a-z][a-z ]{2,30}?) (?:at|for|of)\b/i.exec(user)?.[1]?.trim() ?? "Customer";
    const dollars = [...user.matchAll(/\$(\d{1,6})/g)].map((m) => Number(m[1]));
    const over = /(?:over|above|more than|under|below)\s*\$(\d{1,6})/i.exec(user);
    const monthlyMax = over ? Number(over[1]) : dollars.length ? Math.max(...dollars) : 100;
    const hardCap = /\b(never|hard cap|can'?t go (above|over)|self-funded|my own money)\b/i.test(user);
    const objections = all.filter((s) => OBJECTION_CUE.test(s)).slice(0, 4);
    const skeptic = (user.match(/\b(don'?t believe|promised|burn|lie|skeptic|non-starter)/gi) ?? []).length;
    const goals = all.filter((s) => /\b(I need|I want|looking for|we need)\b/i.test(s)).slice(0, 3);
    return {
      identity: { name: name && name !== "unknown" ? name : "Interviewee", role: role.replace(/\b\w/g, (c) => c.toUpperCase()) },
      goals: goals.length ? goals.map((g) => words(g, 20)) : ["find a tool that fits how they work"],
      occupation: role.replace(/\b\w/g, (c) => c.toUpperCase()),
      bigFive: { openness: 0.5, conscientiousness: 0.6, extraversion: 0.4, agreeableness: 0.5, neuroticism: 0.4 },
      preferences: { likes: [], dislikes: objections.slice(0, 2).map((o) => words(o, 8)), interests: [] },
      skills: [],
      beliefs: all.filter((s) => /\b(believe|think|always|never)\b/i.test(s)).slice(0, 2),
      behaviors: { general: [], routines: [] },
      budget: { currency: "USD", monthlyMax, hardCap },
      skepticism: Math.min(0.95, 0.4 + 0.15 * skeptic),
      knownObjections: objections.map((o) => ({ text: o, severity: /non-starter|don'?t believe|never|refuse/i.test(o) ? "high" : "medium", sourceTranscriptId: tid })),
      sourceTranscriptIds: [tid],
    };
  }

  if (tool === "submit_step") {
    const key = system.slice(0, 400);
    const st = states.get(key) ?? { headings: [], actions: [], stage: 0 };
    states.set(key, st);
    const last = /\[Last observation\] \((\w[\w-]*)\) ([\s\S]*)$/.exec(user);
    const type = last?.[1] ?? "landed";
    const text = (last?.[2] ?? "").trim();
    if (type === "landed") {
      st.headings = [...(/Section headings: (.*?)\.(?: Buttons|$| Form)/.exec(text)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
      st.actions = [...(/Buttons and links: (.*?)\.(?: Form|$)/.exec(text)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    }
    const budget = Number(/up to [A-Z]{3} (\d+)\/month/.exec(system)?.[1] ?? "100");
    const hardCap = /HARD CAP/.test(system);
    const objection = /Objections you hold from past experience: (.+)/.exec(system)?.[1]?.split(" | ")[0] ?? "";
    st.stage += 1;
    if (type === "landed" || st.stage === 1) {
      const target = st.headings.find((h) => /pric/i.test(h)) ?? st.headings[0] ?? "#main";
      return { thinkAloud: `I want to see what this costs before anything else. ${objection}`.trim(), intent: { action: "read", target, value: null, finish: null } };
    }
    if (type === "read" || type === "scrolled") {
      const price = Number(/\$(\d{1,6})/.exec(text)?.[1] ?? "0");
      const annual = /annual|billed yearly|per year/i.test(text);
      const firstSentence = sentences(text)[0] ?? text.slice(0, 120);
      if ((hardCap && price > budget) || (annual && hardCap)) {
        return { thinkAloud: `The page says: "${words(firstSentence, 30)}". That is more than my hard cap of $${budget} a month. ${objection}`.trim(), intent: { action: "finish", target: null, value: null, finish: "bounced" } };
      }
      if (price > budget) {
        return { thinkAloud: `"${words(firstSentence, 30)}" — above the $${budget} a month I planned. Not sure it's worth it; I've seen enough for now.`, intent: { action: "finish", target: null, value: null, finish: "goal-complete" } };
      }
      const cta = st.actions.find((a) => /trial|start|choose|sign|get started|buy/i.test(a));
      if (cta) return { thinkAloud: `"${words(firstSentence, 30)}" — that fits my budget of $${budget} a month. Let me try it.`, intent: { action: "click", target: cta, value: null, finish: null } };
      return { thinkAloud: "I can't find a way to sign up.", intent: { action: "finish", target: null, value: null, finish: "goal-complete" } };
    }
    if (type === "clicked") return { thinkAloud: "The signup is right here. I would go ahead with the trial.", intent: { action: "finish", target: null, value: null, finish: "checkout-attempted" } };
    return { thinkAloud: "I couldn't find what I was looking for, so I'm leaving.", intent: { action: "finish", target: null, value: null, finish: "bounced" } };
  }

  if (tool === "submit_judgement") return { passed: true, detail: "" };

  if (tool === "submit_verdict") {
    const outcome = /Outcome: ([\w-]+)/.exec(user)?.[1] ?? "step-capped";
    const verdict = outcome === "checkout-attempted" ? "buy" : outcome === "bounced" ? "no-buy" : "maybe";
    const evidence = [...user.matchAll(/^\[E\d+ \| ([^|\]]+)(?:\|[^\]]*)?\] (.+)$/gm)].map((m) => ({ section: m[1]!.trim(), text: m[2]! }));
    const objections = evidence
      .flatMap((e) => sentences(e.text).filter((s) => OBJECTION_CUE.test(s) || /more than my|above the/.test(s)).map((s) => ({ quote: words(s, 30), section: e.section, severity: verdict === "no-buy" ? "high" : "medium" })))
      .slice(0, 3);
    return {
      verdict,
      confidence: verdict === "maybe" ? 0.5 : 0.7,
      rationale: `Read off the walk: it ended ${outcome}.`,
      objections,
      whatWouldChangeMind: verdict === "buy" ? [] : ["A price and billing terms that fit the budget, stated plainly"],
      behaviorSummary: `Walk ended ${outcome}.`,
    };
  }

  if (tool === "submit_fix") {
    const quote = /"([^"]+)"/.exec(user)?.[1] ?? "this objection";
    return { suggestedFix: `Answer "${words(quote, 12)}" on the page itself, next to the section where it came up.`, expectedImpact: "medium" };
  }
  return {};
}

/** A MockLlmProvider answering every panel tool deterministically, priced as FAKE_MODEL_PRICED_AS. */
export function createFakePanelProvider(opts: { model?: string; onCall?: (req: ChatRequest) => void } = {}): MockLlmProvider {
  const states = new Map<string, PersonaState>();
  let n = 0;
  return new MockLlmProvider({
    chatScript: [
      (req): Partial<ChatResponse> => {
        opts.onCall?.(req);
        const input = fakeToolAnswer(req, states);
        const promptChars = JSON.stringify(req.messages).length + (typeof req.system === "string" ? req.system.length : 0);
        n += 1;
        return {
          id: `fake_${n}`,
          content: [{ type: "tool_use", id: `fake_tool_${n}`, name: req.tools?.[0]?.name ?? "unknown", input }],
          stopReason: "tool_use",
          model: opts.model ?? FAKE_MODEL_PRICED_AS,
          usage: { inputTokens: Math.ceil(promptChars / 4), outputTokens: Math.ceil(JSON.stringify(input).length / 4), cacheReadTokens: 0, cacheWriteTokens: 0 },
          meta: { serverToolsSent: [], notes: ["FAKE MODEL: deterministic test model, no AI model was called."] },
        };
      },
    ],
  });
}
