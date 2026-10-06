// ShapesOS — Phase 18.2 (WS=comms): POST /api/cron/comms-contacts
//
// Contacts' identity-link layer: links new records in the four people stores
// to their own identity and refreshes merge SUGGESTIONS (never merges —
// a person confirms each; lib/comms/contacts/store.ts).
//
// Auth: the shared cron gate (lib/cron/gate.ts) — CRON_SECRET syncs every
// workspace; a signed-in editor+ syncs their own.
// Schedule: every 30 minutes (lib/cron/jobs.ts "comms-contacts").

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { allWorkspaceIds } from "@/lib/ops/helpdesk";
import { syncAllContacts } from "@/lib/comms/contacts/sync.server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const workspaceIds = gate.isCron ? await allWorkspaceIds() : [gate.workspaceId!];
  const contacts = await syncAllContacts(workspaceIds);
  return Response.json({ ok: true, contacts });
}
