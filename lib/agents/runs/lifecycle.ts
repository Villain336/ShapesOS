// Marketr — Phase 16 slice 5: agent-run lifecycle for browser runs.
//
// Minimal server-side wiring of the recorder into the agent run lifecycle:
// an agent turn (or mission step) calls executeBrowserRun() to get a
// persisted AgentRun (linked to threadId/missionId) + recorded WebM video +
// Playwright trace + a structured AgentRunEvent timeline.
//
// The actual browser driving arrives as the caller's `execute` callback —
// this slice records and persists; it does not implement web automation.
// Nothing here is exposed to the client; browser control stays server-side.
// Viewer UI (slice 6) and live watch (slice 7) consume the persisted rows.

import type { BrowserRunOutcome, AgentRunLinkage } from "./types";
import {
  AgentRunRecorder,
  RecorderBusyError,
  recordingRetentionUntil,
  type BrowserLauncher,
  type RecorderPage,
  type RequestGuard,
} from "./recorder";
import { publishRecordingArtifacts } from "./artifacts";
import {
  createAgentRun,
  markAgentRunRunning,
  appendAgentRunEvent,
  appendAguiEvent,
  attachAgentRunRecording,
  finishAgentRun,
} from "./service";

export { RecorderBusyError };

export interface BrowserRunRequest extends AgentRunLinkage {
  workspaceId: string;
  /** Human/service identity that requested the run (audit). */
  startedBy: string;
  /** Page the run opens with (optional; the callback may navigate itself). */
  startUrl?: string;
  /** Headed (watchable) vs headless-shell. Defaults to headless. */
  headless?: boolean;
  /**
   * Slice 7: attach the live watch stream (CDP screencast) to this run.
   * Defaults to false — pass true for headed "watch it work" runs.
   */
  watch?: boolean;
  /** CoAgents snapshot at run start (optional). */
  agentState?: Record<string, unknown>;
  /** Phase 8: SSRF guard for every request the browser makes. */
  guardRequest?: RequestGuard;
}

export interface BrowserRunDeps {
  /** Injected launcher (tests); production uses the real Chromium launcher. */
  launcher?: BrowserLauncher;
  /**
   * The agent's browser work. Receives the recorded page plus a
   * recordAction() helper — call it after each meaningful action so the
   * timeline reads like the run actually unfolded.
   */
  execute: (ctx: {
    page: RecorderPage;
    recordAction: (summary: string, payload?: Record<string, unknown>) => Promise<void>;
    /** Phase 8: the run's artifact directory (screenshots are kept beside the trace). */
    artifactDir: string;
    /** Phase 8: the browser run's id (the tool links the calling run to it). */
    runId: string;
  }) => Promise<BrowserRunOutcome>;
}

export interface BrowserRunResult {
  runId: string;
  status: "succeeded" | "failed";
  /** Deploy PR: blob refs ("blob:run-recordings/…"), not filesystem paths. */
  videoPath: string | null;
  tracePath: string | null;
  stepCount: number;
  sizeBytes: number;
  /** Phase 8: the structured result the execute callback returned. */
  result: Record<string, unknown>;
}

/**
 * Deploy PR: upload the stopped recording to the shared blob store (so any
 * replica can serve it) and note a failed upload on the run's timeline.
 */
async function publishStopped(
  workspaceId: string,
  runId: string,
  artifactDir: string,
  stopped: { videoPath: string | null; tracePath: string },
) {
  const published = await publishRecordingArtifacts({
    workspaceId,
    runId,
    artifactDir,
    videoPath: stopped.videoPath,
    tracePath: stopped.tracePath || null,
  });
  if (published.errors.length) {
    await appendAgentRunEvent(workspaceId, runId, {
      type: "note",
      summary: "The recording could not be saved to shared storage",
      payload: { errors: published.errors.slice(0, 5) },
    }).catch(() => undefined);
  }
  return published;
}

/**
 * Run one recorded browser run end-to-end:
 *   create AgentRun (queued) → mark running → start recorder (video+trace)
 *   → execute callback → stop recorder → attach recording → finish run.
 *
 * Events are appended to the timeline at every transition. On failure the
 * run is finished `failed` with the error as a `note` event, the recorder
 * is still stopped (artifacts kept), and the error rethrows.
 */
export async function executeBrowserRun(
  request: BrowserRunRequest,
  deps: BrowserRunDeps,
): Promise<BrowserRunResult> {
  if (!request.workspaceId) throw new Error("executeBrowserRun: workspaceId is required");

  const run = await createAgentRun({
    workspaceId: request.workspaceId,
    kind: "browser",
    startedBy: request.startedBy,
    threadId: request.threadId,
    missionId: request.missionId,
    agentState: request.agentState,
    // Phase 8: a browser tool's run hangs under the agent run that called it.
    agentKey: request.agentKey,
    parentRunId: request.parentRunId,
  });
  const { workspaceId, id: runId } = { workspaceId: request.workspaceId, id: run.id };

  await markAgentRunRunning(workspaceId, runId);
  await appendAguiEvent(workspaceId, runId, "Browser run requested", {
    threadId: request.threadId ?? null,
    missionId: request.missionId ?? null,
    startUrl: request.startUrl ?? null,
  });

  const recorder = new AgentRunRecorder({
    runId,
    launcher: deps.launcher,
    headless: request.headless,
    watch: request.watch ?? false,
    // Deploy PR: relay the live watch so any web replica can serve it.
    workspaceId,
    guardRequest: request.guardRequest,
    onTimelineEvent: (event) => {
      void appendAgentRunEvent(workspaceId, runId, event);
    },
  });

  try {
    const { page } = await recorder.start(request.startUrl);
    const recordAction = (summary: string, payload?: Record<string, unknown>) =>
      recorder.recordAction(summary, payload);
    const outcome = await deps.execute({ page, recordAction, artifactDir: recorder.artifactDir, runId });
    const stopped = await recorder.stop();
    const published = await publishStopped(workspaceId, runId, recorder.artifactDir, stopped);
    await attachAgentRunRecording(workspaceId, runId, {
      videoPath: published.videoRef,
      tracePath: published.traceRef,
      stepCount: stopped.stepCount,
      sizeBytes: published.sizeBytes,
      retentionUntil: recordingRetentionUntil(),
    });
    await appendAguiEvent(workspaceId, runId, "Browser run finished", {
      status: "succeeded",
      stepCount: stopped.stepCount,
      sizeBytes: stopped.sizeBytes,
    });
    await finishAgentRun(workspaceId, runId, "succeeded");
    return {
      runId,
      status: "succeeded",
      videoPath: published.videoRef,
      tracePath: published.traceRef,
      stepCount: stopped.stepCount,
      sizeBytes: published.sizeBytes,
      result: outcome.result,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Keep the artifacts: a failed run's trace is the most valuable one.
    try {
      const s = await recorder.stop();
      if (s.tracePath) {
        const published = await publishStopped(workspaceId, runId, recorder.artifactDir, s);
        if (published.traceRef || published.videoRef) {
          await attachAgentRunRecording(workspaceId, runId, {
            videoPath: published.videoRef,
            tracePath: published.traceRef,
            stepCount: s.stepCount,
            sizeBytes: published.sizeBytes,
            retentionUntil: recordingRetentionUntil(),
          });
        }
      }
    } catch {
      // Recorder teardown already best-effort; never mask the run error.
    }
    await appendAgentRunEvent(workspaceId, runId, {
      type: "note",
      summary: `Browser run failed: ${message}`,
      payload: { error: message },
    });
    await finishAgentRun(workspaceId, runId, "failed");
    throw err;
  }
}
