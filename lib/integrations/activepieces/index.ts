// Marketr — Activepieces integration barrel (Phase 12, Worker 3).
// Server-only: imports the engine REST client and the npm piece catalog.

export * from "./types";
export {
  activepiecesApiPrefix,
  activepiecesStatus,
  isActivepiecesConfigured,
  normalizeEngineUrl,
  probeActivepiecesEngine,
  readActivepiecesConfig,
} from "./config";
export {
  getFlow,
  getFlowRun,
  latestFlowRun,
  listFlows,
  pollFlowRun,
  preflightTrigger,
  triggerFlow,
  type FlowPage,
  type ListFlowsOptions,
  type PollOptions,
  type TriggerPreflight,
} from "./client";
export {
  bindFlowToWorkspace,
  FlowBindingConflictError,
  FlowNotBoundError,
  prismaFlowBindingStore,
  workspaceFlows,
  type FlowBindingStore,
  type FlowEngine,
} from "./bindings";
export {
  AUTOMATION_RECIPES,
  curatedPiece,
  curatedPieces,
  getRecipe,
} from "./pieces";
