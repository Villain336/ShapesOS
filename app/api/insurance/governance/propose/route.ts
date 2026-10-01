// Marketr — Wave 2 Insurance slice 3a: governed-action proposal API.
// POST /api/insurance/governance/propose — propose a governed action
// (request_quote | bind_policy | issue_certificate), editor role.
// The agent prepares; the human approves via /governance/[id]/decide.
// Execution happens on the licensed rail only after approval.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { InsuranceError } from "@/lib/insurance/types";
import {
  GOVERNED_ACTIONS,
  SUBJECT_TYPES,
  proposeGovernedAction,
  type GovernedActionDetails,
} from "@/lib/insurance/governance";

export const dynamic = "force-dynamic";

const ProposeSchema = z.object({
  action: z.enum(GOVERNED_ACTIONS as unknown as [string, ...string[]]),
  subjectType: z.enum(SUBJECT_TYPES as unknown as [string, ...string[]]),
  subjectId: z.string().trim().min(1).max(100),
  requestedBy: z.string().trim().max(200).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

function serialize(record: {
  id: string;
  kind: string;
  payload: unknown;
  status: string;
  requestedBy: string | null;
}) {
  return {
    id: record.id,
    kind: record.kind,
    payload: record.payload,
    status: record.status,
    requestedBy: record.requestedBy,
  };
}

export async function POST(req: Request) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = ProposeSchema.parse(await req.json());

    const approval = await proposeGovernedAction(
      workspace.id,
      body.action,
      { subjectType: body.subjectType, subjectId: body.subjectId },
      (body.details ?? {}) as GovernedActionDetails,
      body.requestedBy ?? user.id,
    );

    return Response.json({ approval: serialize(approval) }, { status: 201 });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return Response.json(
        { error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
        { status: 400 },
      );
    }
    if (e instanceof InsuranceError) {
      // Domain refusals (e.g. BIND_DISCLOSURE_INCOMPLETE) are client errors.
      return Response.json({ error: e.message, code: e.code }, { status: 422 });
    }
    return httpErrorResponse(e);
  }
}
