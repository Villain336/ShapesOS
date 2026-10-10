// ShapesOS — Phase 21A round 2 (WS=agentweb): running a taught flow (PURE over an actor).
//
// The runner never decides whether a step is allowed: the actor performs each step through the
// governed browser tools, whose page-aware gate (money, deletion and sign-in are the person's own
// act; sending and unclear steps ask) and the session gate (pause, take over, caps) apply in full.
// What the runner owns:
//   - finding each control again with self-healing locators (locate.ts);
//   - values: a parameter fills a field; a SENSITIVE one (password, card) is never typed by an
//     agent, supplied or not: the run stops there for the person;
//   - stopping for a "human check" instead of guessing: a control it cannot find, two equally good
//     matches, a step a gate sent to a person, a site that said no. It never retries around any of
//     those, and nothing after the stop runs.

import { originOf } from "../capabilities";
import type { ElementInfo } from "../types";
import { resolveLocator, type LocateHow } from "./locate";
import type { FlowSpec } from "./spec";
import { validateFlow } from "./spec";

export type ActorResult =
  | { ok: true }
  | { ok: false; kind: "needs_person" | "blocked_by_site" | "payment_required" | "stopped" | "error"; message: string };

export interface FlowActor {
  navigate(url: string): Promise<ActorResult>;
  /** The page's controls right now (refs valid for the next click/type). */
  controls(): Promise<ElementInfo[]>;
  click(ref: string): Promise<ActorResult>;
  type(ref: string, text: string): Promise<ActorResult>;
}

export type StopReason = "not_found" | "ambiguous" | "needs_person" | "sensitive_field" | "missing_param" | "blocked_by_site" | "payment_required" | "stopped" | "error" | "aborted" | "invalid";

export type FlowOutcome =
  | { status: "done"; stepsRun: number; healed: Array<{ step: number; how: LocateHow }> }
  | { status: "stopped"; at: number; stepsRun: number; reason: StopReason; message: string; candidates?: string[] };

export async function runFlow(raw: FlowSpec, params: Record<string, string>, actor: FlowActor, opts: { signal?: AbortSignal } = {}): Promise<FlowOutcome> {
  let spec: FlowSpec;
  try {
    spec = validateFlow(raw);
  } catch (err) {
    return { status: "stopped", at: 0, stepsRun: 0, reason: "invalid", message: err instanceof Error ? err.message : "This flow is not valid." };
  }
  const sensitive = new Set(spec.params.filter((p) => p.sensitive).map((p) => p.key));
  // Everything the agent is to type must be there before anything is touched.
  for (let i = 0; i < spec.steps.length; i++) {
    const s = spec.steps[i];
    if (s.kind === "type" && !sensitive.has(s.param) && typeof params[s.param] !== "string") {
      const label = spec.params.find((p) => p.key === s.param)?.label ?? s.param;
      return { status: "stopped", at: i, stepsRun: 0, reason: "missing_param", message: `Give a value for "${label}" to run this flow.` };
    }
  }
  const healed: Array<{ step: number; how: LocateHow }> = [];
  let run = 0;
  const stop = (at: number, reason: StopReason, message: string, candidates?: ElementInfo[]): FlowOutcome => ({
    status: "stopped",
    at,
    stepsRun: run,
    reason,
    message,
    ...(candidates?.length ? { candidates: candidates.map((c) => c.name.slice(0, 80)) } : {}),
  });
  for (let i = 0; i < spec.steps.length; i++) {
    if (opts.signal?.aborted) return stop(i, "aborted", "The run was stopped.");
    const s = spec.steps[i];
    let result: ActorResult;
    if (s.kind === "navigate") {
      // Only the taught addresses on the taught site: a flow cannot be edited into going elsewhere.
      if (originOf(s.url) !== spec.origin) return stop(i, "invalid", "A navigate step must stay on the flow's site.");
      result = await actor.navigate(s.url);
    } else {
      if (s.kind === "type" && sensitive.has(s.param)) {
        return stop(i, "sensitive_field", `"${spec.params.find((p) => p.key === s.param)?.label ?? "This field"}" is a password or card field. The person types it; the agent never does.`);
      }
      const controls = await actor.controls();
      const found = resolveLocator(s.locator, controls, { needs: s.kind === "type" ? "field" : "any" });
      if (!found.ok) {
        return stop(
          i,
          found.reason,
          found.reason === "ambiguous" ? `More than one control matches "${s.locator.name}". Choose which one.` : `Could not find "${s.locator.name}" on the page any more.`,
          found.candidates,
        );
      }
      if (found.how !== "attribute" && found.how !== "role-name") healed.push({ step: i, how: found.how });
      else if (found.how === "attribute" && found.element.name.trim().toLowerCase() !== s.locator.name.trim().toLowerCase() && s.locator.name) healed.push({ step: i, how: found.how });
      result = s.kind === "click" ? await actor.click(found.element.ref) : await actor.type(found.element.ref, params[s.param]);
    }
    if (!result.ok) return stop(i, result.kind, result.message);
    run += 1;
  }
  return { status: "done", stepsRun: run, healed };
}
