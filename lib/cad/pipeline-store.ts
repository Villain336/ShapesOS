// Marketr — CAD + Hardware slice 3: prototype pipeline store.
// Extends the slice-1 PrismaCadStore (projects → models → immutable
// versions) with rate cards, BOMs pinned to model versions, cost estimates,
// and vendor export / quote requests.
//
// THE NO-LIVE-VENDOR BOUNDARY (v1): nothing in this file places an order or
// calls a vendor API. The quote-request lifecycle is:
//   draft → (human confirms) → confirmed: export package (model file +
//     manifest with checksum + process parameters + contact/shipping) written
//     to the workspace file store.
//   confirmed → (human records send) → sent: the tenant's OWN transmission
//     recorded as an auditable event (who sent, when, to whom, via which
//     connected account). sendExportRequest performs ZERO network I/O — the
//     tenant submits the package to their vendor through their own account;
//     the OS only records it. "v1 does not place orders."
//
// Tenant-scoping: every read filters on workspaceId, like the parent store.

import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { PrismaCadStore } from "./prisma-store";
import {
  deriveBomFromBytes,
  stepDeriveUnavailable,
  validateDeriveOptions,
  type DeriveOptionsInput,
} from "./bom-derive";
import { csvRow } from "@/lib/csv";
import { requireCadHuman, type CadActor } from "./ai-store";
import { writeFile } from "@/lib/filesystem/service";
import { normalizeLogicalPath } from "@/lib/filesystem/paths";
import { CadError } from "./types";
import {
  bomCsvRows,
  buildExportManifest,
  compareBomRollups,
  compareCostEstimates,
  computeBomRollup,
  computeCostEstimate,
  isExportProcess,
  validateBomLineInput,
  validateExportRequestInput,
  validateRateCardInput,
  validateRateCardRates,
  type BomLineInput,
  type BomRollup,
  type CostBreakdown,
  type ExportManifest,
  type ExportProcess,
  type RateCardInput,
  type RateCardRates,
} from "./prototype";

type BomLineRow = {
  id: string;
  partName: string;
  qty: number;
  unitName: string;
  materialSpec: string | null;
  supplier: string | null;
  unitCostUsd: number | null;
  source: string;
  volumeMm3: number | null;
  massG: number | null;
};

/** Stored BOM lines → rollup (cost + mass totals, unknowns flagged). */
export function rollupOf(lines: BomLineRow[]): BomRollup {
  return computeBomRollup(
    lines.map((l) => ({
      id: l.id,
      partName: l.partName,
      qty: l.qty,
      unitName: l.unitName,
      materialSpec: l.materialSpec,
      supplier: l.supplier,
      unitCostUsd: l.unitCostUsd,
      source: l.source,
      volumeMm3: l.volumeMm3,
      massG: l.massG,
    })),
  );
}

export class PrismaCadPipelineStore extends PrismaCadStore {
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

  private async requireRateCard(workspaceId: string, id: string) {
    const card = await this.prisma.cadRateCard.findFirst({ where: { id, workspaceId } });
    if (!card) throw new CadError("RATE_CARD_NOT_FOUND", "Rate card not found.");
    return card;
  }

  private async requireBomVersion(workspaceId: string, id: string) {
    const bom = await this.prisma.cadBomVersion.findFirst({
      where: { id, workspaceId },
      include: { lines: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
    });
    if (!bom) throw new CadError("BOM_NOT_FOUND", "BOM version not found.");
    return bom;
  }

  // ---------- Rate cards ----------

  async createRateCard(workspaceId: string, actor: string, input: RateCardInput) {
    const v = validateRateCardInput(input);
    const card = await this.prisma.$transaction(async (tx) => {
      if (v.isDefault) {
        await tx.cadRateCard.updateMany({
          where: { workspaceId, process: v.process, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.cadRateCard.create({
        data: {
          workspaceId,
          name: v.name,
          process: v.process,
          currency: v.currency,
          rates: v.rates as unknown as Prisma.InputJsonValue,
          isDefault: v.isDefault,
          source: v.source ?? null,
          createdBy: actor,
        },
      });
    });
    return card;
  }

  async listRateCards(workspaceId: string, process?: string) {
    const where: { workspaceId: string; process?: string } = { workspaceId };
    if (process != null) {
      if (!isExportProcess(process)) throw new CadError("INVALID_PROCESS", "Unknown process.");
      where.process = process;
    }
    return this.prisma.cadRateCard.findMany({
      where,
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });
  }

  async updateRateCard(workspaceId: string, id: string, patch: Partial<RateCardInput>) {
    const existing = await this.requireRateCard(workspaceId, id);
    const data: {
      name?: string;
      process?: ExportProcess;
      currency?: string;
      rates?: Prisma.InputJsonValue;
      isDefault?: boolean;
      source?: string | null;
    } = {};
    if (patch.name != null) {
      const name = String(patch.name).trim();
      if (!name) throw new CadError("INVALID_RATE_CARD", "A rate card name is required.");
      data.name = name;
    }
    if (patch.process != null) {
      if (!isExportProcess(String(patch.process))) throw new CadError("INVALID_RATE_CARD", "Unknown process.");
      data.process = patch.process as ExportProcess;
    }
    if (patch.currency != null) {
      const currency = String(patch.currency).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new CadError("INVALID_RATE_CARD", "Currency must be a 3-letter ISO code.");
      data.currency = currency;
    }
    if (patch.rates !== undefined) {
      data.rates = validateRateCardRates(patch.rates) as unknown as Prisma.InputJsonValue;
    }
    if (patch.isDefault !== undefined) data.isDefault = Boolean(patch.isDefault);
    if (patch.source !== undefined) data.source = patch.source?.trim() || null;
    return this.prisma.$transaction(async (tx) => {
      const process = data.process ?? (existing.process as ExportProcess);
      if (data.isDefault) {
        await tx.cadRateCard.updateMany({
          where: { workspaceId, process, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return tx.cadRateCard.update({ where: { id }, data });
    });
  }

  async deleteRateCard(workspaceId: string, id: string) {
    await this.requireRateCard(workspaceId, id);
    const inUse = await this.prisma.cadCostEstimate.count({ where: { rateCardId: id, workspaceId } });
    if (inUse > 0) {
      throw new CadError(
        "RATE_CARD_IN_USE",
        `This rate card is cited by ${inUse} cost estimate(s) and cannot be deleted — estimates keep their rate-card lineage.`,
      );
    }
    await this.prisma.cadRateCard.delete({ where: { id } });
  }

  // ---------- BOM ----------

  async createBomVersion(
    workspaceId: string,
    actor: string,
    modelId: string,
    modelVersionId: string,
    notes?: string,
  ) {
    const model = await this.requireModelRow(workspaceId, modelId);
    const version = await this.requireVersionRow(workspaceId, modelId, modelVersionId);
    const max = await this.prisma.cadBomVersion.aggregate({
      where: { modelId: model.id, workspaceId },
      _max: { bomNumber: true },
    });
    const bomNumber = (max._max.bomNumber ?? 0) + 1;
    return this.prisma.cadBomVersion.create({
      data: {
        workspaceId,
        modelId: model.id,
        modelVersionId: version.id,
        bomNumber,
        notes: notes?.trim() || null,
        createdBy: actor,
      },
    });
  }

  async listBomVersions(workspaceId: string, modelId: string) {
    await this.requireModelRow(workspaceId, modelId);
    return this.prisma.cadBomVersion.findMany({
      where: { workspaceId, modelId },
      orderBy: { bomNumber: "desc" },
      include: {
        modelVersion: { select: { id: true, versionNumber: true, format: true } },
        _count: { select: { lines: true } },
      },
    });
  }

  async getBomVersion(workspaceId: string, id: string) {
    const bom = await this.requireBomVersion(workspaceId, id);
    return { bom, rollup: rollupOf(bom.lines) };
  }

  // ---------- Derived BOM (Phase 4b) ----------

  /**
   * Derive a new BOM version from a model version's real mesh geometry
   * (lib/cad/bom-derive.ts) and pin it to that version. The stored bytes are
   * re-hashed against the version's checksum first, so the derivation always
   * cites the exact file it measured. STEP / unreadable files throw
   * DERIVE_UNAVAILABLE and nothing is written.
   */
  async deriveBomFromGeometry(
    workspaceId: string,
    actor: string,
    modelId: string,
    modelVersionId: string,
    optionsInput: DeriveOptionsInput,
  ) {
    const options = validateDeriveOptions(optionsInput);
    const model = await this.requireModelRow(workspaceId, modelId);
    const version = await this.requireVersionRow(workspaceId, modelId, modelVersionId);
    if (version.format === "step") throw stepDeriveUnavailable();
    const { bytes } = await this.getVersionFile(workspaceId, modelId, modelVersionId);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    if (checksum !== version.checksum) {
      throw new CadError(
        "FILE_INTEGRITY",
        "The stored file no longer matches this version's checksum — refusing to derive a BOM from it.",
      );
    }
    const derived = deriveBomFromBytes(bytes, version.format as "stl" | "obj", model.name, options);
    const derivation = {
      ...derived.derivation,
      sourceVersionId: version.id,
      sourceVersionNumber: version.versionNumber,
      sourceFileName: version.fileName,
      sourceChecksum: version.checksum,
      format: version.format,
      derivedAt: new Date().toISOString(),
    };

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const max = await tx.cadBomVersion.aggregate({
            where: { modelId: model.id, workspaceId },
            _max: { bomNumber: true },
          });
          const bom = await tx.cadBomVersion.create({
            data: {
              workspaceId,
              modelId: model.id,
              modelVersionId: version.id,
              bomNumber: (max._max.bomNumber ?? 0) + 1,
              notes: options.notes,
              origin: "derived",
              derivation: derivation as unknown as Prisma.InputJsonValue,
              createdBy: actor,
            },
          });
          await tx.cadBomLine.createMany({
            data: derived.lines.map((l, i) => ({
              workspaceId,
              bomVersionId: bom.id,
              partName: l.partName,
              qty: l.qty,
              unitName: l.unitName,
              materialSpec: l.materialSpec,
              unitCostUsd: l.unitCostUsd,
              source: l.source,
              sortOrder: i,
              volumeMm3: l.volumeMm3,
              massG: l.massG,
              measurement: l.measurement as unknown as Prisma.InputJsonValue,
            })),
          });
          const full = await tx.cadBomVersion.findUniqueOrThrow({
            where: { id: bom.id },
            include: { lines: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
          });
          return { bom: full, rollup: rollupOf(full.lines), derivation };
        });
      } catch (e) {
        // Two derivations racing for the same bomNumber: retry once.
        if (attempt === 0 && (e as { code?: string })?.code === "P2002") continue;
        throw e;
      }
    }
  }

  /**
   * Rollups across revisions: every BOM of a model with its totals, oldest
   * model version first, each carrying the change vs the previous BOM.
   */
  async getBomHistory(workspaceId: string, modelId: string) {
    await this.requireModelRow(workspaceId, modelId);
    const boms = await this.prisma.cadBomVersion.findMany({
      where: { workspaceId, modelId },
      include: {
        modelVersion: { select: { id: true, versionNumber: true } },
        lines: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      },
    });
    boms.sort(
      (a, b) => a.modelVersion.versionNumber - b.modelVersion.versionNumber || a.bomNumber - b.bomNumber,
    );
    let prev: BomRollup | null = null;
    return boms.map((b) => {
      const rollup = rollupOf(b.lines);
      const entry = {
        bomId: b.id,
        bomNumber: b.bomNumber,
        origin: b.origin,
        modelVersionId: b.modelVersion.id,
        versionNumber: b.modelVersion.versionNumber,
        createdAt: b.createdAt,
        lineCount: rollup.lineCount,
        totalUsd: rollup.totalUsd,
        linesMissingCost: rollup.linesMissingCost,
        totalMassG: rollup.totalMassG,
        linesMissingMass: rollup.linesMissingMass,
        vsPrevious: prev ? compareBomRollups(prev, rollup).totals : null,
      };
      prev = rollup;
      return entry;
    });
  }

  /** Part-level diff between two BOMs of this workspace. */
  async compareBomVersions(workspaceId: string, fromId: string, toId: string) {
    const [from, to] = await Promise.all([
      this.requireBomVersion(workspaceId, fromId),
      this.requireBomVersion(workspaceId, toId),
    ]);
    return {
      from: { id: from.id, bomNumber: from.bomNumber, modelId: from.modelId, modelVersionId: from.modelVersionId },
      to: { id: to.id, bomNumber: to.bomNumber, modelId: to.modelId, modelVersionId: to.modelVersionId },
      comparison: compareBomRollups(rollupOf(from.lines), rollupOf(to.lines)),
    };
  }

  /** CSV export of one BOM (formula-injection-safe via lib/csv.ts). */
  async exportBomCsv(workspaceId: string, id: string) {
    const bom = await this.requireBomVersion(workspaceId, id);
    const [model, version] = await Promise.all([
      this.prisma.cadModel.findFirst({ where: { id: bom.modelId, workspaceId }, select: { name: true } }),
      this.prisma.cadModelVersion.findFirst({
        where: { id: bom.modelVersionId, workspaceId },
        select: { versionNumber: true },
      }),
    ]);
    const rows = bomCsvRows(rollupOf(bom.lines));
    const csv = rows.map((r) => csvRow(r)).join("\r\n") + "\r\n";
    const slug =
      (model?.name ?? "model")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "model";
    return { filename: `bom-${slug}-v${version?.versionNumber ?? 0}-${bom.bomNumber}.csv`, csv, bom };
  }

  async addBomLine(workspaceId: string, actor: string, bomVersionId: string, input: BomLineInput) {
    const bom = await this.requireBomVersion(workspaceId, bomVersionId);
    const v = validateBomLineInput(input);
    const max = await this.prisma.cadBomLine.aggregate({
      where: { bomVersionId: bom.id },
      _max: { sortOrder: true },
    });
    return this.prisma.cadBomLine.create({
      data: {
        workspaceId,
        bomVersionId: bom.id,
        partName: v.partName,
        qty: v.qty,
        unitName: v.unitName,
        materialSpec: v.materialSpec ?? null,
        supplier: v.supplier ?? null,
        unitCostUsd: v.unitCostUsd,
        source: v.source,
        sortOrder: (max._max.sortOrder ?? -1) + 1,
      },
    });
  }

  private async requireBomLine(workspaceId: string, lineId: string) {
    const line = await this.prisma.cadBomLine.findFirst({ where: { id: lineId, workspaceId } });
    if (!line) throw new CadError("BOM_LINE_NOT_FOUND", "BOM line not found.");
    return line;
  }

  async updateBomLine(workspaceId: string, lineId: string, patch: Partial<BomLineInput>) {
    const existing = await this.requireBomLine(workspaceId, lineId);
    // source is immutable: a line's provenance never changes after creation.
    if (patch.source !== undefined) {
      throw new CadError("BOM_SOURCE_IMMUTABLE", "A BOM line's source cannot be changed after creation.");
    }
    // A derived line's quantity is the body count measured in the mesh;
    // editing it would make the line claim a measurement it no longer has.
    if (
      existing.source.startsWith("derived:") &&
      patch.qty != null &&
      Number(patch.qty) !== existing.qty
    ) {
      throw new CadError(
        "DERIVED_QTY_IMMUTABLE",
        "This quantity was counted from the model's geometry. Add a manual line for extra units instead.",
      );
    }
    const data: {
      partName?: string;
      qty?: number;
      unitName?: string;
      materialSpec?: string | null;
      supplier?: string | null;
      unitCostUsd?: number | null;
    } = {};
    if (patch.partName != null) {
      const partName = String(patch.partName).trim();
      if (!partName) throw new CadError("INVALID_BOM_LINE", "A part name is required.");
      data.partName = partName;
    }
    if (patch.qty != null) {
      const qty = Number(patch.qty);
      if (!Number.isFinite(qty) || qty <= 0) throw new CadError("INVALID_BOM_LINE", "Quantity must be positive.");
      data.qty = qty;
    }
    if (patch.unitName != null) data.unitName = String(patch.unitName).trim() || "pcs";
    if (patch.materialSpec !== undefined) data.materialSpec = patch.materialSpec?.trim() || null;
    if (patch.supplier !== undefined) data.supplier = patch.supplier?.trim() || null;
    if (patch.unitCostUsd !== undefined) {
      if (patch.unitCostUsd == null) {
        data.unitCostUsd = null;
      } else {
        const c = Number(patch.unitCostUsd);
        if (!Number.isFinite(c) || c < 0) throw new CadError("INVALID_BOM_LINE", "Unit cost must be non-negative or null.");
        data.unitCostUsd = c;
      }
    }
    return this.prisma.cadBomLine.update({ where: { id: lineId }, data });
  }

  async deleteBomLine(workspaceId: string, lineId: string) {
    await this.requireBomLine(workspaceId, lineId);
    await this.prisma.cadBomLine.delete({ where: { id: lineId } });
  }

  // ---------- Cost estimates ----------

  async createCostEstimate(
    workspaceId: string,
    actor: string,
    modelVersionId: string,
    args: { bomVersionId: string; rateCardId: string; quantity: number },
  ) {
    const version = await this.prisma.cadModelVersion.findFirst({
      where: { id: modelVersionId, workspaceId },
    });
    if (!version) throw new CadError("VERSION_NOT_FOUND", "CAD model version not found.");
    const { bom, rollup } = await this.getBomVersion(workspaceId, args.bomVersionId);
    if (bom.modelVersionId !== version.id) {
      throw new CadError(
        "BOM_VERSION_MISMATCH",
        `BOM #${bom.bomNumber} is pinned to model version ${bom.modelVersionId}, not this version. Estimates bind a BOM to the version it describes.`,
      );
    }
    const card = await this.requireRateCard(workspaceId, args.rateCardId);
    const quantity = Number(args.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
      throw new CadError("INVALID_QUANTITY", "Quantity must be a positive integer.");
    }
    const basis = computeCostEstimate({
      bomRollup: rollup,
      rates: (card.rates ?? {}) as RateCardRates,
      rateCardId: card.id,
      rateCardName: card.name,
      process: card.process as ExportProcess,
      quantity,
      currency: card.currency,
      geometry: { volumeEstimateMm3: version.volumeEstimate },
    });
    return this.prisma.cadCostEstimate.create({
      data: {
        workspaceId,
        modelVersionId: version.id,
        bomVersionId: bom.id,
        rateCardId: card.id,
        quantity,
        currency: card.currency,
        bomTotalUsd: basis.bomTotalUsd,
        processCostUsd: basis.process.totalUsd,
        grandTotalUsd: basis.grandTotalUsd,
        perUnitUsd: basis.perUnitUsd,
        basis: basis as unknown as Prisma.InputJsonValue,
        createdBy: actor,
      },
    });
  }

  async listCostEstimates(workspaceId: string, modelVersionId: string) {
    return this.prisma.cadCostEstimate.findMany({
      where: { workspaceId, modelVersionId },
      orderBy: { createdAt: "desc" },
      include: {
        rateCard: { select: { id: true, name: true, process: true } },
        bomVersion: { select: { id: true, bomNumber: true } },
      },
    });
  }

  private async requireCostEstimate(workspaceId: string, id: string) {
    const est = await this.prisma.cadCostEstimate.findFirst({ where: { id, workspaceId } });
    if (!est) throw new CadError("ESTIMATE_NOT_FOUND", "Cost estimate not found.");
    return est;
  }

  async getCostEstimate(workspaceId: string, id: string) {
    return this.requireCostEstimate(workspaceId, id);
  }

  async compareEstimates(workspaceId: string, idA: string, idB: string) {
    const a = await this.requireCostEstimate(workspaceId, idA);
    const b = await this.requireCostEstimate(workspaceId, idB);
    const delta = compareCostEstimates(
      { id: a.id, basis: a.basis as unknown as CostBreakdown },
      { id: b.id, basis: b.basis as unknown as CostBreakdown },
    );
    return { from: a, to: b, delta };
  }

  // ---------- Export / quote requests ----------

  async createExportRequest(
    workspaceId: string,
    actor: string,
    modelVersionId: string,
    input: { process: string; quantity: number; processOptions?: unknown; contact?: unknown },
  ) {
    const version = await this.prisma.cadModelVersion.findFirst({
      where: { id: modelVersionId, workspaceId },
      include: { model: { select: { id: true } } },
    });
    if (!version) throw new CadError("VERSION_NOT_FOUND", "CAD model version not found.");
    const v = validateExportRequestInput(input);
    return this.prisma.cadExportRequest.create({
      data: {
        workspaceId,
        modelId: version.modelId,
        modelVersionId: version.id,
        process: v.process,
        quantity: v.quantity,
        processOptions: v.processOptions as unknown as Prisma.InputJsonValue,
        contact: v.contact as unknown as Prisma.InputJsonValue,
        status: "draft",
        createdBy: actor,
      },
    });
  }

  async listExportRequests(workspaceId: string, modelId: string) {
    await this.requireModelRow(workspaceId, modelId);
    return this.prisma.cadExportRequest.findMany({
      where: { workspaceId, modelId },
      orderBy: { createdAt: "desc" },
      include: {
        modelVersion: { select: { id: true, versionNumber: true, format: true } },
      },
    });
  }

  private async requireExportRequest(workspaceId: string, id: string) {
    const req = await this.prisma.cadExportRequest.findFirst({ where: { id, workspaceId } });
    if (!req) throw new CadError("EXPORT_REQUEST_NOT_FOUND", "Export request not found.");
    return req;
  }

  async getExportRequest(workspaceId: string, id: string) {
    const req = await this.requireExportRequest(workspaceId, id);
    const model = await this.requireModelRow(workspaceId, req.modelId);
    const version = await this.requireVersionRow(workspaceId, req.modelId, req.modelVersionId);
    return { request: req, model, version };
  }

  /**
   * Human-only. draft → confirmed. Writes the vendor-ready export package
   * manifest to the workspace file store. No vendor API is called; no order
   * is placed.
   */
  async confirmExportRequest(workspaceId: string, actor: CadActor, id: string) {
    const by = requireCadHuman(actor, "Confirming a quote request");
    const req = await this.requireExportRequest(workspaceId, id);
    if (req.status !== "draft") {
      throw new CadError("QUOTE_NOT_DRAFT", `Only a draft can be confirmed (status is "${req.status}").`);
    }
    const manifest = await this.assembleManifest(workspaceId, id);
    const logicalPath = `/files/cad/${req.modelId}/${req.modelVersionId}/exports/${req.id}/manifest.json`;
    const pathCheck = normalizeLogicalPath(logicalPath);
    if (!pathCheck.ok) throw new CadError("INVALID_PATH", `Bad export path: ${logicalPath}.`);
    await writeFile({
      workspaceId,
      kind: pathCheck.kind,
      logicalPath,
      bytes: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
      mimeType: "application/json",
      createdBy: by,
      skipSafety: true, // server-generated JSON; no user-controlled bytes beyond validated fields
    });
    return this.prisma.cadExportRequest.update({
      where: { id },
      data: { status: "confirmed", manifestPath: logicalPath, confirmedBy: by, confirmedAt: new Date() },
    });
  }

  /**
   * Human-only. confirmed → sent. Records the tenant's OWN transmission as
   * an auditable event: who recorded it, when, the recipient, and which of
   * the tenant's connected accounts it went through.
   *
   * v1 does NOT place orders: this method performs ZERO network I/O and
   * calls no vendor API. The tenant submits the package to their chosen
   * vendor through their own account; the OS records the lineage.
   */
  async sendExportRequest(
    workspaceId: string,
    actor: CadActor,
    id: string,
    args: { recipient: string; sentViaAccount: string },
  ) {
    const by = requireCadHuman(actor, "Recording a quote-request send");
    const req = await this.requireExportRequest(workspaceId, id);
    if (req.status !== "confirmed") {
      throw new CadError(
        "QUOTE_NOT_CONFIRMED",
        `Only a confirmed quote request can be recorded as sent (status is "${req.status}"). Confirm it first — nothing is sent without explicit tenant confirmation.`,
      );
    }
    const recipient = String(args.recipient ?? "").trim();
    const sentViaAccount = String(args.sentViaAccount ?? "").trim();
    if (!recipient) throw new CadError("INVALID_RECIPIENT", "A recipient is required to record the send.");
    if (!sentViaAccount) {
      throw new CadError(
        "INVALID_ACCOUNT",
        "The connected account the tenant sent through is required — the send is recorded with the tenant's account named.",
      );
    }
    // No network call happens here. v1 does not place orders.
    return this.prisma.cadExportRequest.update({
      where: { id },
      data: {
        status: "sent",
        sentBy: by,
        sentAt: new Date(),
        recipient,
        sentViaAccount,
      },
    });
  }

  /**
   * Export package download surface. Drafts are refused (QUOTE_NOT_READY) —
   * nothing is downloadable before the tenant confirms.
   */
  async getPackageManifest(workspaceId: string, id: string): Promise<ExportManifest> {
    const req = await this.requireExportRequest(workspaceId, id);
    if (req.status !== "confirmed" && req.status !== "sent") {
      throw new CadError(
        "QUOTE_NOT_READY",
        `The export package is available once the request is confirmed (status is "${req.status}").`,
      );
    }
    return this.assembleManifest(workspaceId, id);
  }

  /**
   * Builds the export package manifest for a request. Pure assembly from
   * stored rows: model + version (checksum), process parameters, contact,
   * the latest BOM pinned to this version (if any), and the latest cost
   * estimate for this version (if any). No status gate here — the public
   * getPackageManifest applies the draft refusal; confirmExportRequest
   * assembles before flipping status.
   */
  private async assembleManifest(workspaceId: string, id: string): Promise<ExportManifest> {
    const { request: req, model, version } = await this.getExportRequest(workspaceId, id);
    const bomRow = await this.prisma.cadBomVersion.findFirst({
      where: { workspaceId, modelId: model.id, modelVersionId: version.id },
      orderBy: { bomNumber: "desc" },
      include: { lines: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
    });
    const estRow = await this.prisma.cadCostEstimate.findFirst({
      where: { workspaceId, modelVersionId: version.id },
      orderBy: { createdAt: "desc" },
      include: { rateCard: { select: { name: true } } },
    });
    const rollup = bomRow
      ? computeBomRollup(
          bomRow.lines.map((l) => ({
            id: l.id,
            partName: l.partName,
            qty: l.qty,
            unitName: l.unitName,
            materialSpec: l.materialSpec,
            supplier: l.supplier,
            unitCostUsd: l.unitCostUsd,
            source: l.source,
          })),
        )
      : null;
    return buildExportManifest({
      request: {
        id: req.id,
        process: req.process as ExportProcess,
        quantity: req.quantity,
        processOptions: (req.processOptions ?? {}) as Record<string, string>,
        contact: req.contact as unknown as { name: string; email: string; addressLines: string[] },
      },
      model: { id: model.id, name: model.name, projectId: model.projectId },
      version: {
        id: version.id,
        versionNumber: version.versionNumber,
        format: version.format,
        fileName: version.fileName,
        sizeBytes: version.sizeBytes,
        checksum: version.checksum,
        uploadedAt: version.uploadedAt,
      },
      bom: bomRow && rollup
        ? {
            id: bomRow.id,
            bomNumber: bomRow.bomNumber,
            lines: bomRow.lines.map((l) => ({
              partName: l.partName,
              qty: l.qty,
              unitName: l.unitName,
              materialSpec: l.materialSpec ?? undefined,
              supplier: l.supplier ?? undefined,
              unitCostUsd: l.unitCostUsd,
              source: l.source,
            })),
            rollup,
          }
        : null,
      estimate: estRow
        ? {
            id: estRow.id,
            grandTotalUsd: estRow.grandTotalUsd,
            perUnitUsd: estRow.perUnitUsd,
            currency: estRow.currency,
            rateCardName: estRow.rateCard.name,
          }
        : null,
    });
  }
}
