// ShapesOS — Phase 19A (WS=server): the element registry the agentic cursor
// points at inside ShapesOS (PURE — safe in server and client components).
//
// An element the cursor can point at carries
//   data-cursor-id="<stable id>"  data-cursor-label="<what it is>"  data-cursor-role="<button|link|…>"
// Ids are stable across renders and languages:
//   nav:<href>                     every nav destination (lib/nav/config.ts)
//   shell:topbar, shell:needs-you, shell:command-bar, shell:new-task, …
//   approval:<card id>:approve|deny|review   each approval card's actions
//   kit:<component>:<action>       each kit primary action (components/aos)
//   agent:<node key>               each agent row of the agent tree (lead, sub-agents, runs)
// The page publishes the visible ones through window.__shapesUiMap()
// (components/cursor/CursorUiMap.tsx); ShapesOS Desktop's preload reads it
// and the brain points with [POINT:#id:label]. A coverage test
// (lib/cursor/__tests__/registry.test.ts) keeps every nav destination and
// every kit primary action addressable.

export type CursorRole = "button" | "link" | "region" | "input" | "tab" | "menuitem";

export interface CursorTargetAttrs {
  "data-cursor-id": string;
  "data-cursor-label": string;
  "data-cursor-role": CursorRole;
}

/** Attributes that make an element addressable by the cursor. */
export function cursorTarget(id: string, label: string, role: CursorRole = "button"): CursorTargetAttrs {
  return { "data-cursor-id": id, "data-cursor-label": label.replace(/\s+/g, " ").trim().slice(0, 120), "data-cursor-role": role };
}

/**
 * The hook form the kit uses (`{...useCursorTarget(id, label, role)}`). It
 * holds no state, so it is also safe in server components; inside a loop or
 * a callback use cursorTarget() (same result) to keep the hook rules happy.
 */
export function useCursorTarget(id: string, label: string, role: CursorRole = "button"): CursorTargetAttrs {
  return cursorTarget(id, label, role);
}

/** The id of a nav destination. */
export function navCursorId(href: string): string {
  return `nav:${href}`;
}

/** A stable slug for a label-derived id part ("Run Researcher" → "run-researcher"). */
export function cursorSlug(s: string): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "action"
  );
}

/** Shell elements (top bar, ⌘K, the Needs-you shortcut, …). */
export const SHELL_TARGETS = {
  topbar: "shell:topbar",
  needsYou: "shell:needs-you",
  commandBar: "shell:command-bar",
  newTask: "shell:new-task",
  notifications: "shell:notifications",
  sidebar: "shell:sidebar",
} as const;

/**
 * The kit's primary actions (components/aos) and the id each one carries.
 * The coverage test checks each file actually wires its ids.
 */
export const KIT_PRIMARY_ACTIONS: ReadonlyArray<{ file: string; component: string; ids: readonly string[] }> = [
  { file: "components/aos/AgentCard.tsx", component: "CardActionButton", ids: ["kit:agent-card:"] },
  { file: "components/aos/ApprovalCard.tsx", component: "ApprovalCard", ids: ["approval:", ":approve", ":deny", ":review"] },
  { file: "components/aos/Banner.tsx", component: "Banner", ids: ["kit:banner:"] },
  { file: "components/aos/Composer.tsx", component: "Composer", ids: ["kit:composer:send"] },
  { file: "components/aos/RunTimeline.tsx", component: "RunTimeline", ids: ["kit:run:pause", "kit:run:resume", "kit:run:stop"] },
  { file: "components/aos/Toast.tsx", component: "ToastView", ids: ["kit:toast:"] },
  { file: "components/aos/LeadAgentCard.tsx", component: "LeadAgentCard", ids: ["kit:lead-agent:"] },
  { file: "components/aos/LiveActivity.tsx", component: "LiveRunStrip", ids: ["kit:live-run:stop"] },
  { file: "components/aos/AgentTree.tsx", component: "AgentTree", ids: ["agent:${node.key}", "agent:${c.key}"] },
];

/**
 * Kit files that render buttons or links which are NOT primary actions —
 * form controls and filters the person sets, not actions the cursor points
 * at to get something done. The coverage test fails on any kit file with a
 * button or link that is in neither list, so a new kit component must be
 * wired (or consciously listed here) before it ships.
 */
export const KIT_NON_PRIMARY: Readonly<Record<string, string>> = {
  "components/aos/Controls.tsx": "form controls (permission segmented control, segmented, switch): settings values, not actions",
  "components/aos/FilterPill.tsx": "list filters: they narrow a view, they do not act",
  "components/aos/Menu.tsx": "menu rows inside an already-open menu; the menu's trigger is the target",
  "components/aos/ToolChip.tsx": "a tool chip toggles a tool on a draft; it is not an action",
  "components/aos/DelegationPlan.tsx": "plain links to sub-tasks inside a plan table (the agent rows are targets)",
};
