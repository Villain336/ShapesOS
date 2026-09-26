// Marketr — Platform-change radar: volatility corroboration.
// GET /api/intelligence/radar/volatility — read-only tracker readings (display only).

import { requireUser } from "@/lib/session";
import { getVolatilityReadings } from "@/lib/intelligence/radar/volatility";

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ readings: await getVolatilityReadings() });
}
