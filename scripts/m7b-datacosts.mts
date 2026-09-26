// M7b data-costs flow test: record meter rows via the shared contract,
// then print getDataCostSummary (the exact function the data-costs route
// awaits). Workspace = the radar fixture workspace to keep test data together.
import { recordApiMeter } from "@/lib/intelligence/providers";
import { getDataCostSummary, currentPeriod } from "@/lib/intelligence/providers/meter";

const WS = "cmugiiinz0000zst9qzif35cx";
await recordApiMeter(WS, "serpapi", "serp_call", 3, 0.03);
await recordApiMeter(WS, "dataforseo", "volume_lookup", 10, 0.0); // cache hit = free
await recordApiMeter(WS, "volume_cache", "volume_lookup", 40, 0.0);
const period = currentPeriod();
console.log("period:", period);
const summary = await getDataCostSummary(WS, period);
console.log("rows:", JSON.stringify(summary.rows, null, 1));
console.log("totalCostUsd:", summary.totalCostUsd, "totalCalls:", summary.totalCalls);
console.log("volumeCacheHitRate:", summary.volumeCacheHitRate);
const { prisma } = await import("@/lib/prisma");
await prisma.$disconnect();
