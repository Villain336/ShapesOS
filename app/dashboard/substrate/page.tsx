// Marketr — Phase 8: substrate root redirects to the Business Graph explorer
// (the first substrate track to ship).

import { redirect } from "next/navigation";

export default function SubstratePage() {
  redirect("/dashboard/substrate/graph");
}
