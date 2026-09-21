// Marketr — GBP feature status (milestone 16). Unflagged: reports the flag.
import { gbpManagementEnabled } from "@/lib/local/gbp";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    enabled: gbpManagementEnabled(),
    provider: "mock-gbp",
    note: gbpManagementEnabled()
      ? "GBP management is enabled (mock provider — no live Google calls yet)."
      : "GBP management is off. Flip FEATURE_GBP_MANAGEMENT=true after the GBP API application is approved and credentials are configured.",
  });
}
