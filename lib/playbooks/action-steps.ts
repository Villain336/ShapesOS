// Marketr — Phase 14: playbook action steps (slice 4).
//
// Playbooks are PROPOSE-ONLY in v1 (runPlaybook drafts a plan, executes
// nothing — lib/playbooks/store.ts). A playbook step that declares a
// connected-app action is routed here: the step's action is proposed into
// the Phase 14 approve/deny queue (proposeAction), NEVER executed. This
// preserves the playbook doctrine while letting procedures carry real
// actions into the human review surface.

import {
  proposeAction,
} from "@/lib/integrations/actions/gate";
import { getV1App } from "@/lib/integrations/actions/risk";

export interface PlaybookActionStep {
  title: string;
  /** v1 app key (gmail, google-sheets, slack, hubspot, notion). */
  appKey: string;
  /** Composio tool slug, e.g. GMAIL_CREATE_DRAFT. */
  toolName: string;
  args?: Record<string, unknown>;
}

export interface ProposePlaybookActionInput {
  workspaceId: string;
  playbookId: string;
  version: number;
  step: PlaybookActionStep;
  proposedBy: string;
}

/** Validate + propose a playbook action step. Never executes. */
export async function proposePlaybookActionStep(input: ProposePlaybookActionInput) {
  if (!getV1App(input.step.appKey)) {
    throw new Error(`Unknown app "${input.step.appKey}" for playbook action step.`);
  }
  if (!input.step.toolName?.trim()) {
    throw new Error("Playbook action step requires a toolName.");
  }
  const { approval } = await proposeAction({
    workspaceId: input.workspaceId,
    appKey: input.step.appKey,
    toolName: input.step.toolName,
    args: input.step.args ?? {},
    proposedBy: `${input.proposedBy} (playbook:${input.playbookId}@v${input.version})`,
    plainSummary: `Playbook step "${input.step.title}"`,
  });
  return { approvalId: approval.id, status: approval.status };
}
