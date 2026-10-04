// ShapesOS — sample data for the design-kit gallery (/dashboard/settings/design).
// Trees are built through the real derivation (lib/aos/agents) from
// orchestrator-shaped mission events, so the gallery exercises the same code
// path as the sidebar and the Overview.

import { deriveAgentTree, type AgentTree, type MissionEventInput, type MissionInput } from "@/lib/aos/agents";
import type { AosStatus } from "@/lib/aos/status";

const NOW = new Date("2026-10-04T09:30:00Z");
const t = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

let n = 0;
const route = (agent: string, label: string, min: number): MissionEventInput => {
  n += 1;
  return { ts: t(min), actor: "chief-strategy-agent", step: `route.${n}`, args: { nextAgent: agent, routingReason: `routing-table -> ${agent}`, taskLabel: label } };
};
const exec = (agent: string, summary: string, min: number): MissionEventInput => ({ ts: t(min), actor: agent, step: `exec.${n}`, observation: { summary } });
const fail = (agent: string, error: string, min: number): MissionEventInput => ({ ts: t(min), actor: agent, step: `exec.${n}.error`, observation: { error } });

function mission(id: string, name: string, status: string, events: MissionEventInput[], pendingApprovals = 0): MissionInput {
  return { id, name, status, createdAt: t(90), updatedAt: t(1), planTotal: 7, pendingApprovals, events };
}

const BRIEF = [
  route("planner", "Plan the work", 30),
  exec("planner", "Split the task into 5 steps.", 29),
  route("researcher", "Search the web", 28),
  exec("researcher", "Found 18 results and kept 12.", 27),
  route("researcher", "Reading 12 sources", 26),
];

/** The main demo: lead running a mission with sub-agents in mixed states. */
export function demoTree(): AgentTree {
  return deriveAgentTree({
    now: NOW,
    missions: [
      mission("demo-brief", "Weekly competitor brief", "active", [
        ...BRIEF,
        route("drafter", "Draft renewal emails", 20),
        route("analyst", "Summarize Q3", 40),
        exec("analyst", "Finished the Q3 summary.", 35),
        route("actor", "Sync calendar", 15),
        fail("actor", "Calendar access expired", 14),
      ]),
    ],
    runs: [],
  })!;
}

/** One tree per lead state, for the "AgentTree in every state" row. */
export function demoTreesByState(): Array<{ status: AosStatus; tree: AgentTree }> {
  const make = (status: string, events: MissionEventInput[], pending = 0, runs: Parameters<typeof deriveAgentTree>[0]["runs"] = []) =>
    deriveAgentTree({ now: NOW, missions: [mission(`m-${status}-${n}`, "Weekly competitor brief", status, events, pending)], runs })!;
  const running = make("active", BRIEF);
  const needs = make("active", [...BRIEF.slice(0, 4), route("drafter", "Draft 14 renewal emails", 5)], 14);
  const failedId = `m-failed-${n + 1}`;
  const failed = deriveAgentTree({
    now: NOW,
    missions: [mission(failedId, "Calendar sync", "active", [route("researcher", "Read the calendar", 12), exec("researcher", "Read 40 events.", 11), route("actor", "Sync calendar", 10), fail("actor", "Calendar access expired", 9)])],
    runs: [{ id: "r-demo", kind: "mission", status: "failed", missionId: failedId, createdAt: t(10), endedAt: t(9) }],
  })!;
  const done = make("complete", [...BRIEF, exec("researcher", "Read 12 sources.", 20), route("drafter", "Draft the brief", 19), exec("drafter", "Drafted a one-page brief.", 10)]);
  const queued = make("planned", []);
  const paused = make("paused", BRIEF);
  return [
    { status: "running", tree: running },
    { status: "needs", tree: needs },
    { status: "failed", tree: failed },
    { status: "done", tree: done },
    { status: "queued", tree: queued },
    { status: "paused", tree: paused },
  ];
}

export const DEMO_STEPS = [
  { key: "plan", title: "Plan the work", detail: "Split the task into 5 steps.", at: "9:00" },
  {
    key: "search",
    title: "Search the web",
    detail: "Found 18 results and kept 12.",
    at: "9:01",
    tool: {
      name: "web.search",
      duration: "0.8 s",
      args: [
        ["query", '"competitor pricing changes, last 7 days"'],
        ["limit", "20"],
      ] as Array<[string, string]>,
      result: "18 results, 12 kept, 6 duplicates dropped",
    },
  },
  { key: "read", title: "Read sources", detail: "Now reading a vendor pricing page.", progress: { done: 7, total: 12 } },
  { key: "draft", title: "Draft the brief", detail: "Starts when reading is done." },
  { key: "send", title: "Send to your team", asksFirst: true },
];
