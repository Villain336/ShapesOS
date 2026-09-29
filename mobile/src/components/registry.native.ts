// Marketr mobile — native-mapped subset of the generative component allowlist.
//
// The web registry (lib/agents/components/registry.ts) stays the allowlist
// authority: the agent may emit ONLY registered names, and
// `assertRegisteredComponentName` rejects anything else on the render path.
// Mobile renders the native-mapped SUBSET below — names here MUST be a subset
// of the web registry keys. __tests__/registry-subset.test.ts enforces that
// against the real registry file, so drift fails the build.
//
// Mapped:   approval_card  → NativeApprovalCard (approve/deny/edit via the gate)
// Unmapped: report_preview → intentionally unmapped (slice-10 bonus, not
//           required). If the agent emits it on mobile, the chat renderer
//           falls back to a "open on web" note — never an unregistered render.

import type { ComponentType } from "react";
import { NativeApprovalCard, type NativeApprovalCardProps } from "./NativeApprovalCard";

export interface NativeComponentDef {
  /** Model-facing description — kept in sync with the web registry entry. */
  description: string;
  /** The React Native component rendered for this name. */
  component: ComponentType<NativeApprovalCardProps>;
}

export const NATIVE_GENERATIVE_COMPONENTS = {
  approval_card: {
    description:
      "Render a pending autopilot approval item in-flow. Use when the user must approve, deny, or edit " +
      "a pending autopilot item (content refresh, new page, or keyword brief). Props: itemId, projectId.",
    component: NativeApprovalCard,
  },
} as const satisfies Record<string, NativeComponentDef>;

export type NativeGenerativeComponentName = keyof typeof NATIVE_GENERATIVE_COMPONENTS;

/** True when `name` has a native mapping. */
export function isNativeMappedComponentName(name: unknown): name is NativeGenerativeComponentName {
  return typeof name === "string" && Object.hasOwn(NATIVE_GENERATIVE_COMPONENTS, name);
}

/**
 * Resolve a tool-call name to its native component. Asserts BOTH sides:
 * the name must be on the web allowlist AND natively mapped — anything else
 * is rejected, never rendered.
 */
export function resolveNativeComponent(
  name: unknown,
  /** The web registry's key set (injected; the registry module itself is web-only). */
  webAllowlist: ReadonlySet<string>,
): ComponentType<NativeApprovalCardProps> {
  if (typeof name !== "string" || !webAllowlist.has(name)) {
    throw new Error(`marketr: unregistered generative component "${String(name)}"`);
  }
  if (!isNativeMappedComponentName(name)) {
    throw new Error(`marketr: generative component "${name}" has no native mapping`);
  }
  return NATIVE_GENERATIVE_COMPONENTS[name].component;
}

/**
 * The web registry's key set, mirrored here so the native bundle never
 * imports web-only modules. registry-subset.test.ts verifies this matches
 * lib/agents/components/registry.ts exactly.
 */
export const WEB_REGISTRY_NAMES: ReadonlySet<string> = new Set(["approval_card", "report_preview"]);
