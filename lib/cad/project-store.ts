// Marketr — CAD + Hardware slice 4: hardware project management store.
// Extends the slice-3 PrismaCadPipelineStore (rate cards, BOMs, estimates)
// with the parts inventory, supplier tracking, and revision-linked tasks /
// issues.
//
// HARD RULES (v1):
// 1. Tenant-scoped: every read filters on workspaceId, like the parent stores.
// 2. Stock is event-sourced: onHandQty is only ever changed inside a
//    transaction that also writes a CadStockEvent row (who/when/delta/
//    reason). No silent overwrites.
// 3. Below-zero stock fails closed unless the caller passes an explicit
//    confirmBelowZero flag (NEGATIVE_STOCK_CONFIRMATION_REQUIRED).
// 4. Costs cite their quote. A supplier link carries a quoted cost only
//    with currency + quoted date + source citation. Non-USD quotes never
//    flow into BOM costs — no FX rate is invented.
// 5. Deleting a supplier with linked parts fails closed (SUPPLIER_HAS_PARTS):
//    unlink the parts first, explicitly.
// 6. The task↔version pin is a reference only. Closing/editing/deleting a
//    task never mutates a CadModelVersion row (immutable); deleting a model
//    sets the pin to null and the task survives as project-level work.

import type { Prisma, PrismaClient } from "@prisma/client";
import { PrismaCadPipelineStore } from "./pipeline-store";
import { CadError } from "./types";
import { computeBomRollup } from "./prototype";
import type { BomLineInput } from "./prototype";
import {
  computeStockAdjustment,
  isLowStock,
  isTaskOpen,
  preferredQuoteCostUsd,
  quoteCitation,
  validatePartInput,
  validatePartSupplierLinkInput,
  validateSupplierInput,
  validateTaskCommentBody,
  validateTaskInput,
  validateTaskPatch,
  type DashboardBomCost,
  type DashboardLatestVersion,
  type PartInput,
  type PartSupplierLinkInput,
  type SupplierInput,
  type TaskInput,
  type TaskStatus,
} from "./hardware";

interface QuoteRef {
  supplierName: string;
  costUsd: number;
  currency: string;
  quotedDate: Date | null;
  quoteSource: string | null;
  citation: string;
}

export class PrismaCadProjectStore extends PrismaCadPipelineStore {
  // ---------- shared requires ----------

  private async requireProjectRow(workspaceId: string, projectId: string) {
    const project = await this.prisma.cadProject.findFirst({
      where: { id: projectId, workspaceId },
    });
    if (!project) throw new CadError("PROJECT_NOT_FOUND", "CAD project not found.");
    return project;
  }

  private async requirePart(workspaceId: string, partId: string) {
    const part = await this.prisma.cadPart.findFirst({ where: { id: partId, workspaceId } });
    if (!part) throw new CadError("PART_NOT_FOUND", "Inventory part not found.");
    return part;
  }

  private async requireSupplier(workspaceId: string, supplierId: string) {
    const supplier = await this.prisma.cadSupplier.findFirst({
      where: { id: supplierId, workspaceId },
    });
    if (!supplier) throw new CadError("SUPPLIER_NOT_FOUND", "Supplier not found.");
    return supplier;
  }

  private async requireTask(workspaceId: string, taskId: string) {
    const task = await this.prisma.cadTask.findFirst({ where: { id: taskId, workspaceId } });
    if (!task) throw new CadError("TASK_NOT_FOUND", "Task not found.");
    return task;
  }

  private async requireLink(workspaceId: string, linkId: string) {
    const link = await this.prisma.cadPartSupplier.findFirst({
      where: { id: linkId, workspaceId },
      include: { supplier: { select: { name: true } } },
    });
    if (!link) throw new CadError("LINK_NOT_FOUND", "Part–supplier link not found.");
    return link;
  }

  // ---------- Parts inventory ----------

  async createPart(workspaceId: string, actor: string, input: PartInput) {
    const v = validatePartInput(input);
    // onHandQty is set directly only at creation — it is the auditable
    // opening balance. Every change afterwards goes through adjustStock.
    return this.prisma.$transaction(async (tx) => {
      const part = await tx.cadPart.create({
        data: {
          workspaceId,
          name: v.name,
          sku: v.sku,
          category: v.category,
          onHandQty: v.onHandQty,
          reorderPoint: v.reorderPoint,
          unitOfMeasure: v.unitOfMeasure,
          storageLocation: v.storageLocation,
          createdBy: actor,
        },
      });
      await tx.cadStockEvent.create({
        data: {
          workspaceId,
          partId: part.id,
          delta: v.onHandQty,
          quantityAfter: v.onHandQty,
          reason: "opening balance",
          actor,
        },
      });
      return part;
    });
  }

  async listParts(
    workspaceId: string,
    opts?: { category?: string; lowStockOnly?: boolean },
  ) {
    const parts = await this.prisma.cadPart.findMany({
      where: { workspaceId, category: opts?.category ?? undefined },
      orderBy: { name: "asc" },
    });
    return parts
      .map((p) => ({ ...p, lowStock: isLowStock(p.onHandQty, p.reorderPoint) }))
      .filter((p) => (opts?.lowStockOnly ? p.lowStock : true));
  }

  async getPart(workspaceId: string, partId: string) {
    const part = await this.requirePart(workspaceId, partId);
    const [supplierLinks, recentEvents] = await Promise.all([
      this.prisma.cadPartSupplier.findMany({
        where: { workspaceId, partId: part.id },
        include: { supplier: { select: { id: true, name: true, contact: true, leadTime: true } } },
        orderBy: [{ preferred: "desc" }, { createdAt: "asc" }],
      }),
      this.prisma.cadStockEvent.findMany({
        where: { workspaceId, partId: part.id },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);
    return { part: { ...part, lowStock: isLowStock(part.onHandQty, part.reorderPoint) }, supplierLinks, recentEvents };
  }

  async updatePart(workspaceId: string, partId: string, patch: Partial<PartInput>) {
    const part = await this.requirePart(workspaceId, partId);
    // onHandQty is NEVER writable through updatePart — it only moves via
    // adjustStock, which writes the audit event. Attempting it is a hard error.
    if (patch.onHandQty !== undefined) {
      throw new CadError(
        "STOCK_NOT_EDITABLE",
        "On-hand quantity cannot be edited directly — use a stock adjustment (who/when/delta/reason).",
      );
    }
    const data: {
      name?: string;
      sku?: string | null;
      category?: string;
      reorderPoint?: number;
      unitOfMeasure?: string;
      storageLocation?: string | null;
    } = {};
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw new CadError("INVALID_PART", "A part name is required.");
      data.name = name;
    }
    if (patch.sku !== undefined) data.sku = patch.sku == null ? null : String(patch.sku).trim() || null;
    if (patch.category !== undefined) {
      const category = String(patch.category).trim() || "other";
      const valid = [
        "mechanical", "electrical", "fastener", "pcb", "cable", "tooling", "consumable", "other",
      ];
      if (!valid.includes(category)) throw new CadError("INVALID_PART", `Unknown part category "${category}".`);
      data.category = category;
    }
    if (patch.reorderPoint !== undefined) {
      const n = Number(patch.reorderPoint);
      if (!Number.isFinite(n) || n < 0) throw new CadError("INVALID_PART", "Reorder point must be non-negative.");
      data.reorderPoint = n;
    }
    if (patch.unitOfMeasure !== undefined) {
      data.unitOfMeasure = String(patch.unitOfMeasure).trim() || "pcs";
    }
    if (patch.storageLocation !== undefined) {
      data.storageLocation = patch.storageLocation == null ? null : String(patch.storageLocation).trim() || null;
    }
    void part;
    return this.prisma.cadPart.update({ where: { id: partId }, data });
  }

  async deletePart(workspaceId: string, partId: string) {
    await this.requirePart(workspaceId, partId);
    // Stock events and supplier links cascade; BOM lines keep the line and
    // lose the link (SetNull) — the BOM's manual history is preserved.
    await this.prisma.cadPart.delete({ where: { id: partId } });
  }

  /**
   * Auditable stock adjustment. Writes the CadStockEvent row and moves
   * onHandQty in one transaction — never a silent overwrite. Going below
   * zero fails closed unless the caller confirms explicitly.
   */
  async adjustStock(
    workspaceId: string,
    actor: string,
    partId: string,
    input: { delta: number; reason: string; confirmBelowZero?: boolean },
  ) {
    const part = await this.requirePart(workspaceId, partId);
    const computed = computeStockAdjustment(part.onHandQty, {
      delta: input.delta,
      reason: input.reason,
      confirmBelowZero: input.confirmBelowZero,
    });
    const identity = String(actor ?? "").trim();
    if (!identity) throw new CadError("INVALID_ACTOR", "A stock adjustment requires a non-empty actor identity.");
    return this.prisma.$transaction(async (tx) => {
      await tx.cadStockEvent.create({
        data: {
          workspaceId,
          partId: part.id,
          delta: computed.delta,
          quantityAfter: computed.quantityAfter,
          reason: computed.reason,
          actor: identity,
        },
      });
      return tx.cadPart.update({
        where: { id: part.id },
        data: { onHandQty: computed.quantityAfter },
      });
    });
  }

  async listStockEvents(workspaceId: string, partId: string, take = 50) {
    await this.requirePart(workspaceId, partId);
    return this.prisma.cadStockEvent.findMany({
      where: { workspaceId, partId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(take, 1), 200),
    });
  }

  // ---------- Suppliers ----------

  async createSupplier(workspaceId: string, actor: string, input: SupplierInput) {
    const v = validateSupplierInput(input);
    return this.prisma.cadSupplier.create({
      data: {
        workspaceId,
        name: v.name,
        contact: v.contact,
        leadTime: v.leadTime,
        notes: v.notes,
        createdBy: actor,
      },
    });
  }

  async listSuppliers(workspaceId: string) {
    return this.prisma.cadSupplier.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
      include: { _count: { select: { partLinks: true } } },
    });
  }

  async getSupplier(workspaceId: string, supplierId: string) {
    const supplier = await this.requireSupplier(workspaceId, supplierId);
    const partLinks = await this.prisma.cadPartSupplier.findMany({
      where: { workspaceId, supplierId: supplier.id },
      include: { part: { select: { id: true, name: true, sku: true, onHandQty: true, unitOfMeasure: true } } },
      orderBy: { createdAt: "asc" },
    });
    return { supplier, partLinks };
  }

  async updateSupplier(workspaceId: string, supplierId: string, patch: Partial<SupplierInput>) {
    await this.requireSupplier(workspaceId, supplierId);
    const data: { name?: string; contact?: string | null; leadTime?: string | null; notes?: string | null } = {};
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw new CadError("INVALID_SUPPLIER", "A supplier name is required.");
      data.name = name;
    }
    if (patch.contact !== undefined) data.contact = patch.contact == null ? null : String(patch.contact).trim() || null;
    if (patch.leadTime !== undefined) data.leadTime = patch.leadTime == null ? null : String(patch.leadTime).trim() || null;
    if (patch.notes !== undefined) data.notes = patch.notes == null ? null : String(patch.notes).trim() || null;
    return this.prisma.cadSupplier.update({ where: { id: supplierId }, data });
  }

  /**
   * Deleting a supplier with linked parts fails closed — unlink the parts
   * first, explicitly. Cost lineage must never disappear silently.
   */
  async deleteSupplier(workspaceId: string, supplierId: string) {
    const supplier = await this.requireSupplier(workspaceId, supplierId);
    const linked = await this.prisma.cadPartSupplier.count({
      where: { workspaceId, supplierId: supplier.id },
    });
    if (linked > 0) {
      throw new CadError(
        "SUPPLIER_HAS_PARTS",
        `${supplier.name} is linked to ${linked} part(s). Unlink the parts first — deleting a supplier must never silently drop part cost lineage.`,
      );
    }
    await this.prisma.cadSupplier.delete({ where: { id: supplier.id } });
  }

  // ---------- Part ↔ supplier links (quoted-cost sourcing) ----------

  async linkPartSupplier(
    workspaceId: string,
    actor: string,
    partId: string,
    supplierId: string,
    input: PartSupplierLinkInput,
  ) {
    const part = await this.requirePart(workspaceId, partId);
    const supplier = await this.requireSupplier(workspaceId, supplierId);
    const v = validatePartSupplierLinkInput(input);
    return this.prisma.$transaction(async (tx) => {
      if (v.preferred) {
        await tx.cadPartSupplier.updateMany({
          where: { workspaceId, partId: part.id, preferred: true },
          data: { preferred: false },
        });
      }
      return tx.cadPartSupplier.upsert({
        where: { partId_supplierId: { partId: part.id, supplierId: supplier.id } },
        create: {
          workspaceId,
          partId: part.id,
          supplierId: supplier.id,
          quotedUnitCost: v.quotedUnitCost,
          currency: v.currency,
          quotedDate: v.quotedDate,
          quoteSource: v.quoteSource,
          preferred: v.preferred,
          createdBy: actor,
        },
        update: {
          quotedUnitCost: v.quotedUnitCost,
          currency: v.currency,
          quotedDate: v.quotedDate,
          quoteSource: v.quoteSource,
          preferred: v.preferred,
        },
      });
    });
  }

  async listPartSuppliers(workspaceId: string, partId: string) {
    await this.requirePart(workspaceId, partId);
    return this.prisma.cadPartSupplier.findMany({
      where: { workspaceId, partId },
      include: { supplier: { select: { id: true, name: true, contact: true, leadTime: true } } },
      orderBy: [{ preferred: "desc" }, { createdAt: "asc" }],
    });
  }

  async updatePartSupplierLink(
    workspaceId: string,
    linkId: string,
    patch: Partial<PartSupplierLinkInput>,
  ) {
    const link = await this.requireLink(workspaceId, linkId);
    const merged: PartSupplierLinkInput = {
      quotedUnitCost: patch.quotedUnitCost !== undefined ? patch.quotedUnitCost : link.quotedUnitCost,
      currency: patch.currency !== undefined ? patch.currency : link.currency,
      quotedDate: patch.quotedDate !== undefined ? patch.quotedDate : link.quotedDate,
      quoteSource: patch.quoteSource !== undefined ? patch.quoteSource : link.quoteSource,
      preferred: patch.preferred !== undefined ? patch.preferred : link.preferred,
    };
    const v = validatePartSupplierLinkInput(merged);
    return this.prisma.$transaction(async (tx) => {
      if (v.preferred && !link.preferred) {
        await tx.cadPartSupplier.updateMany({
          where: { workspaceId, partId: link.partId, preferred: true, id: { not: link.id } },
          data: { preferred: false },
        });
      }
      return tx.cadPartSupplier.update({
        where: { id: link.id },
        data: {
          quotedUnitCost: v.quotedUnitCost,
          currency: v.currency,
          quotedDate: v.quotedDate,
          quoteSource: v.quoteSource,
          preferred: v.preferred,
        },
      });
    });
  }

  async deletePartSupplierLink(workspaceId: string, linkId: string) {
    const link = await this.requireLink(workspaceId, linkId);
    await this.prisma.cadPartSupplier.delete({ where: { id: link.id } });
  }

  /**
   * The preferred supplier's quoted cost for a part, in USD. Returns null
   * unless the preferred link has a quoted cost AND is in USD — non-USD
   * quotes stay cited on the link; no FX rate is invented. This is the
   * sourcing behind every BOM line cost that came from a supplier quote.
   */
  async getPreferredQuoteCost(workspaceId: string, partId: string): Promise<QuoteRef | null> {
    const part = await this.requirePart(workspaceId, partId);
    const link = await this.prisma.cadPartSupplier.findFirst({
      where: { workspaceId, partId: part.id, preferred: true },
      include: { supplier: { select: { name: true } } },
    });
    if (!link) return null;
    const usable = preferredQuoteCostUsd(link);
    if (!usable) return null;
    return {
      supplierName: link.supplier.name,
      costUsd: usable.costUsd,
      currency: link.currency,
      quotedDate: link.quotedDate,
      quoteSource: link.quoteSource,
      citation: quoteCitation({
        supplierName: link.supplier.name,
        quotedUnitCost: link.quotedUnitCost,
        currency: link.currency,
        quotedDate: link.quotedDate,
        quoteSource: link.quoteSource,
      }),
    };
  }

  /**
   * Adds a BOM line linked to an inventory part. When the caller does not
   * provide a unit cost, the preferred supplier's quoted USD cost is used
   * (when one exists); otherwise the cost stays null and the slice-3
   * rollup flags the line as unknown cost (lower-bound warning).
   *
   * The line's source stays "manual": the tenant confirmed the line. The
   * quote citation is returned alongside so the UI labels the basis.
   */
  async addBomLineWithInventoryPart(
    workspaceId: string,
    actor: string,
    bomVersionId: string,
    input: BomLineInput & { inventoryPartId?: string },
  ) {
    let inventoryPartId: string | null = null;
    let quote: QuoteRef | null = null;
    const merged: BomLineInput = { ...input };
    delete (merged as unknown as Record<string, unknown>).inventoryPartId;
    if (input.inventoryPartId != null && String(input.inventoryPartId).trim() !== "") {
      const part = await this.requirePart(workspaceId, String(input.inventoryPartId).trim());
      inventoryPartId = part.id;
      if (merged.unitCostUsd == null) {
        quote = await this.getPreferredQuoteCost(workspaceId, part.id);
        if (quote) {
          merged.unitCostUsd = quote.costUsd;
          // Label the supplier on the line — it flows through the rollup
          // into the estimate's BOM lineage.
          if (merged.supplier == null || String(merged.supplier).trim() === "") {
            merged.supplier = quote.supplierName;
          }
        }
      }
    }
    const line = await super.addBomLine(workspaceId, actor, bomVersionId, merged);
    if (inventoryPartId) {
      await this.prisma.cadBomLine.update({
        where: { id: line.id },
        data: { inventoryPartId },
      });
    }
    return { line, quote };
  }

  // ---------- Tasks / issues ----------

  private async requireVersionInProject(
    workspaceId: string,
    projectId: string,
    versionId: string,
  ) {
    const version = await this.prisma.cadModelVersion.findFirst({
      where: { id: versionId, workspaceId },
      include: {
        model: { select: { id: true, name: true, projectId: true } },
      },
    });
    if (!version) throw new CadError("VERSION_NOT_FOUND", "CAD model version not found.");
    if (version.model.projectId !== projectId) {
      throw new CadError(
        "VERSION_PROJECT_MISMATCH",
        "The pinned version belongs to a different project — tasks pin to revisions of their own project.",
      );
    }
    return version;
  }

  async createTask(workspaceId: string, actor: string, projectId: string, input: TaskInput) {
    const project = await this.requireProjectRow(workspaceId, projectId);
    const v = validateTaskInput(input);
    if (v.modelVersionId) {
      await this.requireVersionInProject(workspaceId, project.id, v.modelVersionId);
    }
    const identity = String(actor ?? "").trim();
    if (!identity) throw new CadError("INVALID_ACTOR", "Creating a task requires a non-empty actor identity.");
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.cadTask.create({
        data: {
          workspaceId,
          projectId: project.id,
          modelVersionId: v.modelVersionId,
          kind: v.kind,
          title: v.title,
          description: v.description,
          status: v.status,
          priority: v.priority,
          assignee: v.assignee,
          dueDate: v.dueDate,
          closedAt: v.status === "done" ? new Date() : null,
          closedBy: v.status === "done" ? identity : null,
          createdBy: identity,
        },
      });
      await tx.cadTaskComment.create({
        data: {
          workspaceId,
          taskId: task.id,
          eventKind: "created",
          body: `Task created${v.modelVersionId ? " (pinned to a model revision)" : ""}.`,
          author: identity,
          eventMeta: (v.modelVersionId ? { versionId: v.modelVersionId } : undefined) as unknown as Prisma.InputJsonValue | undefined,
        },
      });
      return task;
    });
  }

  async listTasks(
    workspaceId: string,
    projectId: string,
    filters?: { status?: string; kind?: string; assignee?: string },
  ) {
    await this.requireProjectRow(workspaceId, projectId);
    return this.prisma.cadTask.findMany({
      where: {
        workspaceId,
        projectId,
        status: filters?.status ?? undefined,
        kind: filters?.kind ?? undefined,
        assignee: filters?.assignee ?? undefined,
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      include: {
        modelVersion: {
          select: {
            id: true,
            versionNumber: true,
            format: true,
            model: { select: { id: true, name: true } },
          },
        },
      },
    });
  }

  async getTask(workspaceId: string, taskId: string) {
    const task = await this.requireTask(workspaceId, taskId);
    const [comments, version] = await Promise.all([
      this.prisma.cadTaskComment.findMany({
        where: { workspaceId, taskId: task.id },
        orderBy: { createdAt: "asc" },
      }),
      task.modelVersionId
        ? this.prisma.cadModelVersion.findFirst({
            where: { id: task.modelVersionId, workspaceId },
            select: {
              id: true,
              versionNumber: true,
              format: true,
              uploadedAt: true,
              model: { select: { id: true, name: true } },
            },
          })
        : null,
    ]);
    return { task, comments, pinnedVersion: version };
  }

  /**
   * Patches a task. Status changes append to the activity trail. Moving to
   * "done" stamps closedAt/closedBy; reopening clears them. The pinned
   * CadModelVersion row is NEVER written here — the pin is a reference.
   */
  async updateTask(workspaceId: string, actor: string, taskId: string, input: Partial<TaskInput>) {
    const task = await this.requireTask(workspaceId, taskId);
    const v = validateTaskPatch(input);
    const identity = String(actor ?? "").trim();
    if (!identity) throw new CadError("INVALID_ACTOR", "Updating a task requires a non-empty actor identity.");
    return this.prisma.$transaction(async (tx) => {
      const data: {
        title?: string;
        description?: string | null;
        kind?: string;
        status?: string;
        priority?: string;
        assignee?: string | null;
        dueDate?: Date | null;
        closedAt?: Date | null;
        closedBy?: string | null;
      } = { ...v };
      if (v.status && v.status !== task.status) {
        if (v.status === "done") {
          data.closedAt = new Date();
          data.closedBy = identity;
        } else if (task.status === "done") {
          data.closedAt = null;
          data.closedBy = null;
        }
      }
      const updated = await tx.cadTask.update({ where: { id: task.id }, data });
      if (v.status && v.status !== task.status) {
        await tx.cadTaskComment.create({
          data: {
            workspaceId,
            taskId: task.id,
            eventKind: "status_change",
            body: `Status changed from ${task.status} to ${v.status}.`,
            author: identity,
            eventMeta: { from: task.status, to: v.status } as unknown as Prisma.InputJsonValue,
          },
        });
      }
      return updated;
    });
  }

  /** (Re-)pins a task to a specific immutable model revision. */
  async pinTaskVersion(workspaceId: string, actor: string, taskId: string, modelVersionId: string) {
    const task = await this.requireTask(workspaceId, taskId);
    const version = await this.requireVersionInProject(workspaceId, task.projectId, modelVersionId);
    const identity = String(actor ?? "").trim();
    if (!identity) throw new CadError("INVALID_ACTOR", "Pinning a task requires a non-empty actor identity.");
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.cadTask.update({
        where: { id: task.id },
        data: { modelVersionId: version.id },
      });
      await tx.cadTaskComment.create({
        data: {
          workspaceId,
          taskId: task.id,
          eventKind: "version_pin",
          body: `Pinned to ${version.model.name} v${version.versionNumber}.`,
          author: identity,
          eventMeta: { versionId: version.id } as unknown as Prisma.InputJsonValue,
        },
      });
      return updated;
    });
  }

  async addTaskComment(workspaceId: string, author: string, taskId: string, body: string) {
    const task = await this.requireTask(workspaceId, taskId);
    const text = validateTaskCommentBody(body);
    const identity = String(author ?? "").trim();
    if (!identity) throw new CadError("INVALID_ACTOR", "A comment requires a non-empty author identity.");
    return this.prisma.cadTaskComment.create({
      data: { workspaceId, taskId: task.id, eventKind: "comment", body: text, author: identity },
    });
  }

  async deleteTask(workspaceId: string, taskId: string) {
    await this.requireTask(workspaceId, taskId);
    await this.prisma.cadTask.delete({ where: { id: taskId } });
  }

  // ---------- Project dashboard rollup ----------

  /**
   * Per-project rollup for the dashboard: open task/issue counts, low-stock
   * parts relevant to this project (parts referenced by its BOMs), the
   * latest BOM's known cost per model, the latest model revision per model,
   * and recent activity. Every figure comes from real rows — nothing here
   * is computed from a guess.
   */
  async getProjectDashboard(workspaceId: string, projectId: string) {
    const project = await this.requireProjectRow(workspaceId, projectId);

    const [tasks, models] = await Promise.all([
      this.prisma.cadTask.findMany({ where: { workspaceId, projectId: project.id } }),
      this.prisma.cadModel.findMany({
        where: { workspaceId, projectId: project.id },
        include: {
          currentVersion: { select: { id: true, versionNumber: true, format: true, uploadedAt: true } },
          versions: {
            orderBy: { versionNumber: "desc" },
            take: 1,
            select: { id: true, versionNumber: true, format: true, uploadedAt: true },
          },
        },
        orderBy: { name: "asc" },
      }),
    ]);

    const openTasks = tasks.filter((t) => t.kind === "task" && isTaskOpen(t.status));
    const openIssues = tasks.filter((t) => t.kind === "issue" && isTaskOpen(t.status));
    const doneCount = tasks.filter((t) => t.status === "done").length;

    const latestVersions: DashboardLatestVersion[] = models.map((m) => {
      const v = m.currentVersion ?? m.versions[0];
      return v
        ? {
            modelId: m.id,
            modelName: m.name,
            versionId: v.id,
            versionNumber: v.versionNumber,
            format: v.format,
            uploadedAt: v.uploadedAt,
          }
        : null;
    }).filter((v): v is DashboardLatestVersion => v != null);

    // Active BOM cost: the latest BOM version per model (highest bomNumber),
    // rolled up from its real lines. knownCostUsd is the sum of known line
    // costs — lines with unknown unit cost contribute $0 and are counted in
    // linesMissingCost (the slice-3 lower-bound discipline).
    const bomCosts: DashboardBomCost[] = [];
    const projectPartIds = new Set<string>();
    for (const m of models) {
      const latestBom = await this.prisma.cadBomVersion.findFirst({
        where: { workspaceId, modelId: m.id },
        orderBy: { bomNumber: "desc" },
        include: { lines: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
      });
      if (!latestBom) {
        bomCosts.push({
          modelId: m.id,
          modelName: m.name,
          bomVersionId: null,
          bomNumber: null,
          knownCostUsd: null,
          linesMissingCost: 0,
          basis: "no BOM version for this model",
        });
        continue;
      }
      for (const line of latestBom.lines) {
        if (line.inventoryPartId) projectPartIds.add(line.inventoryPartId);
      }
      const rollup = computeBomRollup(
        latestBom.lines.map((l) => ({
          id: l.id,
          partName: l.partName,
          qty: l.qty,
          unitName: l.unitName,
          materialSpec: l.materialSpec,
          supplier: l.supplier,
          unitCostUsd: l.unitCostUsd,
          source: l.source,
        })),
      );
      bomCosts.push({
        modelId: m.id,
        modelName: m.name,
        bomVersionId: latestBom.id,
        bomNumber: latestBom.bomNumber,
        knownCostUsd: rollup.totalUsd,
        linesMissingCost: rollup.linesMissingCost,
        basis: `BOM #${latestBom.bomNumber} rollup of ${rollup.lineCount} lines; unknown-cost lines contribute $0`,
      });
    }
    const projectKnownCostUsd = bomCosts.reduce(
      (sum, b) => sum + (b.knownCostUsd ?? 0),
      0,
    );

    // Low-stock parts relevant to this project: parts referenced by its BOM
    // lines that are at/below their reorder point.
    const lowStockParts = projectPartIds.size
      ? (
          await this.prisma.cadPart.findMany({
            where: { workspaceId, id: { in: [...projectPartIds] } },
            orderBy: { name: "asc" },
          })
        ).filter((p) => isLowStock(p.onHandQty, p.reorderPoint))
      : [];

    // Recent activity: task trail + stock events on project parts, newest
    // first. Each entry says exactly what happened and who did it.
    const [taskComments, stockEvents] = await Promise.all([
      this.prisma.cadTaskComment.findMany({
        where: { workspaceId, taskId: { in: tasks.map((t) => t.id) } },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { task: { select: { id: true, title: true, kind: true } } },
      }),
      this.prisma.cadStockEvent.findMany({
        where: { workspaceId, partId: { in: [...projectPartIds] } },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: { part: { select: { id: true, name: true } } },
      }),
    ]);
    const recentActivity = [
      ...taskComments.map((c) => ({
        type: "task" as const,
        at: c.createdAt,
        author: c.author,
        text: `${c.eventKind === "comment" ? "Comment" : c.eventKind.replace(/_/g, " ")} on ${c.task.kind} "${c.task.title}": ${c.body}`,
        refId: c.task.id,
      })),
      ...stockEvents.map((e) => ({
        type: "stock" as const,
        at: e.createdAt,
        author: e.actor,
        text: `Stock ${e.delta >= 0 ? "+" : ""}${e.delta} ${e.part.name} (${e.reason}) — now ${e.quantityAfter}`,
        refId: e.part.id,
      })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 20);

    return {
      project: { id: project.id, name: project.name, description: project.description },
      counts: {
        openTasks: openTasks.length,
        openIssues: openIssues.length,
        blocked: tasks.filter((t) => t.status === "blocked").length,
        done: doneCount,
        total: tasks.length,
        models: models.length,
      },
      lowStockParts: lowStockParts.map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        onHandQty: p.onHandQty,
        reorderPoint: p.reorderPoint,
        unitOfMeasure: p.unitOfMeasure,
      })),
      bomCosts,
      projectKnownCostUsd,
      latestVersions,
      recentActivity,
    };
  }
}

export type { TaskStatus };
