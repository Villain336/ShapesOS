// Marketr — CAD + Hardware slice 1: Prisma store.
// Tenant-scoped CAD project + model registry with immutable version chains.
//
// Upload pipeline: the ORIGINAL file bytes go through the existing
// filesystem pipeline (writeFile — 25 MB cap, quota, upload audit) into
// /files/cad/<projectId>/<modelId>/ with a version-distinct filename (never
// overwritten). One safety note: writeFile's generic MIME allow-list cannot
// classify binary mesh formats (an 80-byte STL header has no magic bytes),
// so CAD uploads use skipSafety + the CAD-specific signature check in
// geometry.ts (sniffCadFormat) as their validation gate — documented, not
// waved through. Quota + size cap still apply.
//
// Version rows are create-only: a new upload never mutates a published row;
// the model's currentVersion pointer moves forward. Geometry stats are
// recorded when computable (STL/OBJ); STEP rows always carry nulls +
// previewAvailable=false. A diff vs the previous version is computed at
// publish time when both sides have stats, else recorded "unavailable".

import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { writeFile, readFile, FsError } from "@/lib/filesystem/service";
import { normalizeLogicalPath } from "@/lib/filesystem/paths";
import { safeFilename } from "@/lib/security/upload-safety";
import { sniffCadFormat, parseMeshStats, type MeshStats } from "./geometry";
import { computeModelDiff } from "./diff";
import {
  CadError,
  SHARE_LINK_TOKEN_PREFIX,
  generateShareToken,
  shareLinkExpiry,
  previewAvailableForFormat,
  validateModelInput,
  validateProjectInput,
  validateShareLinkInput,
  validateVersionInput,
  type CadFormat,
  type ModelInput,
  type ProjectInput,
  type ShareLinkInput,
  type VersionGeometrySnapshot,
  type VersionInput,
} from "./types";

const CAD_MIME: Record<CadFormat, string> = {
  stl: "model/stl",
  obj: "model/obj",
  step: "application/step",
};

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

interface VersionPlan {
  format: CadFormat;
  stats: MeshStats | null;
  checksum: string;
}

/** Pure pre-flight: sniff + stats + checksum. Throws BEFORE any row exists. */
function planVersion(input: VersionInput): VersionPlan {
  const sniff = sniffCadFormat(input.fileBytes, input.fileName);
  if (!sniff.format) {
    throw new CadError(
      "INVALID_FORMAT",
      `Could not recognize "${input.fileName}" as STL, OBJ, or STEP.`,
    );
  }
  return {
    format: sniff.format,
    stats: parseMeshStats(input.fileBytes, sniff.format),
    checksum: sha256Hex(input.fileBytes),
  };
}

/**
 * Write the bytes through the filesystem pipeline. Mesh formats bypass the
 * generic MIME allow-list (an 80-byte STL header has no magic bytes);
 * planVersion's byte-level signature check is the validation gate instead.
 * Quota + 25 MB cap still apply.
 */
async function writeVersionFile(
  workspaceId: string,
  actor: string,
  logicalPath: string,
  input: VersionInput,
  plan: VersionPlan,
) {
  const pathCheck = normalizeLogicalPath(logicalPath);
  if (!pathCheck.ok) {
    throw new CadError("INVALID_PATH", `Bad storage path: ${logicalPath}.`);
  }
  return writeFile({
    workspaceId,
    kind: pathCheck.kind,
    logicalPath,
    bytes: input.fileBytes,
    mimeType: CAD_MIME[plan.format],
    createdBy: actor,
    skipSafety: true,
  });
}

function snapshotOf(v: {
  id: string;
  versionNumber: number;
  triangleCount: number | null;
  bboxMin: unknown;
  bboxMax: unknown;
  volumeEstimate: number | null;
}): VersionGeometrySnapshot {
  return {
    versionId: v.id,
    versionNumber: v.versionNumber,
    triangleCount: v.triangleCount,
    bboxMin: (v.bboxMin as [number, number, number] | null) ?? null,
    bboxMax: (v.bboxMax as [number, number, number] | null) ?? null,
    volumeEstimate: v.volumeEstimate,
  };
}

export class PrismaCadStore {
  constructor(private prisma: PrismaClient) {}

  // ---------- Projects ----------

  async createProject(workspaceId: string, actor: string, input: ProjectInput) {
    validateProjectInput(input);
    return this.prisma.cadProject.create({
      data: {
        workspaceId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        createdBy: actor,
      },
    });
  }

  async listProjects(workspaceId: string) {
    return this.prisma.cadProject.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { models: true } } },
    });
  }

  private async requireProject(workspaceId: string, projectId: string) {
    const project = await this.prisma.cadProject.findFirst({
      where: { id: projectId, workspaceId },
    });
    if (!project) throw new CadError("PROJECT_NOT_FOUND", "CAD project not found.");
    return project;
  }

  async getProject(workspaceId: string, projectId: string) {
    return this.requireProject(workspaceId, projectId);
  }

  async updateProject(workspaceId: string, projectId: string, input: ProjectInput) {
    validateProjectInput(input);
    await this.requireProject(workspaceId, projectId);
    return this.prisma.cadProject.update({
      where: { id: projectId },
      data: { name: input.name.trim(), description: input.description?.trim() || null },
    });
  }

  async deleteProject(workspaceId: string, projectId: string) {
    await this.requireProject(workspaceId, projectId);
    await this.prisma.cadProject.delete({ where: { id: projectId } });
  }

  // ---------- Models ----------

  private async requireModel(workspaceId: string, modelId: string) {
    const model = await this.prisma.cadModel.findFirst({
      where: { id: modelId, workspaceId },
    });
    if (!model) throw new CadError("MODEL_NOT_FOUND", "CAD model not found.");
    return model;
  }

  async listModels(workspaceId: string, projectId: string) {
    await this.requireProject(workspaceId, projectId);
    return this.prisma.cadModel.findMany({
      where: { workspaceId, projectId },
      orderBy: { updatedAt: "desc" },
      include: {
        currentVersion: true,
        _count: { select: { versions: true, shareLinks: true } },
      },
    });
  }

  async getModelDetail(workspaceId: string, modelId: string) {
    const model = await this.requireModel(workspaceId, modelId);
    const [versions, diffs, shareLinks] = await Promise.all([
      this.prisma.cadModelVersion.findMany({
        where: { modelId, workspaceId },
        orderBy: { versionNumber: "desc" },
      }),
      this.prisma.cadModelDiff.findMany({
        where: { modelId, workspaceId },
        orderBy: { computedAt: "desc" },
      }),
      this.prisma.cadShareLink.findMany({
        where: { modelId, workspaceId },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    return { model, versions, diffs, shareLinks };
  }

  /**
   * Create a model AND its version 1 in one call (the upload form's path).
   * The model name comes from the tenant; the format comes from the BYTES.
   * Atomic: the byte sniff runs BEFORE any row is written, and the model +
   * version rows commit in one transaction — a failed version leaves no
   * orphaned model row behind.
   */
  async createModelWithVersion(
    workspaceId: string,
    actor: string,
    projectId: string,
    input: ModelInput,
    version: VersionInput,
  ) {
    validateModelInput(input);
    validateVersionInput(version);
    await this.requireProject(workspaceId, projectId);
    const plan = planVersion(version);
    const versionNumber = 1;
    const logicalPath = `/files/cad/${projectId}/PENDING/v${versionNumber}-${safeFilename(version.fileName)}`;
    // Sniff failures throw here — before anything is stored.
    const stored = await writeVersionFile(
      workspaceId,
      actor,
      logicalPath,
      version,
      plan,
    );
    const { model, versionRow } = await this.prisma.$transaction(async (tx) => {
      const model = await tx.cadModel.create({
        data: {
          workspaceId,
          projectId,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          createdBy: actor,
        },
      });
      // The logical path embeds the model id — rename is not needed because
      // the file row is keyed by storageKey; the logical path is rewritten
      // here to the final model-scoped location for a clean file tree.
      const finalPath = `/files/cad/${projectId}/${model.id}/v${versionNumber}-${safeFilename(version.fileName)}`;
      await tx.workspaceFile.update({
        where: { id: stored.id },
        data: { logicalPath: finalPath, filename: `v${versionNumber}-${safeFilename(version.fileName)}`.slice(0, 255) },
      });
      const versionRow = await tx.cadModelVersion.create({
        data: {
          workspaceId,
          modelId: model.id,
          versionNumber,
          workspaceFileId: stored.id,
          fileName: version.fileName,
          mimeType: CAD_MIME[plan.format],
          sizeBytes: version.fileBytes.length,
          checksum: plan.checksum,
          format: plan.format,
          triangleCount: plan.stats?.triangleCount ?? null,
          bboxMin: plan.stats ? (plan.stats.bboxMin as unknown as Prisma.InputJsonValue) : undefined,
          bboxMax: plan.stats ? (plan.stats.bboxMax as unknown as Prisma.InputJsonValue) : undefined,
          volumeEstimate: plan.stats?.volumeEstimate ?? null,
          // THE STEP RULE: no loader exists, so no preview is ever claimed.
          previewAvailable: previewAvailableForFormat(plan.format),
          notes: version.notes?.trim() || null,
          uploadedBy: actor,
          supersedesVersionId: null,
        },
      });
      const updated = await tx.cadModel.update({
        where: { id: model.id },
        data: { currentVersionId: versionRow.id },
        include: { currentVersion: true },
      });
      return { model: updated, versionRow };
    });
    return { model, version: versionRow };
  }

  /**
   * Publish a NEW version of an existing model. History is never rewritten:
   * the new row supersedes the previous one and the currentVersion pointer
   * moves forward in the same transaction. A diff vs the previous version is
   * recorded when both sides have real geometry stats.
   */
  async addModelVersion(
    workspaceId: string,
    actor: string,
    modelId: string,
    input: VersionInput,
  ) {
    validateVersionInput(input);
    const model = await this.requireModel(workspaceId, modelId);
    const latest = await this.prisma.cadModelVersion.findFirst({
      where: { modelId, workspaceId },
      orderBy: { versionNumber: "desc" },
    });
    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    // Sniff failures throw here — before anything is stored.
    const plan = planVersion(input);
    const stored = await writeVersionFile(
      workspaceId,
      actor,
      `/files/cad/${model.projectId}/${model.id}/v${versionNumber}-${safeFilename(input.fileName)}`,
      input,
      plan,
    );
    const versionRow = await this.prisma.$transaction(async (tx) => {
      const row = await tx.cadModelVersion.create({
        data: {
          workspaceId,
          modelId: model.id,
          versionNumber,
          workspaceFileId: stored.id,
          fileName: input.fileName,
          mimeType: CAD_MIME[plan.format],
          sizeBytes: input.fileBytes.length,
          checksum: plan.checksum,
          format: plan.format,
          triangleCount: plan.stats?.triangleCount ?? null,
          bboxMin: plan.stats ? (plan.stats.bboxMin as unknown as Prisma.InputJsonValue) : undefined,
          bboxMax: plan.stats ? (plan.stats.bboxMax as unknown as Prisma.InputJsonValue) : undefined,
          volumeEstimate: plan.stats?.volumeEstimate ?? null,
          // THE STEP RULE: no loader exists, so no preview is ever claimed.
          previewAvailable: previewAvailableForFormat(plan.format),
          notes: input.notes?.trim() || null,
          uploadedBy: actor,
          supersedesVersionId: latest?.id ?? null,
        },
      });
      await tx.cadModel.update({
        where: { id: modelId },
        data: { currentVersionId: row.id },
      });
      return row;
    });
    // Auto-diff vs the previous version (best-effort metadata; the UI can
    // request any pair explicitly). A failed diff never fails the publish.
    if (latest) {
      await this.recordDiff(workspaceId, modelId, latest.id, versionRow.id).catch(
        () => {},
      );
    }
    return versionRow;
  }

  /**
   * Compute + persist the diff between two versions of one model. Idempotent:
   * the same pair overwrites its row with an identical record. Auto-called
   * at publish time (vs the previous version) inside publishVersion below —
   * exposed publicly so the UI can request any pair.
   */
  async recordDiff(
    workspaceId: string,
    modelId: string,
    fromVersionId: string,
    toVersionId: string,
  ) {
    await this.requireModel(workspaceId, modelId);
    if (fromVersionId === toVersionId) {
      throw new CadError("INVALID_DIFF", "Pick two different versions to compare.");
    }
    const [from, to] = await Promise.all([
      this.prisma.cadModelVersion.findFirst({
        where: { id: fromVersionId, modelId, workspaceId },
      }),
      this.prisma.cadModelVersion.findFirst({
        where: { id: toVersionId, modelId, workspaceId },
      }),
    ]);
    if (!from || !to)
      throw new CadError("VERSION_NOT_FOUND", "One of the versions was not found.");
    const result = computeModelDiff(snapshotOf(from), snapshotOf(to));
    return this.prisma.cadModelDiff.upsert({
      where: {
        modelId_fromVersionId_toVersionId: {
          modelId,
          fromVersionId,
          toVersionId,
        },
      },
      create: {
        workspaceId,
        modelId,
        fromVersionId,
        toVersionId,
        availability: result.availability,
        triangleDelta: result.triangleDelta,
        sizeDelta: (result.sizeDelta ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
        centerDelta: result.centerDelta,
        volumeFrom: result.volumeFrom,
        volumeTo: result.volumeTo,
        volumeDelta: result.volumeDelta,
      },
      update: {
        availability: result.availability,
        triangleDelta: result.triangleDelta,
        sizeDelta: (result.sizeDelta ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
        centerDelta: result.centerDelta,
        volumeFrom: result.volumeFrom,
        volumeTo: result.volumeTo,
        volumeDelta: result.volumeDelta,
      },
    });
  }

  /** Version file bytes for the in-browser viewer (tenant-scoped). */
  async getVersionFile(workspaceId: string, modelId: string, versionId: string) {
    const version = await this.prisma.cadModelVersion.findFirst({
      where: { id: versionId, modelId, workspaceId },
    });
    if (!version) throw new CadError("VERSION_NOT_FOUND", "Version not found.");
    const file = await readFile({
      workspaceId,
      fileId: version.workspaceFileId,
    });
    if (!file) throw new CadError("FILE_MISSING", "The stored file is gone.");
    return { version, bytes: file.bytes };
  }

  async deleteModel(workspaceId: string, modelId: string) {
    await this.requireModel(workspaceId, modelId);
    await this.prisma.cadModel.delete({ where: { id: modelId } });
  }

  // ---------- Share links (fail-closed) ----------

  async createShareLink(
    workspaceId: string,
    actor: string,
    modelId: string,
    input: ShareLinkInput,
  ) {
    validateShareLinkInput(input);
    const model = await this.requireModel(workspaceId, modelId);
    if (input.pinnedVersionId) {
      const pinned = await this.prisma.cadModelVersion.findFirst({
        where: { id: input.pinnedVersionId, modelId, workspaceId },
      });
      if (!pinned)
        throw new CadError("VERSION_NOT_FOUND", "Pinned version not found.");
    }
    // Token-collision retry (128-bit tokens; the loop is belt-and-braces).
    for (let attempt = 0; attempt < 5; attempt++) {
      const token = generateShareToken();
      try {
        return await this.prisma.cadShareLink.create({
          data: {
            workspaceId,
            modelId: model.id,
            pinnedVersionId: input.pinnedVersionId ?? null,
            token,
            label: input.label?.trim() || null,
            expiresAt: shareLinkExpiry(input.expiresInDays),
            createdBy: actor,
          },
        });
      } catch (e) {
        if (
          e instanceof Error &&
          "code" in e &&
          (e as { code: string }).code === "P2002"
        ) {
          continue;
        }
        throw e;
      }
    }
    throw new CadError("TOKEN_COLLISION", "Could not mint a unique link token.");
  }

  async listShareLinks(workspaceId: string, modelId: string) {
    await this.requireModel(workspaceId, modelId);
    return this.prisma.cadShareLink.findMany({
      where: { workspaceId, modelId },
      orderBy: { createdAt: "desc" },
    });
  }

  async revokeShareLink(workspaceId: string, linkId: string) {
    const link = await this.prisma.cadShareLink.findFirst({
      where: { id: linkId, workspaceId },
    });
    if (!link) throw new CadError("LINK_NOT_FOUND", "Share link not found.");
    if (link.revoked) return link; // idempotent
    return this.prisma.cadShareLink.update({
      where: { id: linkId },
      data: { revoked: true, revokedAt: new Date() },
    });
  }

  async deleteShareLink(workspaceId: string, linkId: string) {
    const link = await this.prisma.cadShareLink.findFirst({
      where: { id: linkId, workspaceId },
    });
    if (!link) throw new CadError("LINK_NOT_FOUND", "Share link not found.");
    await this.prisma.cadShareLink.delete({ where: { id: linkId } });
  }

  /**
   * Resolve a public token — the ONLY read path the public viewer uses.
   * Fail-closed: unknown → LINK_NOT_FOUND, revoked → LINK_REVOKED,
   * expired → LINK_EXPIRED. Resolves pinned version, else the model's
   * current version at access time.
   */
  async resolveShareToken(token: string) {
    if (!token.startsWith(SHARE_LINK_TOKEN_PREFIX)) {
      throw new CadError("LINK_NOT_FOUND", "Share link not found.");
    }
    const link = await this.prisma.cadShareLink.findUnique({
      where: { token },
      include: {
        model: { include: { project: true, currentVersion: true } },
        pinnedVersion: true,
      },
    });
    if (!link) throw new CadError("LINK_NOT_FOUND", "Share link not found.");
    if (link.revoked) throw new CadError("LINK_REVOKED", "This link was revoked.");
    if (link.expiresAt.getTime() <= Date.now())
      throw new CadError("LINK_EXPIRED", "This link has expired.");
    const version =
      link.pinnedVersion ??
      link.model.currentVersion ??
      null;
    if (!version)
      throw new CadError("VERSION_NOT_FOUND", "No version available for this link.");
    return { link, model: link.model, version };
  }

  /** Public file bytes behind a valid token (still goes through the guard). */
  async getShareTokenFile(token: string) {
    const { link, version } = await this.resolveShareToken(token);
    const file = await readFile({
      workspaceId: link.workspaceId,
      fileId: version.workspaceFileId,
    });
    if (!file) throw new CadError("FILE_MISSING", "The stored file is gone.");
    return { version, bytes: file.bytes };
  }

  /** Test helper: random token with the right prefix (never used alone). */
  static testToken(): string {
    return SHARE_LINK_TOKEN_PREFIX + randomBytes(16).toString("hex");
  }
}
