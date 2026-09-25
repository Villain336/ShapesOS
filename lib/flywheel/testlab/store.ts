// Marketr — Test Lab stores (F3).
//
// The Phase 7 fragments are NOT merged into prisma/schema.prisma yet (the
// coordinator merges them), so the prisma store below uses raw SQL against the
// `experiment_ideas` / `experiments` / `experiment_results` tables with a
// readiness probe. The memory store is the battery/fake twin. Both implement
// the same interface — swapping to the typed client is a mechanical change
// after the merge.

import { prisma } from "@/lib/prisma";
import { createId } from "@/lib/media/ids";
import type {
  Experiment, ExperimentStatus, ExperimentVerdict,
} from "./experiment";

/** True when the F3 test-lab tables exist (fragment merged + migrated). */
export async function testlabTablesReady(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe(`SELECT 1 FROM experiments LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

export interface ExperimentIdeaInput {
  title: string;
  sourceSignal?: string;
  pieIceScore: number;
  status?: string;
}

export interface ExperimentIdea {
  id: string;
  workspaceId: string;
  title: string;
  sourceSignal: string | null;
  pieIceScore: number;
  status: string;
  createdAt: string;
}

export interface ExperimentResultRow {
  id: string;
  experimentId: string;
  statsJson: Record<string, unknown>;
  srm: { status: "pass" | "fail"; pValue: number };
  guardrailChecks: unknown[];
  verdict: ExperimentVerdict | null;
  archivedToMemory: boolean;
}

export interface ExperimentStore {
  createIdea(workspaceId: string, input: ExperimentIdeaInput): Promise<ExperimentIdea>;
  listIdeas(workspaceId: string): Promise<ExperimentIdea[]>;
  createExperiment(workspaceId: string, exp: Experiment): Promise<Experiment>;
  getExperiment(workspaceId: string, id: string): Promise<Experiment | null>;
  listExperiments(workspaceId: string): Promise<Experiment[]>;
  updateExperiment(workspaceId: string, id: string, patch: Partial<Experiment>): Promise<Experiment>;
  saveResult(row: Omit<ExperimentResultRow, "id">): Promise<ExperimentResultRow>;
  getResult(experimentId: string): Promise<ExperimentResultRow | null>;
}

// ---------------------------------------------------------------------------
// Memory store (battery + fake twin)
// ---------------------------------------------------------------------------

export function createMemoryExperimentStore(): ExperimentStore {
  const ideas = new Map<string, ExperimentIdea[]>();
  const exps = new Map<string, Map<string, Experiment>>();
  const results = new Map<string, ExperimentResultRow>();

  const byWs = (ws: string) => {
    let m = exps.get(ws);
    if (!m) { m = new Map(); exps.set(ws, m); }
    return m;
  };

  return {
    async createIdea(workspaceId, input) {
      const idea: ExperimentIdea = {
        id: createId(), workspaceId,
        title: input.title, sourceSignal: input.sourceSignal ?? null,
        pieIceScore: input.pieIceScore, status: input.status ?? "queued",
        createdAt: new Date().toISOString(),
      };
      ideas.set(workspaceId, [...(ideas.get(workspaceId) ?? []), idea]);
      return idea;
    },
    async listIdeas(workspaceId) {
      return [...(ideas.get(workspaceId) ?? [])].sort((a, b) => b.pieIceScore - a.pieIceScore);
    },
    async createExperiment(workspaceId, exp) {
      byWs(workspaceId).set(exp.id, { ...exp });
      return { ...exp };
    },
    async getExperiment(workspaceId, id) {
      const e = byWs(workspaceId).get(id);
      return e ? { ...e } : null;
    },
    async listExperiments(workspaceId) {
      return [...byWs(workspaceId).values()].map((e) => ({ ...e }));
    },
    async updateExperiment(workspaceId, id, patch) {
      const cur = byWs(workspaceId).get(id);
      if (!cur) throw new Error(`Experiment not found: ${id}`);
      const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
      byWs(workspaceId).set(id, next);
      return { ...next };
    },
    async saveResult(row) {
      const full: ExperimentResultRow = { ...row, id: createId() };
      results.set(row.experimentId, full);
      return full;
    },
    async getResult(experimentId) {
      return results.get(experimentId) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Prisma store (raw SQL — used after the coordinator merges the fragment)
// ---------------------------------------------------------------------------

type RawExp = Record<string, unknown>;

function rowToExperiment(r: RawExp): Experiment {
  const j = (k: string) => (typeof r[k] === "string" ? JSON.parse(r[k] as string) : (r[k] as unknown));
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    name: r.name as string,
    hypothesis: r.hypothesis as string,
    pieIceScore: Number(r.pie_ice_score),
    channel: r.channel as Experiment["channel"],
    variants: j("variants_json") as Experiment["variants"],
    audience: r.audience as string,
    primaryMetric: r.primary_metric as string,
    metricType: r.metric_type as Experiment["metricType"],
    guardrailMetrics: (j("guardrail_metrics_json") as Experiment["guardrailMetrics"]) ?? [],
    status: r.status as ExperimentStatus,
    profitGuardrail: (r.profit_guardrail_json ? j("profit_guardrail_json") : undefined) as Experiment["profitGuardrail"],
    trafficFloorNote: (r.traffic_floor_note as string) ?? null,
    minRuntimeDays: Number(r.min_runtime_days),
    statedMde: Number(r.stated_mde),
    verdict: (r.verdict as ExperimentVerdict) ?? null,
    baselineRate: Number(r.baseline_rate),
    monthlyTraffic: Number(r.monthly_traffic),
    launchedAt: (r.launched_at as Date)?.toISOString?.() ?? null,
    completedAt: (r.completed_at as Date)?.toISOString?.() ?? null,
    qaReport: (r.qa_report_json ? j("qa_report_json") : null) as Experiment["qaReport"],
    createdBy: r.created_by as string,
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: (r.updated_at as Date).toISOString(),
  };
}

export function createPrismaExperimentStore(): ExperimentStore {
  const q = <T>(sql: string, ...params: unknown[]) =>
    prisma.$queryRawUnsafe(sql, ...params) as Promise<T>;
  const jstr = (v: unknown) => JSON.stringify(v ?? null);

  return {
    async createIdea(workspaceId, input) {
      const id = createId();
      await q(`INSERT INTO experiment_ideas (id, workspace_id, title, source_signal, pie_ice_score, status)
               VALUES ($1,$2,$3,$4,$5,$6)`,
        id, workspaceId, input.title, input.sourceSignal ?? null, input.pieIceScore, input.status ?? "queued");
      const [row] = await q<RawExp[]>(`SELECT * FROM experiment_ideas WHERE id=$1`, id);
      return {
        id: row.id as string, workspaceId: row.workspace_id as string,
        title: row.title as string, sourceSignal: (row.source_signal as string) ?? null,
        pieIceScore: Number(row.pie_ice_score), status: row.status as string,
        createdAt: (row.created_at as Date).toISOString(),
      };
    },
    async listIdeas(workspaceId) {
      const rows = await q<RawExp[]>(`SELECT * FROM experiment_ideas WHERE workspace_id=$1 ORDER BY pie_ice_score DESC`, workspaceId);
      return rows.map((row) => ({
        id: row.id as string, workspaceId: row.workspace_id as string,
        title: row.title as string, sourceSignal: (row.source_signal as string) ?? null,
        pieIceScore: Number(row.pie_ice_score), status: row.status as string,
        createdAt: (row.created_at as Date).toISOString(),
      }));
    },
    async createExperiment(workspaceId, exp) {
      await q(
        `INSERT INTO experiments (id, workspace_id, name, hypothesis, pie_ice_score, channel,
          variants_json, audience, primary_metric, metric_type, guardrail_metrics_json, status,
          profit_guardrail_json, traffic_floor_note, min_runtime_days, stated_mde, verdict,
          baseline_rate, monthly_traffic, launched_at, completed_at, qa_report_json, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        exp.id, workspaceId, exp.name, exp.hypothesis, exp.pieIceScore, exp.channel,
        jstr(exp.variants), exp.audience, exp.primaryMetric, exp.metricType,
        jstr(exp.guardrailMetrics), exp.status, jstr(exp.profitGuardrail),
        exp.trafficFloorNote, exp.minRuntimeDays, exp.statedMde, exp.verdict,
        exp.baselineRate, exp.monthlyTraffic,
        exp.launchedAt ? new Date(exp.launchedAt) : null,
        exp.completedAt ? new Date(exp.completedAt) : null,
        jstr(exp.qaReport), exp.createdBy,
      );
      const got = await this.getExperiment(workspaceId, exp.id);
      if (!got) throw new Error("createExperiment: row not found after insert");
      return got;
    },
    async getExperiment(workspaceId, id) {
      const rows = await q<RawExp[]>(`SELECT * FROM experiments WHERE id=$1 AND workspace_id=$2`, id, workspaceId);
      return rows.length ? rowToExperiment(rows[0]) : null;
    },
    async listExperiments(workspaceId) {
      const rows = await q<RawExp[]>(`SELECT * FROM experiments WHERE workspace_id=$1 ORDER BY created_at DESC`, workspaceId);
      return rows.map(rowToExperiment);
    },
    async updateExperiment(workspaceId, id, patch) {
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col}=$${params.length}`); };
      if (patch.status) set("status", patch.status);
      if (patch.verdict !== undefined) set("verdict", patch.verdict);
      if (patch.launchedAt !== undefined) set("launched_at", patch.launchedAt ? new Date(patch.launchedAt) : null);
      if (patch.completedAt !== undefined) set("completed_at", patch.completedAt ? new Date(patch.completedAt) : null);
      if (patch.qaReport !== undefined) set("qa_report_json", jstr(patch.qaReport));
      if (patch.trafficFloorNote !== undefined) set("traffic_floor_note", patch.trafficFloorNote);
      if (sets.length) {
        params.push(id, workspaceId);
        await q(`UPDATE experiments SET ${sets.join(", ")}, updated_at=now() WHERE id=$${params.length - 1} AND workspace_id=$${params.length}`, ...params);
      }
      const got = await this.getExperiment(workspaceId, id);
      if (!got) throw new Error(`Experiment not found: ${id}`);
      return got;
    },
    async saveResult(row) {
      const id = createId();
      await q(`INSERT INTO experiment_results (id, experiment_id, stats_json, srm_json, guardrail_checks_json, verdict, archived_to_memory)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (experiment_id) DO UPDATE SET stats_json=EXCLUDED.stats_json,
                 srm_json=EXCLUDED.srm_json, guardrail_checks_json=EXCLUDED.guardrail_checks_json,
                 verdict=EXCLUDED.verdict, archived_to_memory=EXCLUDED.archived_to_memory`,
        id, row.experimentId, jstr(row.statsJson), jstr(row.srm), jstr(row.guardrailChecks),
        row.verdict, row.archivedToMemory);
      const got = await this.getResult(row.experimentId);
      if (!got) throw new Error("saveResult: row not found after upsert");
      return got;
    },
    async getResult(experimentId) {
      const rows = await q<RawExp[]>(`SELECT * FROM experiment_results WHERE experiment_id=$1`, experimentId);
      if (!rows.length) return null;
      const r = rows[0];
      const srm = (typeof r.srm_json === "string" ? JSON.parse(r.srm_json as string) : r.srm_json) as { status: "pass" | "fail"; pValue: number };
      return {
        id: r.id as string,
        experimentId: r.experiment_id as string,
        statsJson: (typeof r.stats_json === "string" ? JSON.parse(r.stats_json as string) : r.stats_json) as Record<string, unknown>,
        srm,
        guardrailChecks: (typeof r.guardrail_checks_json === "string" ? JSON.parse(r.guardrail_checks_json as string) : r.guardrail_checks_json) as unknown[],
        verdict: (r.verdict as ExperimentVerdict) ?? null,
        archivedToMemory: Boolean(r.archived_to_memory),
      };
    },
  };
}

/** Resolve the right store: prisma when tables are migrated, memory otherwise. */
export async function resolveExperimentStore(): Promise<{ store: ExperimentStore; persistent: boolean }> {
  if (await testlabTablesReady()) {
    return { store: createPrismaExperimentStore(), persistent: true };
  }
  return { store: createMemoryExperimentStore(), persistent: false };
}
