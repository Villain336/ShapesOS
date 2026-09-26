// Marketr — Phase 10 M1: GSC-first rank intelligence — public surface.
//
// computeDeltas is the measurement primitive M2's platform-change radar
// consumes. Its signature is frozen:
//
//   computeDeltas(workspaceId, projectId, pre: {start,end}, post: {start,end}): Promise<PageQueryDelta[]>

export type {
  GscGranularity,
  GscSnapshotRow,
  DateWindow,
  PageQueryDelta,
  WinnersLosers,
  RankTableRow,
  CheckSource,
} from "./types";

export {
  pullSnapshots,
  querySearchAnalytics,
  getGscToken,
  GSC_CONNECTOR_KEY,
  GSC_MAX_ROWS_PER_DAY,
  GSC_QPM,
} from "./client";
export type { GscToken, PullResult, SearchAnalyticsParams, ClientDeps } from "./client";

export { computeDeltas, aggregateRows, diffAggregates, chooseSnapshots } from "./deltas";

export { recomputeGscVisibility, MIN_MOVER_MAGNITUDE } from "./visibility";
export type { GscVisibility } from "./visibility";

export { scoreFromQueryAggregates } from "./scoring";

export {
  isLongTailKeyword,
  checkCadence,
  isCheckDue,
  LONG_TAIL_WORD_COUNT,
  LONG_TAIL_VOLUME_MAX,
} from "./schedule";
export type { CheckCadence, CadenceKeyword } from "./schedule";

export { aggregateWindowQueries } from "./window-score";
export type { QueryAggregate } from "./window-score";

export { getBigQueryExportStatus, saveBigQueryExportConfig, queryBigQueryExport } from "./bigquery";
export type { BigQueryExportStatus } from "./bigquery";

export {
  resolveRankChecks,
  classifyCheckSource,
  paidCallCount,
} from "./paid-serp";
export type { RankCheckKeyword, ResidualDeps, FetchSerpFn } from "./paid-serp";

export {
  enqueueInspection,
  drainInspectionQueue,
  inspectUrlStub,
  inspectionQuotaRemaining,
  INSPECTION_QPD_CAP,
  dataSourceStore,
} from "./inspection";
export type {
  InspectionRequest,
  InspectionResult,
  InspectionPriority,
  DrainResult,
  QueueStore,
} from "./inspection";
