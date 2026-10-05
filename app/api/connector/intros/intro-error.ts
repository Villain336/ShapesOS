// Marketr — Connector Agent slice 4 API: shared ConnectorError → HTTP mapping.
import { ConnectorError } from "@/lib/connector/types";

const NOT_FOUND = new Set([
  "introduction_not_found",
  "person_not_found",
  "target_not_found",
  "funding_investor_not_found",
  "dataroom_doc_not_found",
  // Slice 6: Boardy rail.
  "boardy_request_not_found",
]);

export function introErrorResponse(e: ConnectorError) {
  let status = 400;
  if (NOT_FOUND.has(e.code)) status = 404;
  // intro_conflict: a concurrent request moved the row on first (guarded
  // transition); intro_expired: the proposal's window closed before the act.
  else if (e.code === "intro_already_active" || e.code === "intro_conflict" || e.code === "intro_expired") status = 409;
  else if (e.code === "agent_cannot_act") status = 403;
  return Response.json({ error: e.message, code: e.code }, { status });
}
