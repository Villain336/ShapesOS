// ShapesOS — Phase 19B (WS=engine): the FAKE town model (labelled; tests,
// the DB end-to-end suite and the browser smoke only).
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// A MockLlmProvider that answers the five town decision tools from the FACTS
// line of the prompt with the same arithmetic as the rules decider, so a whole
// run exercises the real model path — the panel's RouterPanelModel
// (structured output, schema check), the PanelLedger cap reservations and the
// decision cache — without calling any AI model. It is never a real
// resident: runs that use it say "Fake model" (FAKE_MODEL_LABEL) in the UI
// and the report, and the router never meters it. Its usage is priced like
// FAKE_MODEL_PRICED_AS so the cap and estimate paths run exactly as live.
// Allowed only where the panel allows its own fake (PANEL_FAKE_MODEL=1,
// never in production — lib/panel/fake-model.ts fakeModelAllowed).

import { MockLlmProvider } from "@/lib/llm/mock";
import type { ChatRequest, ChatResponse } from "@/lib/llm/types";
import { FAKE_MODEL_PRICED_AS } from "@/lib/panel/fake-model";
import { RouterPanelModel, type PanelModel } from "@/lib/panel/model";
import type { PanelLedger } from "@/lib/panel/budget";
import { DECISION_TOOLS, ruleDecision, type DecisionFacts, type DecisionPoint } from "./decisions";
import { hash32 } from "./rng";

const TOOL_POINT: Record<string, DecisionPoint> = Object.fromEntries(Object.entries(DECISION_TOOLS).map(([p, t]) => [t.name, p as DecisionPoint]));

interface FactsLine {
  point: DecisionPoint;
  product: string;
  price: number;
  budgetLeft: number;
  money: number;
  interest: number;
  adopted: boolean;
  discount: number;
  traits: DecisionFacts["traits"];
  relation: "friend" | "family" | null;
  impression: string | null;
  objection: string | null;
}

/** The deterministic answer to one town tool call (exported for tests). */
export function fakeTownAnswer(req: ChatRequest): Record<string, unknown> {
  const user = req.messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
  const point = TOOL_POINT[req.tools?.[0]?.name ?? ""];
  const m = /^FACTS (\{.*\})$/m.exec(user);
  if (!point || !m) return {};
  const f = JSON.parse(m[1]!) as FactsLine;
  const today = /Today: (.*)$/m.exec(user)?.[1] ?? "";
  const facts: DecisionFacts = {
    residentId: "fake",
    residentName: "",
    segment: "",
    persona: f.objection ? { name: "", occupation: "", goals: [], knownObjections: [f.objection] } : null,
    calibrated: false,
    traits: f.traits,
    moneyCents: f.money,
    productBudgetLeftCents: f.budgetLeft,
    interest: f.interest,
    adopted: f.adopted,
    product: { name: f.product, category: "", priceCents: f.price, description: "" },
    effectivePriceCents: f.price,
    discountPct: f.discount,
    weather: "",
    when: "",
    stimulus: { relation: f.relation ?? undefined, impression: f.impression ?? undefined, experiences: today ? [today] : [] },
    memories: [],
  };
  const answer = ruleDecision(point, facts, `fake:${hash32(user)}`) as unknown as Record<string, unknown>;
  if (point === "reflect") answer.summary = `(fake model) ${String(answer.summary).slice(0, 560)}`;
  return answer;
}

/** A MockLlmProvider answering the town tools deterministically, priced as FAKE_MODEL_PRICED_AS. */
export function createFakeTownProvider(opts: { onCall?: (req: ChatRequest) => void } = {}): MockLlmProvider {
  let n = 0;
  return new MockLlmProvider({
    chatScript: [
      (req): Partial<ChatResponse> => {
        opts.onCall?.(req);
        const input = fakeTownAnswer(req);
        const promptChars = JSON.stringify(req.messages).length + (typeof req.system === "string" ? req.system.length : 0);
        n += 1;
        return {
          id: `fake_town_${n}`,
          content: [{ type: "tool_use", id: `fake_town_tool_${n}`, name: req.tools?.[0]?.name ?? "unknown", input }],
          stopReason: "tool_use",
          model: FAKE_MODEL_PRICED_AS,
          usage: { inputTokens: Math.ceil(promptChars / 4), outputTokens: Math.ceil(JSON.stringify(input).length / 4), cacheReadTokens: 0, cacheWriteTokens: 0 },
          meta: { serverToolsSent: [], notes: ["FAKE MODEL: deterministic test model, no AI model was called."] },
        };
      },
    ],
  });
}

/** The fake town model on the panel's model seam (capped by `ledger`). */
export function fakeTownModel(ledger: PanelLedger, opts: { onCall?: (req: ChatRequest) => void } = {}): PanelModel {
  return new RouterPanelModel(createFakeTownProvider(opts), FAKE_MODEL_PRICED_AS, ledger, { kind: "fake" });
}
