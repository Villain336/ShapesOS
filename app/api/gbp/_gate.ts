// Marketr — GBP management scaffold API (milestone 16).
//
// EVERYTHING under /api/gbp is behind FEATURE_GBP_MANAGEMENT until the GBP
// API application is approved. When the flag is off, routes return 404 —
// the UI never links here either (see the /local page).

import { NextResponse } from "next/server";
import { gbpManagementEnabled } from "@/lib/local/gbp";

/** Shared gate for all GBP routes. */
export function gbpGate() {
  if (!gbpManagementEnabled()) {
    return NextResponse.json(
      { error: "GBP management is not enabled (FEATURE_GBP_MANAGEMENT)" },
      { status: 404 },
    );
  }
  return null;
}
