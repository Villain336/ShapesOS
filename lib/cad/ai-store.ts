// Marketr — CAD + Hardware slice 2: AI design assistant store.
// Extends the slice-1 PrismaCadStore (projects → models → immutable versions)
// with annotations, design-change proposals (draft-for-approval), and
// manufacturability runs + flags.
//
// THE PROPOSAL-EXECUTION BOUNDARY (v1): the ONLY code path that sets
// CadModel.changeRequested is approveProposal (human-only). There is no
// method anywhere in this codebase that rewrites mesh geometry from a
// proposal — proposing, approving, and tracking is the v1 contract. An
// approved proposal means "a human asked for this change"; the edit happens
// in the tenant's CAD tool and arrives as a new published version, which
// clears the change-requested flag.
//
// Tenant-scoping: every read filters on workspaceId, like the parent store.

import type { Prisma, CadDesignProposal } from "@prisma/client";
import { PrismaCadStore } from "./prisma-store";
import { extractMeshTriangles } from "./geometry";
import {
  MFG_REFERENCES,
  UNIT_ASSUMPTION,
  runManufacturabilityChecks,
} from "./manufacturability";
import {
  DESIGN_OPERATIONS,
  isDesignOperation,
  parseDesignRequest,
  validateTargetRegion,
  type DesignOperation,
  type ParsedDesignRequest,
} from "./design-proposals";
import { CadError, type VersionInput } from "./types";
import { notifyApprovalNeeded } from "@/lib/notifications/producers";

export interface CadActor {
  kind: "human" | "agent";
  identity: string;
}

/**
 * Human-only gate for consequential actions (approving/rejecting design
 * proposals). Mirrors the connector's requireHumanActor: agents may draft,
 * only the tenant human may decide.
 */
export function requireCadHuman(actor: CadActor, action: string): string {
  if (!actor || actor.kind !== "human") {
    throw new CadError(
      "AGENT_CANNOT_ACT",
      `${action} is a human-only action: an agent cannot decide on anyone's behalf, including the tenant's. A human identity is required.`,
    );
  }
  const identity = actor.identity.trim();
  if (!identity) {
    throw new CadError("INVALID_ACTOR", `${action} requires a non-empty human identity.`);
  }
  return identity;
}

export type AnnotationAnchor =
  | { kind: "point"; point: [number, number, number] }
  | { kind: "region"; region: { min: [number, number, number]; max: [number, number, number] } }
  | { kind: "whole" };

function validateAnchor(anchor: AnnotationAnchor): void {
  if (anchor.kind === "point") {
    const p = anchor.point;
    if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw new CadError("INVALID_ANCHOR", "The annotation point must be three finite numbers [x, y, z].");
    }
  } else if (anchor.kind === "region") {
    validateTargetRegion(anchor.region);
  }
}

function anchorColumns(anchor: AnnotationAnchor): {
  point: Prisma.InputJsonValue | undefined;
  region: Prisma.InputJsonValue | undefined;
} {
  if (anchor.kind === "point") return { point: anchor.point as unknown as Prisma.InputJsonValue, region: undefined };
  if (anchor.kind === "region") return { point: undefined, region: anchor.region as unknown as Prisma.InputJsonValue };
  return { point: undefined, region: undefined };
}

const PROPOSAL_STATUSES = ["draft", "approved", "rejected"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

function isProposalStatus(v: string): v is ProposalStatus {
  return (PROPOSAL_STATUSES as readonly string[]).includes(v);
}

export class PrismaCadAiStore extends PrismaCadStore {
  private async requireModelRow(workspaceId: string, modelId: string) {
    const model = await this.prisma.cadModel.findFirst({
      where: { id: modelId, workspaceId },
    });
    if (!model) throw new CadError("MODEL_NOT_FOUND", "CAD model not found.");
    return model;
  }

  private async requireVersionRow(workspaceId: string, modelId: string, versionId: string) {
    const version = await this.prisma.cadModelVersion.findFirst({
      where: { id: versionId, modelId, workspaceId },
    });
    if (!version) throw new CadError("VERSION_NOT_FOUND", "CAD model version not found.");
    return version;
  }

  /**
   * Publishing a new version resolves any pending change request: the new
   * geometry supersedes the approved proposal's intent.
   */
  override async addModelVersion(
    workspaceId: string,
    actor: string,
    modelId: string,
    input: VersionInput,
  ) {
    const row = await super.addModelVersion(workspaceId, actor, modelId, input);
    await this.prisma.cadModel.update({
      where: { id: modelId },
      data: {
        changeRequested: false,
        changeRequestedAt: null,
        changeRequestedBy: null,
        changeRequestedProposalId: null,
      },
    });
    return row;
  }

  // ---------- Annotations ----------

  async createAnnotation(
    workspaceId: string,
    author: string,
    modelId: string,
    versionId: string,
    body: string,
    anchor: AnnotationAnchor,
  ) {
    const text = body.trim();
    if (!text) throw new CadError("INVALID_BODY", "The annotation text cannot be empty.");
    if (text.length > 2000)
      throw new CadError("INVALID_BODY", "Annotations must be 2,000 characters or fewer.");
    validateAnchor(anchor);
    await this.requireModelRow(workspaceId, modelId);
    await this.requireVersionRow(workspaceId, modelId, versionId);
    return this.prisma.cadAnnotation.create({
      data: {
        workspaceId,
        modelId,
        versionId,
        author,
        body: text,
        ...anchorColumns(anchor),
      },
    });
  }

  async listAnnotations(workspaceId: string, modelId: string, versionId?: string) {
    await this.requireModelRow(workspaceId, modelId);
    return this.prisma.cadAnnotation.findMany({
      where: { workspaceId, modelId, ...(versionId ? { versionId } : {}) },
      orderBy: { createdAt: "asc" },
    });
  }

  async deleteAnnotation(workspaceId: string, annotationId: string) {
    const row = await this.prisma.cadAnnotation.findFirst({
      where: { id: annotationId, workspaceId },
    });
    if (!row) throw new CadError("ANNOTATION_NOT_FOUND", "Annotation not found.");
    await this.prisma.cadAnnotation.delete({ where: { id: annotationId } });
    return { deleted: true };
  }

  // ---------- Design proposals ----------

  /**
   * Draft a design-change proposal from a natural-language request. Parsing
   * happens here; NOTHING is executed — the proposal enters the approval
   * queue as a draft for the human to review.
   */
  async createProposal(
    workspaceId: string,
    requestedBy: string,
    modelId: string,
    targetVersionId: string,
    requestedText: string,
    targetRegion?: { min: [number, number, number]; max: [number, number, number] } | null,
  ): Promise<{ proposal: CadDesignProposal; parse: ParsedDesignRequest }> {
    await this.requireModelRow(workspaceId, modelId);
    await this.requireVersionRow(workspaceId, modelId, targetVersionId);
    validateTargetRegion(targetRegion);
    const parse = parseDesignRequest(requestedText);
    const proposal = await this.prisma.cadDesignProposal.create({
      data: {
        workspaceId,
        modelId,
        targetVersionId,
        requestedText: requestedText.trim(),
        requestedBy,
        operation: parse.operation,
        parameters: parse.parameters as unknown as Prisma.InputJsonValue,
        targetFeatureLabel: parse.featureLabel,
        targetRegion: targetRegion ? (targetRegion as unknown as Prisma.InputJsonValue) : undefined,
        rationale: parse.rationale,
        parseConfidence: parse.confidence,
        status: "draft",
      },
    });
    // Phase 3 (J): best-effort "needs you" notification (never throws).
    await notifyApprovalNeeded({
      workspaceId,
      source: "cad",
      sourceId: proposal.id,
      title: requestedText.trim().slice(0, 160),
      href: "/dashboard/cad",
      requestedBy,
    });
    return { proposal, parse };
  }

  async listProposals(workspaceId: string, modelId: string, status?: string) {
    await this.requireModelRow(workspaceId, modelId);
    if (status !== undefined && !isProposalStatus(status)) {
      throw new CadError("INVALID_STATUS", `Status must be one of: ${PROPOSAL_STATUSES.join(", ")}.`);
    }
    return this.prisma.cadDesignProposal.findMany({
      where: { workspaceId, modelId, ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
    });
  }

  async getProposal(workspaceId: string, proposalId: string) {
    const proposal = await this.prisma.cadDesignProposal.findFirst({
      where: { id: proposalId, workspaceId },
      include: { targetVersion: true },
    });
    if (!proposal) throw new CadError("PROPOSAL_NOT_FOUND", "Design proposal not found.");
    return proposal;
  }

  /** The human reviews the parse and may fix any field while the draft is open. */
  async updateProposalDraft(
    workspaceId: string,
    proposalId: string,
    patch: {
      operation?: string;
      parameters?: Record<string, unknown>;
      targetFeatureLabel?: string | null;
      rationale?: string | null;
    },
  ) {
    const proposal = await this.getProposal(workspaceId, proposalId);
    if (proposal.status !== "draft") {
      throw new CadError("INVALID_TRANSITION", "Only a draft proposal can be edited.");
    }
    if (patch.operation !== undefined && !isDesignOperation(patch.operation)) {
      throw new CadError("INVALID_OPERATION", `Operation must be one of: ${DESIGN_OPERATIONS.join(", ")}.`);
    }
    if (patch.parameters !== undefined) {
      if (!patch.parameters || typeof patch.parameters !== "object" || Array.isArray(patch.parameters)) {
        throw new CadError("INVALID_PARAMETERS", "Parameters must be a JSON object.");
      }
    }
    return this.prisma.cadDesignProposal.update({
      where: { id: proposalId },
      data: {
        ...(patch.operation !== undefined ? { operation: patch.operation as DesignOperation } : {}),
        ...(patch.parameters !== undefined ? { parameters: patch.parameters as unknown as Prisma.InputJsonValue } : {}),
        ...(patch.targetFeatureLabel !== undefined ? { targetFeatureLabel: patch.targetFeatureLabel?.trim() || null } : {}),
        ...(patch.rationale !== undefined ? { rationale: patch.rationale?.trim()?.slice(0, 2000) || null } : {}),
      },
    });
  }

  /**
   * Approve a draft proposal (human-only). The ONLY code path that sets
   * CadModel.changeRequested. No geometry is touched — the v1 contract is
   * propose → approve → track; execution happens in the tenant's CAD tool.
   */
  async approveProposal(
    workspaceId: string,
    actor: CadActor,
    proposalId: string,
    note?: string | null,
  ) {
    const decidedBy = requireCadHuman(actor, "approve_design_proposal");
    const proposal = await this.getProposal(workspaceId, proposalId);
    if (proposal.status !== "draft") {
      throw new CadError("INVALID_TRANSITION", `Only a draft proposal can be approved (current: ${proposal.status}).`);
    }
    const decisionNote = note?.trim().slice(0, 2000) || null;
    const decidedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.cadDesignProposal.update({
        where: { id: proposalId },
        data: { status: "approved", decidedBy, decidedAt, decisionNote },
      }),
      this.prisma.cadModel.update({
        where: { id: proposal.modelId },
        data: {
          changeRequested: true,
          changeRequestedAt: decidedAt,
          changeRequestedBy: decidedBy,
          changeRequestedProposalId: proposalId,
        },
      }),
    ]);
    return this.getProposal(workspaceId, proposalId);
  }

  /** Reject a draft proposal (human-only). The model is untouched. */
  async rejectProposal(
    workspaceId: string,
    actor: CadActor,
    proposalId: string,
    note?: string | null,
  ) {
    const decidedBy = requireCadHuman(actor, "reject_design_proposal");
    const proposal = await this.getProposal(workspaceId, proposalId);
    if (proposal.status !== "draft") {
      throw new CadError("INVALID_TRANSITION", `Only a draft proposal can be rejected (current: ${proposal.status}).`);
    }
    return this.prisma.cadDesignProposal.update({
      where: { id: proposalId },
      data: {
        status: "rejected",
        decidedBy,
        decidedAt: new Date(),
        decisionNote: note?.trim().slice(0, 2000) || null,
      },
    });
  }

  // ---------- Manufacturability ----------

  /**
   * Run the manufacturability analysis over a version's REAL mesh geometry.
   * STEP versions get an "unavailable" run — analysis is never invented for
   * a format with no extractable geometry.
   */
  async runManufacturability(
    workspaceId: string,
    startedBy: string,
    modelId: string,
    versionId: string,
  ) {
    await this.requireModelRow(workspaceId, modelId);
    const version = await this.requireVersionRow(workspaceId, modelId, versionId);
    const references = MFG_REFERENCES as unknown as Prisma.InputJsonValue;

    if (version.format === "step") {
      const run = await this.prisma.cadMfgRun.create({
        data: {
          workspaceId,
          modelId,
          versionId,
          status: "unavailable",
          unavailableReason:
            "STEP has no extractable mesh geometry in v1 — the analysis cannot run on STEP files. Upload an STL or OBJ export of this model to analyze it.",
          unitAssumption: UNIT_ASSUMPTION,
          checks: [
            { check: "wall_thickness", status: "unavailable", detail: "STEP: no mesh geometry to analyze." },
            { check: "overhang", status: "unavailable", detail: "STEP: no mesh geometry to analyze." },
            { check: "tolerance", status: "unavailable", detail: "STEP: no mesh geometry to analyze." },
          ] as unknown as Prisma.InputJsonValue,
          references,
          startedBy,
          completedAt: new Date(),
        },
      });
      return { run, flags: [] as const };
    }

    const { bytes } = await this.getVersionFile(workspaceId, modelId, versionId);
    const mesh = extractMeshTriangles(bytes, version.format as "stl" | "obj");
    if (!mesh) {
      const run = await this.prisma.cadMfgRun.create({
        data: {
          workspaceId,
          modelId,
          versionId,
          status: "unavailable",
          unavailableReason:
            "Could not extract mesh triangles from the stored file bytes — the analysis cannot run on this version.",
          unitAssumption: UNIT_ASSUMPTION,
          checks: [
            { check: "wall_thickness", status: "unavailable", detail: "Triangle extraction failed — nothing to analyze." },
            { check: "overhang", status: "unavailable", detail: "Triangle extraction failed — nothing to analyze." },
            { check: "tolerance", status: "unavailable", detail: "Triangle extraction failed — nothing to analyze." },
          ] as unknown as Prisma.InputJsonValue,
          references,
          startedBy,
          completedAt: new Date(),
        },
      });
      return { run, flags: [] as const };
    }

    const result = runManufacturabilityChecks(mesh.positions, mesh.triangleCount);
    const run = await this.prisma.$transaction(async (tx) => {
      const created = await tx.cadMfgRun.create({
        data: {
          workspaceId,
          modelId,
          versionId,
          status: "complete",
          unitAssumption: UNIT_ASSUMPTION,
          checks: result.checks as unknown as Prisma.InputJsonValue,
          references,
          startedBy,
          completedAt: new Date(),
        },
      });
      if (result.flags.length > 0) {
        await tx.cadManufacturabilityFlag.createMany({
          data: result.flags.map((f) => ({
            workspaceId,
            runId: created.id,
            modelId,
            versionId,
            checkType: f.checkType,
            severity: f.severity,
            measurement: f.measurement as unknown as Prisma.InputJsonValue,
            message: f.message,
          })),
        });
      }
      return created;
    });
    const flags = await this.prisma.cadManufacturabilityFlag.findMany({
      where: { runId: run.id, workspaceId },
      orderBy: { createdAt: "asc" },
    });
    return { run, flags };
  }

  async listMfgRuns(workspaceId: string, modelId: string, versionId?: string) {
    await this.requireModelRow(workspaceId, modelId);
    return this.prisma.cadMfgRun.findMany({
      where: { workspaceId, modelId, ...(versionId ? { versionId } : {}) },
      orderBy: { startedAt: "desc" },
      include: { _count: { select: { flags: true } } },
    });
  }

  async listMfgFlags(workspaceId: string, modelId: string, versionId?: string) {
    await this.requireModelRow(workspaceId, modelId);
    return this.prisma.cadManufacturabilityFlag.findMany({
      where: { workspaceId, modelId, ...(versionId ? { versionId } : {}) },
      orderBy: { createdAt: "asc" },
    });
  }

  /** Dismiss a flag — a reason is required (audit trail). Idempotent. */
  async dismissFlag(
    workspaceId: string,
    actor: string,
    flagId: string,
    reason: string,
  ) {
    const flag = await this.prisma.cadManufacturabilityFlag.findFirst({
      where: { id: flagId, workspaceId },
    });
    if (!flag) throw new CadError("FLAG_NOT_FOUND", "Manufacturability flag not found.");
    const trimmed = reason.trim();
    if (!trimmed) throw new CadError("INVALID_REASON", "Dismissing a flag requires a reason.");
    if (trimmed.length > 500)
      throw new CadError("INVALID_REASON", "The dismissal reason must be 500 characters or fewer.");
    if (flag.dismissed) return flag;
    return this.prisma.cadManufacturabilityFlag.update({
      where: { id: flagId },
      data: {
        dismissed: true,
        dismissedBy: actor,
        dismissedAt: new Date(),
        dismissalReason: trimmed,
      },
    });
  }

  /** Model detail with the slice-2 collections (proposals, annotations, runs, flags). */
  async getModelAiDetail(workspaceId: string, modelId: string) {
    const base = await super.getModelDetail(workspaceId, modelId);
    const [proposals, annotations, mfgRuns, mfgFlags] = await Promise.all([
      this.prisma.cadDesignProposal.findMany({
        where: { workspaceId, modelId },
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.cadAnnotation.findMany({
        where: { workspaceId, modelId },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.cadMfgRun.findMany({
        where: { workspaceId, modelId },
        orderBy: { startedAt: "desc" },
      }),
      this.prisma.cadManufacturabilityFlag.findMany({
        where: { workspaceId, modelId },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    return { ...base, proposals, annotations, mfgRuns, mfgFlags };
  }
}
