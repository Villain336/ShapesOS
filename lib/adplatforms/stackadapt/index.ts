// Marketr — Phase 18 slice 3: StackAdapt connector entry point.
//
// Import this module wherever the StackAdapt connector must be live (the
// proposals execute path, the reporting pull path).
// registerStackAdaptConnectors() is idempotent: it installs the spend
// executor and the report normalizer into the slice-1 registries.

import { registerAdsExecutor } from "../actions";
import { registerAdReportNormalizer } from "../reporting";
import { createStackAdaptExecutor, type StackAdaptExecutorDeps } from "./executor";
import { normalizeStackAdaptReportRows } from "./reporting";

export * from "./client";
export * from "./keys";
export * from "./connect";
export * from "./executor";
export * from "./reporting";

export function registerStackAdaptConnectors(deps: StackAdaptExecutorDeps = {}): void {
  registerAdsExecutor("stackadapt", createStackAdaptExecutor(deps));
  registerAdReportNormalizer("stackadapt", (raw) => normalizeStackAdaptReportRows(raw));
}
