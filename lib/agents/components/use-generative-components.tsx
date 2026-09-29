// Marketr — Phase 16 slice 3: CopilotKit registration for the generative
// component allowlist.
//
// Each allowlisted component is registered with CopilotKit v2's `useComponent`
// (installed @copilotkit/react-core@1.75.0 — the v2 subpath is the documented
// current API; the package root is v1-deprecated and does not export it):
// the agent emits a component by calling a frontend tool with the registered
// name, and the `render` function renders the tool-call parameters as props.
//
// Render-path enforcement: the render wrapper re-asserts the name against
// the registry allowlist before rendering — an unregistered name can never
// reach a component.

"use client";

import type { ComponentType } from "react";
import { useComponent } from "@copilotkit/react-core/v2";
import {
  GENERATIVE_COMPONENT_REGISTRY,
  assertRegisteredComponentName,
  type GenerativeComponentName,
} from "./registry";

function RegisteredComponent({ name }: { name: GenerativeComponentName }) {
  const def = GENERATIVE_COMPONENT_REGISTRY[name];
  useComponent(
    {
      name,
      description: def.description,
      // No `parameters` schema: render accepts any props (v2 types this as
      // ComponentType<any> when parameters is omitted).
      render: (props: Record<string, unknown>) => {
        // Allowlist authority: reject anything not in the registry, even if
        // CopilotKit handed us a render for it.
        const registered = assertRegisteredComponentName(name);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const Component: ComponentType<any> =
          GENERATIVE_COMPONENT_REGISTRY[registered].component;
        return <Component {...props} />;
      },
    },
    [name],
  );
  return null;
}

/**
 * Mount inside the CopilotKit provider (e.g. MarketrAgentShell) to register
 * every allowlisted generative component for the agent to emit.
 */
export function GenerativeComponentHost() {
  const names = Object.keys(GENERATIVE_COMPONENT_REGISTRY) as GenerativeComponentName[];
  return (
    <>
      {names.map((name) => (
        <RegisteredComponent key={name} name={name} />
      ))}
    </>
  );
}
