// Marketr — Phase 16 slice 3: generative component registry.
//
// CODE allowlist (not DB): the agent may emit ONLY registered component
// names. This registry is the allowlist authority — the web shell (slice 3)
// and the React Native shell (slice 10) consume the same registry.
//
// Enforcement lives in two places:
//  1. Registration: components/agents registration code only registers
//     names present here.
//  2. Render path: `resolveGenerativeComponent` asserts the name before any
//     render; `assertRegisteredComponentName` throws + logs on anything
//     unregistered so an unregistered emission is rejected, never rendered.

import type { ComponentType } from "react";
import { ApprovalCard } from "@/components/agents/ApprovalCard";
import { ReportPreview } from "@/components/agents/ReportPreview";

export interface GenerativeComponentDef {
  /** Model-facing description: when the agent should emit this component. */
  description: string;
  /** The React component rendered for this name. */
  component: ComponentType<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * The allowlist. Add new components here (and only here) — slice 10's
 * mobile shell consumes the same registry for its native-mapped subset.
 */
export const GENERATIVE_COMPONENT_REGISTRY = {
  approval_card: {
    description:
      "Render a pending autopilot approval item in-flow. Use when the user must approve, deny, or edit " +
      "a pending autopilot item (content refresh, new page, or keyword brief). Props: itemId, projectId.",
    component: ApprovalCard,
  },
  report_preview: {
    description:
      "Render a pending branded-report send approval in-flow. Use when the user must approve, deny, or edit " +
      "a drafted report before it renders to PDF. Shows every figure with its source pointer; figures without " +
      "a source are flagged, never rendered. Props: approvalId.",
    component: ReportPreview,
  },
} as const satisfies Record<string, GenerativeComponentDef>;

export type GenerativeComponentName = keyof typeof GENERATIVE_COMPONENT_REGISTRY;

/** True when `name` is on the allowlist. */
export function isRegisteredComponentName(name: unknown): name is GenerativeComponentName {
  return typeof name === "string" && Object.hasOwn(GENERATIVE_COMPONENT_REGISTRY, name);
}

/**
 * Allowlist gate for the emit path: returns the name when registered,
 * otherwise logs and throws — an unregistered component is rejected, never
 * rendered.
 */
export function assertRegisteredComponentName(name: unknown): GenerativeComponentName {
  if (!isRegisteredComponentName(name)) {
    console.error(`[marketr-agents] rejected unregistered generative component: ${String(name)}`);
    throw new Error(`marketr: unregistered generative component "${String(name)}"`);
  }
  return name;
}

/** Resolve a registered name to its React component (asserts first). */
export function resolveGenerativeComponent(name: unknown): ComponentType<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return GENERATIVE_COMPONENT_REGISTRY[assertRegisteredComponentName(name)].component as ComponentType<any>;
}
