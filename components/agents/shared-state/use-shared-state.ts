// Marketr — Phase 16 slice 4: CoAgents shared-state hook (frontend).
//
// Thin React wrapper over CopilotKit v2's `useAgent` (installed
// @copilotkit/react-core@1.75.0, subpath `@copilotkit/react-core/v2` —
// the documented current API; `useCoAgent` only exists on the deprecated
// v1 root). Mount anywhere inside <MarketrAgentShell>'s CopilotKit
// provider; the provider registers the self-managed "marketr-agent"
// HttpAgent, so useAgent resolves it without a runtime URL.
//
// Bidirectional sync:
//   agent→UI: the backend emits STATE_SNAPSHOT/STATE_DELTA; @ag-ui/client's
//             applyEvents writes them onto agent.state; useAgent re-renders
//             on OnStateChanged → widgets below show the new state.
//   UI→agent: call the setters below (agent.setState); CopilotKit includes
//             the updated state in the next RunAgentInput; the shell's
//             bridge forwards it to /api/agents/chat; the adapter diffs +
//             applies writable calendar rows and re-emits the canonical
//             snapshot.

"use client";

import { useCallback, useMemo } from "react";
import { useAgent, UseAgentUpdate } from "@copilotkit/react-core/v2";
import {
  updateCalendarRowInState,
  type CalendarRowPatch,
  type SharedAgentState,
} from "@/lib/agents/agui/shared-state";
import { MARKETR_AGENT_ID } from "../MarketrAgentShell";

export interface UseSharedState {
  /** Current synced state ({} until the first STATE_SNAPSHOT arrives). */
  state: SharedAgentState;
  /** True once the agent instance is resolved. */
  isReady: boolean;
  /**
   * UI→agent write: replace whole domains (e.g. after an optimistic edit).
   * Flows to the backend on the next agent run.
   */
  setState: (patch: SharedAgentState) => void;
  /** Edit one content-calendar row's scheduledFor/status (optimistic). */
  updateCalendarRow: (rowId: string, patch: CalendarRowPatch) => void;
}

export function useSharedState(): UseSharedState {
  // OnStateChanged only: shared state doesn't care about message updates.
  const { agent, isReady } = useAgent({
    agentId: MARKETR_AGENT_ID,
    updates: [UseAgentUpdate.OnStateChanged],
  });

  const state = useMemo<SharedAgentState>(
    () => (agent?.state ?? {}) as SharedAgentState,
    [agent?.state],
  );

  const setState = useCallback(
    (patch: SharedAgentState) => {
      if (!agent) return;
      agent.setState({ ...(agent.state as object), ...patch });
    },
    [agent],
  );

  const updateCalendarRow = useCallback(
    (rowId: string, patch: CalendarRowPatch) => {
      if (!agent) return;
      const next = updateCalendarRowInState((agent.state ?? {}) as SharedAgentState, rowId, patch);
      agent.setState(next);
    },
    [agent],
  );

  return { state, isReady, setState, updateCalendarRow };
}
