// ShapesOS — Phase 16: browser events between agent-activity views (PURE,
// no imports, so the sidebar — on every page — pulls in nothing else).

/**
 * Fired by the chat's delegation card when a plan's progress changes, so the
 * sidebar's "Running now" tree refreshes at once instead of waiting for its
 * 45 s poll (a delegation often finishes in seconds).
 */
export const AGENT_ACTIVITY_CHANGED_EVENT = "shapes:agent-activity-changed";
