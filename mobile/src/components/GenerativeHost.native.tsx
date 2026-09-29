// Marketr mobile — native generative-component registration.
//
// Mirrors lib/agents/components/use-generative-components.tsx (Phase 16
// slice 3): each allowlisted component is registered with CopilotKit v2's
// `useComponent` (from the official @copilotkit/react-native SDK), so the
// agent can emit it and the native renderer handles it.
//
// Render-path enforcement: the render wrapper re-asserts the name against
// the native-mapped subset (which is itself a subset of the web allowlist —
// see registry.native.ts) before rendering. An unregistered name can never
// reach a component.
//
// Mount inside the CopilotKitProvider (see src/App.tsx).

import React from "react";
import { useComponent } from "@copilotkit/react-native";
import {
  NATIVE_GENERATIVE_COMPONENTS,
  isNativeMappedComponentName,
  type NativeGenerativeComponentName,
} from "./registry.native";
import type { GateClientOptions } from "../api/gate";

function RegisteredNativeComponent({
  name,
  gate,
}: {
  name: NativeGenerativeComponentName;
  gate: GateClientOptions;
}) {
  const def = NATIVE_GENERATIVE_COMPONENTS[name];
  useComponent(
    {
      name,
      description: def.description,
      // No `parameters` schema: render accepts any props (same as web).
      render: (props: Record<string, unknown>) => {
        // Allowlist authority: reject anything not natively mapped, even if
        // CopilotKit handed us a render for it.
        if (!isNativeMappedComponentName(name)) {
          throw new Error(`marketr: unregistered generative component "${String(name)}"`);
        }
        const Component = NATIVE_GENERATIVE_COMPONENTS[name].component;
        return (
          <Component
            itemId={String(props.itemId ?? "")}
            projectId={String(props.projectId ?? "")}
            gate={gate}
          />
        );
      },
    },
    [name],
  );
  return null;
}

/** Mount inside the CopilotKit provider to register every natively-mapped component. */
export function GenerativeHostNative({ gate }: { gate: GateClientOptions }) {
  const names = Object.keys(NATIVE_GENERATIVE_COMPONENTS) as NativeGenerativeComponentName[];
  return (
    <>
      {names.map((name) => (
        <RegisteredNativeComponent key={name} name={name} gate={gate} />
      ))}
    </>
  );
}
