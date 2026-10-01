// Marketr — Phase 18 slice 2: Amazon Ads connector entry point.
//
// Import this module wherever the Amazon connector must be live (the
// proposals execute path, the reporting pull path). registerAmazonConnectors()
// is idempotent: it installs the spend executor and the report normalizer
// into the slice-1 registries.

import { registerAdsExecutor } from "../actions";
import { registerAdReportNormalizer } from "../reporting";
import { createAmazonExecutor, type AmazonExecutorDeps } from "./executor";
import { normalizeAmazonReportRows } from "./reporting";

export * from "./client";
export * from "./tokens";
export * from "./callback";
export * from "./executor";
export * from "./reporting";

export function registerAmazonConnectors(deps: AmazonExecutorDeps = {}): void {
  registerAdsExecutor("amazon", createAmazonExecutor(deps));
  registerAdReportNormalizer("amazon", (raw) => normalizeAmazonReportRows(raw));
}
