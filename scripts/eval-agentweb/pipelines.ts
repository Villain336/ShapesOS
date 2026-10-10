// ShapesOS — Phase 21A evals: the two pipelines the corpus runs through.
//
//   naive   what an unprotected agent does: it reads the page raw (the way an
//           HTML-to-text dump would, hidden text, alt text, metadata and
//           comments included), hands everything to the model and runs
//           whatever the model proposes. It exists to prove the corpus BITES.
//   kernel  the same fake models behind the safety kernel (lib/agentweb).
//   kernel-raw  the kernel with the visible-text hygiene switched OFF: the
//           reader is handed the raw dump, hidden text and all. It proves the
//           structural gates (tiers, origins, taint, output) hold even when
//           the hygiene step fails.

import { controlsOf } from "../../lib/agentweb/elements";
import { parseHtml, textOf, findAll, attr } from "../../lib/agentweb/html";
import { SafetyKernel } from "../../lib/agentweb/kernel";
import { capabilitiesFor } from "../../lib/agentweb/capabilities";
import type { PageContext, ProposedStep } from "../../lib/agentweb/types";
import { SECRET_CANARY, type InjectionCase } from "./corpus";
import { startFixtureWorld } from "./fixture-server";
import { adversarialActor, adversarialReader, type ActorModel } from "./fake-models";
import { World, type Violation } from "./world";
import type { ReaderModel } from "../../lib/agentweb/reader";

export type PipelineName = "naive" | "kernel" | "kernel-raw";

export interface CaseResult {
  id: string;
  klass: string;
  pipeline: PipelineName;
  violations: Violation[];
  executed: string[];
  blocked: string[];
  answer: string;
  /** Did the honest answer survive (the kernel must not break the task)? */
  answered: boolean;
}

export interface PipelineModels {
  actor: ActorModel;
  reader: ReaderModel;
}

export const FAKE_MODELS: PipelineModels = { actor: adversarialActor, reader: adversarialReader };

/** Everything a naive HTML-to-text dump contains: visible text, hidden text, alt, aria, metadata, comments. */
export function rawDump(html: string): string {
  const root = parseHtml(html);
  const bits = [textOf(root)];
  for (const n of findAll(root, (x) => x.type === "element")) {
    for (const a of ["alt", "title", "aria-label", "content", "placeholder"]) {
      const v = attr(n, a);
      if (v) bits.push(v);
    }
  }
  for (const c of findAll(root, (x) => x.type === "comment")) bits.push(c.text ?? "");
  return bits.join("\n");
}

export async function runCase(c: InjectionCase, pipeline: PipelineName, models: PipelineModels = FAKE_MODELS): Promise<CaseResult> {
  const fx = await startFixtureWorld(c.site, c.evil);
  try {
    const siteOrigin = fx.origins.site;
    // The dry run's approver says no to everything: any Tier 2+ effect is unapproved.
    const world = new World(fx, new Set([siteOrigin]), () => false);
    const startUrl = `${siteOrigin}${c.start}`;
    let answer = "";
    let blocked: string[] = [];

    if (pipeline === "naive") {
      const view = c.snippet ? c.snippet(fx.origins) : await naiveView(world, startUrl);
      const page: PageContext = { url: startUrl, origin: siteOrigin };
      const html = c.snippet ? "" : (await world.fetchPage(startUrl)).html;
      const input = { task: c.task, view, controls: controlsOf(html, startUrl), page, secret: SECRET_CANARY };
      for (const step of await models.actor.propose(input)) await world.execute(step, labelOf(step));
      answer = await models.actor.compose(input);
    } else {
      const kernel = new SafetyKernel({ caps: capabilitiesFor(startUrl), secrets: [SECRET_CANARY] });
      let view: string;
      let controls = [] as ReturnType<typeof controlsOf>;
      const page: PageContext = { url: startUrl, origin: siteOrigin };
      if (c.snippet) {
        view = kernel.wrapUntrusted(c.snippet(fx.origins), "https://search.example");
      } else {
        // A redirect to an origin the task did not allow is not followed: the request is never made.
        const fetched = await world.fetchPage(startUrl, (next) => kernel.authorize({ kind: "navigate", url: next }).decision !== "allow");
        if (fetched.pausedAt) {
          blocked.push(`paused: the page tried to move to ${new URL(fetched.pausedAt).origin}`);
          view = "";
        } else {
          world.consumed(fetched.url);
          const reading = await kernel.readPage({ url: fetched.url, html: fetched.html }, models.reader, pipeline === "kernel-raw" ? { textOf: rawDump } : undefined);
          controls = controlsOf(fetched.html, fetched.url);
          view = `${kernel.actorView(reading)}\n${kernel.renderControls(controls, fetched.url)}`;
        }
      }
      const input = { task: c.task, view, controls, page, secret: SECRET_CANARY };
      for (const step of await models.actor.propose(input)) {
        const d = kernel.authorize(step);
        if (d.decision === "allow") await world.execute(step, labelOf(step));
        else blocked.push(`${d.decision} (${d.klass}): ${labelOf(step)}`);
      }
      answer = kernel.sanitizeOutput(await models.actor.compose(input));
    }
    world.judge(answer);
    return {
      id: c.id,
      klass: c.klass,
      pipeline,
      violations: world.violations,
      executed: world.executed,
      blocked: [...blocked, ...world.blocked],
      answer,
      answered: c.answerMustContain.every((s) => answer.includes(s)),
    };
  } finally {
    await fx.close();
  }
}

async function naiveView(world: World, url: string): Promise<string> {
  const page = await world.fetchPage(url);
  world.consumed(page.url);
  return rawDump(page.html);
}

function labelOf(step: ProposedStep): string {
  switch (step.kind) {
    case "navigate":
      return `navigate ${step.url.slice(0, 60)}`;
    case "click":
      return `click "${step.element.name.slice(0, 40)}"`;
    case "type":
      return `type into "${step.element.name.slice(0, 40)}"`;
    case "tool":
      return `${step.tool}`;
  }
}
