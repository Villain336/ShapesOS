// Marketr — Phase 10: provider-contract barrel.
//
// The M5 difficulty engine (and every other consumer) codes to THIS contract:
//   import { fetchSerp, lookupVolume } from "@/lib/intelligence/providers";
// Real implementations live in M6's modules (routing.ts, volume.ts) — this
// file only re-exports, so M6 can keep evolving the adapters without
// Phase 10: shared provider barrel. M6 owns everything behind it.
// (Historical note: M5 was the first consumer; the barrel is M6's.)

export {
  fetchSerp,
  resolveVendor,
  vendorHealth,
  ALL_VENDORS,
  DEFAULT_ROUTING,
} from "./routing";
export type { FetchSerpDeps } from "./routing";
export {
  lookupVolume,
  plannerVolumeLookup,
  volumeCacheKey,
  isCacheFresh,
  refreshExpiry,
  getVolumeCacheStats,
  VOLUME_CACHE_TTL_DAYS,
  VOLUME_CACHE_MAX_TTL_DAYS,
} from "./volume";
export type { VolumeDeps, VolumeLookupResult, VolumeCacheStore } from "./volume";
export {
  recordApiMeter,
  getDataCostSummary,
  getBudgetStatus,
  assertBudgetAvailable,
  budgetAllows,
  summarizeMeter,
  currentPeriod,
  setDefaultVendor,
} from "./meter";
export type { ApiMeterKind, MeterRecord, DataCostSummary, CostSummaryRow, BudgetStatus } from "./meter";
export { verifyLink } from "./linkverify";
export type { LinkStatus, VerifyLinkResult } from "./linkverify";
export {
  getVendorCredentials,
  getVendorConfigs,
  ensureVendorConfigs,
  buildSerpAdapters,
  vendorEnvVars,
} from "./credentials";
export type { VendorCredentials, VendorConfigRow, RoutingRules } from "./credentials";
export { auditApiCall } from "./audit";
export { SerperAdapter } from "./serper";
export { DataForSeoAdapter, CLICKSTREAM_BULK_COST_USD } from "./dataforseo";
export { TalorDataAdapter } from "./talordata";

export type {
  SerpOrganicResult,
  SerpResponse,
  SerpSearchOpts,
  SerpVendorId,
  SerpProvider,
  VolumeBand,
} from "./types";
export { VendorNotConfigured, BudgetCapExceeded, VolumeUnavailableError, PlannerNotReady } from "./types";
export { VOLUME_BANDS, pointToBand, isVolumeBand } from "./types";

/** Alias used by M1's residual paid-SERP layer (same shape as SerpResponse). */
export type { SerpResponse as SerpResult } from "./types";

// M3/M7 cost metering: the recordApiMeter contract every Phase 10 module
// codes to. Implemented here (metering.ts) so consumers compile and meter
// honestly while M6 owns the full vendor abstraction behind this barrel.
// (M5 note 2026-09-26: recordApiMeter is exported once, from ./meter above —
// the duplicate export from ./metering here broke the barrel; M6 is
// mid-refactor between meter.ts and metering.ts.)
export { meteredSpendMtd, currentMeterPeriod } from "./metering";
