// Marketr — E-sign module: pipeline links fired on vendor completion.
// When an envelope completes, the OS's downstream objects react: a signed
// proposal becomes a contract, a signed SOW drafts an invoice, a signed
// contract flips to executed. Those objects live in the legal/compliance and
// pipeline modules, which don't exist yet — so this module exposes the moment
// as a SUBSCRIBABLE internal event and records a durable audit row for each
// fired link, which the future modules can replay. Nothing here invents
// downstream records; it only announces that the vendor sealed the document.

import { createHash } from "node:crypto";
import { appendAuditEvent, type AuditDb } from "./audit";

export type PipelineLinkKind = "proposal_to_contract" | "sow_to_invoice_draft" | "contract_to_executed";

export interface PipelineLinkEvent {
  kind: PipelineLinkKind;
  envelopeId: string;
  workspaceId: string;
  /** The legal/pipeline module's object id (proposal, SOW, or contract). */
  refId: string;
  contractType: string;
  at: string;
}

type PipelineHandler = (event: PipelineLinkEvent) => void | Promise<void>;

/** Extract a string ref id from the generic pipeline ref (string or { id }). */
function refIdOf(contractRef: string | null, pipelineRef: unknown): string | null {
  if (contractRef) return contractRef;
  if (typeof pipelineRef === "string" && pipelineRef) return pipelineRef;
  if (
    pipelineRef !== null &&
    typeof pipelineRef === "object" &&
    typeof (pipelineRef as { id?: unknown }).id === "string"
  ) {
    return (pipelineRef as { id: string }).id;
  }
  return null;
}

const subscribers = new Set<PipelineHandler>();

/** Subscribe to pipeline-link events (used by the future legal/pipeline modules). */
export function onPipelineLink(handler: PipelineHandler): () => void {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}

async function emit(event: PipelineLinkEvent): Promise<void> {
  for (const handler of [...subscribers]) {
    await handler(event);
  }
}

/**
 * Inspect a freshly-completed envelope and fire the pipeline links its
 * generic refs declare. Called ONLY from the vendor-completion path — never
 * from a poll, a guess, or an agent shortcut.
 */
export async function firePipelineLinks(
  db: AuditDb,
  envelope: {
    id: string;
    workspaceId: string;
    contractType: string | null;
    contractRef: string | null;
    /** Generic ref — a string id or an { id } object (Json in the schema). */
    pipelineRef: unknown;
  },
): Promise<PipelineLinkEvent[]> {
  const fired: PipelineLinkEvent[] = [];
  const refId = refIdOf(envelope.contractRef, envelope.pipelineRef);
  if (!envelope.contractType || !refId) return fired;

  let kind: PipelineLinkKind | null = null;
  if (envelope.contractType === "proposal") kind = "proposal_to_contract";
  else if (envelope.contractType === "sow") kind = "sow_to_invoice_draft";
  else if (envelope.contractType === "contract") kind = "contract_to_executed";
  if (!kind) return fired;

  const event: PipelineLinkEvent = {
    kind,
    envelopeId: envelope.id,
    workspaceId: envelope.workspaceId,
    refId,
    contractType: envelope.contractType,
    at: new Date().toISOString(),
  };

  // Durable intent record: the future legal/pipeline modules replay these.
  await appendAuditEvent(db, {
    envelopeId: envelope.id,
    event: "pipeline_link_fired",
    actor: "system",
    payload: { kind, refId, contractType: envelope.contractType, at: event.at },
    bodyHash: createHash("sha256")
      .update(JSON.stringify(["pipeline_link_fired", event.kind, event.envelopeId, event.refId, event.at]))
      .digest("hex"),
  });

  await emit(event);
  fired.push(event);
  return fired;
}
