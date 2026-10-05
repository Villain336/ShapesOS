// ShapesOS — Phase 13 (twincore): digital twin tools for the agent surface.
// Part of OPS_TOOLS (lib/chat/ops-tools.ts spreads TWIN_OPS_TOOLS into it) —
// same ToolDef contract, same runOps scoping, and the same ops services the
// twin's inspector buttons call (/api/ops/dock-bookings, /api/ops/twin-objects),
// so audit, workspace scoping, validation and the gate apply by construction.
//
//   twin_site_state        read (safe): KPIs, busy docks, alerts, stopped machines
//   twin_find              read (safe): objects / bookings / shipments / SKUs → object ids
//   twin_book_dock         book a free dock (action book_dock, Tier 1 — an
//                          automation rule can let it run; without one it asks)
//   twin_assign_equipment  give a forklift a task, or free it (assign_equipment, Tier 1)
//   twin_draft_layout      a DRAFT site + objects from a description and an
//                          optional floor-plan image (draft_site_layout, Tier 0);
//                          publishing stays a person's gated step
//
// Words matter here: lib/orchestrator/authority.ts reads "<name>: <description>"
// for Tier-3 verbs, so these descriptions say "inbound goods", "stock move"
// and "order" — never the money verbs.

import type { Prisma } from "@prisma/client";
import { opsCreate, opsEntityDef, opsPatch, type OpsActor } from "@/lib/ops/doctype";
import { siteSnapshotTx } from "@/lib/twin/state";
import { bookingClash, locationSubtree, type LocationNode } from "@/lib/twin/derive";
import { autoLayout, describeContext, normaliseModelLayout, type DraftContext, type DraftLayout } from "@/lib/twin/layout-draft";
import type { TwinObject, TwinSiteKind, TwinSnapshot } from "@/lib/twin/types";
import { TWIN_SITE_KINDS } from "@/lib/twin/types";
import type { ToolContext, ToolDef, ToolResult } from "./tools";

type Tx = Prisma.TransactionClient;

const opsTools = () => import("./ops-tools");

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function run(fn: (tx: Tx, actor: OpsActor, args: Record<string, unknown>) => Promise<ToolResult>) {
  return async (ctx: ToolContext, args: Record<string, unknown>) => (await opsTools()).runOps(ctx, (tx, actor) => fn(tx, actor, args));
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

/** A site by id or code; the only site when there is exactly one. */
export async function resolveSite(tx: Tx, actor: OpsActor, ref: string | undefined): Promise<{ id: string; code: string; name: string; warehouseId: string; kind: string }> {
  const ws = actor.workspaceId;
  if (ref) {
    const s = await tx.opsSite.findFirst({ where: { workspaceId: ws, OR: [{ id: ref }, { code: { equals: ref, mode: "insensitive" } }] } });
    if (!s) throw new Error(`No twin site "${ref}" in this workspace.`);
    return s;
  }
  const sites = await tx.opsSite.findMany({ where: { workspaceId: ws }, take: 2, orderBy: { createdAt: "asc" } });
  if (sites.length === 1) return sites[0]!;
  if (!sites.length) throw new Error("This workspace has no twin sites yet.");
  const all = await tx.opsSite.findMany({ where: { workspaceId: ws }, select: { code: true, name: true }, take: 20 });
  throw new Error(`Say which site: ${all.map((s) => `${s.code} (${s.name})`).join(", ")}.`);
}

function objectBy(snap: TwinSnapshot, ref: string | undefined, kind?: TwinObject["kind"]): TwinObject | undefined {
  if (!ref) return undefined;
  const q = ref.toLowerCase();
  const pool = kind ? snap.objects.filter((o) => o.kind === kind) : snap.objects;
  return (
    pool.find((o) => o.id === ref) ??
    pool.find((o) => o.binding?.id === ref) ??
    pool.find((o) => o.label.toLowerCase() === q) ??
    pool.find((o) => (o.binding?.label ?? "").toLowerCase().endsWith(`/${q}`))
  );
}

// ---------------------------------------------------------------------------
// twin_site_state
// ---------------------------------------------------------------------------

export function summarizeSnapshot(s: TwinSnapshot): ToolResult {
  const kpi = s.kpis.map((k) => `${k.label} ${k.value === null ? "no data yet" : k.unit === "pct" ? `${k.value}%` : k.unit === "cents" ? money(k.value) : k.value}${k.hint ? ` (${k.hint})` : ""}`);
  const docks = s.objects.filter((o) => o.state.kind === "dock_door" && o.state.status !== "free");
  const dockLines = docks.map((o) => {
    const st = o.state as Extract<TwinObject["state"], { kind: "dock_door" }>;
    return `${o.label} [${o.id}] ${st.status}: ${st.booking?.truckRef ?? st.booking?.carrier ?? "truck"}${st.booking?.ref ? ` ${st.booking.ref}` : ""} ${st.booking?.status ?? ""}`.trim();
  });
  const alerts = s.objects.filter((o) => o.alert).map((o) => `${o.label} [${o.id}]: ${o.alert!.message}`);
  const stopped = s.objects
    .filter((o) => o.state.kind === "work_center" && (o.state.status === "stopped" || o.state.status === "paused"))
    .map((o) => `${o.label} [${o.id}] ${(o.state as { status: string }).status}`);
  const equipment = s.objects
    .filter((o) => o.state.kind === "equipment")
    .map((o) => {
      const st = o.state as Extract<TwinObject["state"], { kind: "equipment" }>;
      return `${o.label} [${o.id}] ${st.status}${st.task ? `: ${st.task.note ?? st.task.label ?? ""}` : ""}`;
    });
  const summary =
    `${s.site.name} (${s.site.code}, ${s.site.kind}, ${s.site.status}). ${kpi.join("; ")}.` +
    ` Busy docks: ${dockLines.length ? dockLines.join("; ") : "none"}.` +
    ` Alerts: ${alerts.length ? alerts.join("; ") : "none"}.` +
    (s.site.kind === "factory" ? ` Stopped or paused machines: ${stopped.length ? stopped.join("; ") : "none"}.` : "") +
    ` Equipment: ${equipment.length ? equipment.join("; ") : "none"}.`;
  return {
    summary,
    details: {
      site: s.site,
      kpis: s.kpis,
      busyDocks: docks.map((o) => ({ objectId: o.id, label: o.label, state: o.state })),
      alerts: s.objects.filter((o) => o.alert).map((o) => ({ objectId: o.id, label: o.label, ...o.alert })),
      shipments: s.shipments.map((x) => ({ id: x.id, ref: x.ref, direction: x.direction, truckRef: x.truckRef, nextStep: x.steps.every((st) => st.done) ? null : x.steps[x.currentStep]?.label, late: x.late })),
      generatedAt: s.generatedAt,
    },
  };
}

export async function twinSiteStateCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>): Promise<ToolResult> {
  const site = await resolveSite(tx, actor, str(args.site));
  return summarizeSnapshot(await siteSnapshotTx(tx, actor.workspaceId, site.id));
}

// ---------------------------------------------------------------------------
// twin_find
// ---------------------------------------------------------------------------

export async function twinFindCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>): Promise<ToolResult> {
  const query = str(args.query);
  if (!query) throw new Error('"query" is required (e.g. "dock 3", "PO-AB12CD34", "forklift 2", a SKU)');
  const q = query.toLowerCase();
  const siteRef = str(args.site);
  const sites = siteRef ? [await resolveSite(tx, actor, siteRef)] : await tx.opsSite.findMany({ where: { workspaceId: actor.workspaceId }, take: 10, orderBy: { createdAt: "asc" } });
  const hits: Array<{ siteCode: string; objectId: string; label: string; kind: string; boundTo: string | null; why: string }> = [];
  const products = await tx.opsProduct.findMany({
    where: { workspaceId: actor.workspaceId, OR: [{ sku: { equals: query, mode: "insensitive" } }, { name: { contains: query, mode: "insensitive" } }] },
    select: { id: true, sku: true, name: true },
    take: 5,
  });
  for (const site of sites) {
    const snap = await siteSnapshotTx(tx, actor.workspaceId, site.id);
    const add = (o: TwinObject, why: string) => {
      if (!hits.some((h) => h.objectId === o.id && h.why === why)) hits.push({ siteCode: site.code, objectId: o.id, label: o.label, kind: o.kind, boundTo: o.binding ? `${o.binding.type} ${o.binding.label ?? o.binding.id}` : null, why });
    };
    for (const o of snap.objects) {
      if (o.id === query || o.binding?.id === query || o.label.toLowerCase().includes(q) || (o.binding?.label ?? "").toLowerCase().includes(q)) add(o, "name");
      if (o.state.kind === "dock_door" && o.state.booking) {
        const b = o.state.booking;
        if ([b.id, b.truckRef, b.carrier, b.ref].some((v) => v && v.toLowerCase().includes(q))) add(o, `booking ${b.ref ?? b.truckRef ?? b.id} (${b.status})`);
      }
    }
    for (const sh of snap.shipments) {
      if ([sh.id, sh.ref, sh.truckRef, sh.carrier].some((v) => v && v.toLowerCase().includes(q))) {
        const dock = snap.objects.find((o) => o.id === sh.dockObjectId);
        if (dock) add(dock, `shipment ${sh.ref ?? sh.truckRef ?? sh.id}: ${sh.steps.every((x) => x.done) ? "complete" : `next ${sh.steps[sh.currentStep]?.label ?? ""}`}`);
      }
    }
    // A SKU / product: the racks, bins and shelves holding it.
    if (products.length) {
      const locs: LocationNode[] = await tx.opsLocation.findMany({ where: { workspaceId: actor.workspaceId, warehouseId: site.warehouseId }, select: { id: true, parentId: true, kind: true, code: true, path: true } });
      const held = await tx.opsInventoryTxn.groupBy({
        by: ["productId", "locationId"],
        where: { workspaceId: actor.workspaceId, productId: { in: products.map((p) => p.id) }, locationId: { in: locs.map((l) => l.id) } },
        _sum: { delta: true },
      });
      for (const o of snap.objects) {
        if (o.binding?.type === "product" && products.some((p) => p.id === o.binding!.id)) add(o, "shelf for the product");
        if (o.binding?.type !== "location") continue;
        const sub = locationSubtree(o.binding.id, locs);
        for (const p of products) {
          const qty = held.filter((h) => h.productId === p.id && h.locationId && sub.has(h.locationId)).reduce((s, h) => s + (h._sum.delta ?? 0), 0);
          if (qty > 0) add(o, `holds ${qty} × ${p.sku} ${p.name}`);
        }
      }
    }
  }
  return {
    summary: hits.length
      ? `${hits.length} match(es) for "${query}": ${hits.slice(0, 15).map((h) => `${h.label} [${h.objectId}] in ${h.siteCode} — ${h.why}`).join("; ")}`
      : `Nothing on the twin matches "${query}".`,
    details: { query, hits: hits.slice(0, 50) },
  };
}

// ---------------------------------------------------------------------------
// twin_book_dock
// ---------------------------------------------------------------------------

export async function twinBookDockCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>): Promise<ToolResult> {
  const site = await resolveSite(tx, actor, str(args.site));
  const etaRaw = str(args.eta);
  const eta = etaRaw ? new Date(etaRaw) : null;
  if (!eta || Number.isNaN(eta.getTime())) throw new Error('"eta" must be an ISO date-time');
  const durationMinutes = args.durationMinutes === undefined ? 60 : Number(args.durationMinutes);
  const snap = await siteSnapshotTx(tx, actor.workspaceId, site.id);
  const docks = snap.objects.filter((o) => o.kind === "dock_door" && o.binding?.type === "location" && !o.bindingBroken);
  let dock = objectBy(snap, str(args.dock), "dock_door");
  if (str(args.dock) && !dock) throw new Error(`No dock door "${args.dock}" on ${site.code}. Docks: ${docks.map((d) => d.label).join(", ") || "none"}.`);
  if (!dock) {
    // The first dock whose slot is free at the ETA.
    const active = await tx.opsDockBooking.findMany({
      where: { workspaceId: actor.workspaceId, siteId: site.id, status: { in: ["booked", "arrived", "loading", "unloading"] } },
      select: { id: true, dockLocationId: true, status: true, eta: true, durationMinutes: true },
    });
    dock = docks.find((d) => !bookingClash({ status: "booked", eta, durationMinutes }, active.filter((b) => b.dockLocationId === d.binding!.id)));
    if (!dock) throw new Error(`No dock on ${site.code} is free at ${eta.toISOString()} for ${durationMinutes} min.`);
  }
  const body: Record<string, unknown> = { siteId: site.id, dockObjectId: dock.id, eta: eta.toISOString(), durationMinutes };
  for (const k of ["direction", "carrier", "truckRef", "purchaseOrderId", "orderId", "transferId", "notes"]) if (str(args[k])) body[k] = str(args[k]);
  const r = await opsCreate(tx, opsEntityDef("dock-bookings"), actor, body);
  if (r.outcome !== "done") throw new Error("expected a direct write, got an approval request");
  const row = r.row;
  return {
    summary: `Booked ${dock.label} [${dock.id}] (dock ${dock.binding?.id}) for ${String(row.direction)} truck ${row.truckRef ?? row.carrier ?? ""} at ${eta.toISOString()} — booking ${String(row.id)}.`.replace(/ {2,}/g, " "),
    details: { booking: row, dockObjectId: dock.id, siteId: site.id },
  };
}

// ---------------------------------------------------------------------------
// twin_assign_equipment
// ---------------------------------------------------------------------------

export async function twinAssignEquipmentCore(tx: Tx, actor: OpsActor, args: Record<string, unknown>): Promise<ToolResult> {
  const site = await resolveSite(tx, actor, str(args.site));
  const snap = await siteSnapshotTx(tx, actor.workspaceId, site.id);
  const item = objectBy(snap, str(args.equipment), "equipment");
  if (!item) throw new Error(`No equipment "${args.equipment ?? ""}" on ${site.code}. Equipment: ${snap.objects.filter((o) => o.kind === "equipment").map((o) => o.label).join(", ") || "none"}.`);
  const status = str(args.status) ?? (str(args.to) || str(args.note) ? "busy" : undefined);
  if (!status || !["busy", "available", "charging"].includes(status)) throw new Error('"status" must be busy (with "to" and/or "note"), available or charging');
  const body: Record<string, unknown> = { id: item.id, equipmentStatus: status };
  let target: TwinObject | undefined;
  if (status === "busy") {
    const to = str(args.to);
    if (to) {
      target = objectBy(snap, to);
      const locationId = target?.binding?.type === "location" ? target.binding.id : (await tx.opsLocation.findFirst({ where: { workspaceId: actor.workspaceId, id: to } }))?.id;
      if (!locationId) throw new Error(`"${to}" is not a location or an object bound to one on ${site.code}.`);
      body.taskLocationId = locationId;
    }
    if (str(args.note)) body.taskNote = str(args.note);
  }
  const r = await opsPatch(tx, opsEntityDef("twin-objects"), actor, body);
  if (r.outcome !== "done") throw new Error("expected a direct write, got an approval request");
  return {
    summary:
      status === "busy"
        ? `${item.label} [${item.id}] is now busy${target ? ` → ${target.label} [${target.id}]` : body.taskLocationId ? ` → location ${String(body.taskLocationId)}` : ""}${body.taskNote ? `: ${String(body.taskNote)}` : ""} (position estimated — no telemetry).`
        : `${item.label} [${item.id}] is now ${status}.`,
    details: r.row,
  };
}

// ---------------------------------------------------------------------------
// twin_draft_layout
// ---------------------------------------------------------------------------

const LAYOUT_TOOL = {
  name: "propose_layout",
  description: "Return the proposed site layout. Call it exactly once.",
  inputSchema: {
    type: "object" as const,
    properties: {
      gridW: { type: "integer", description: "Grid width in 1 m cells (4–400)." },
      gridD: { type: "integer", description: "Grid depth in 1 m cells (4–400)." },
      objects: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["building", "dock_door", "rack", "bin_zone", "yard_slot", "work_center", "register", "shelf", "path", "equipment"] },
            label: { type: "string" },
            x: { type: "integer" },
            z: { type: "integer" },
            w: { type: "integer" },
            d: { type: "integer" },
            h: { type: "integer" },
            rotation: { type: "integer", enum: [0, 90, 180, 270] },
            bind: { type: "string", description: "Code of the record to bind (location code, work-centre code or register name), if any." },
          },
          required: ["kind", "label", "x", "z", "w", "d"],
        },
      },
    },
    required: ["gridW", "gridD", "objects"],
  },
};

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Ask the model for a layout. Returns null (and why) when no live model can do it. */
export async function proposeLayoutWithModel(
  ctx: ToolContext,
  draftCtx: DraftContext,
  description: string,
  image: { mimeType: string; bytes: Buffer } | null,
): Promise<{ layout: DraftLayout | null; notes: string[] }> {
  const notes: string[] = [];
  // Phase 15.1: the workspace's own model key when it has one.
  const { resolveWorkloadForWorkspace } = await import("@/lib/llm/workspace");
  const provider = (await resolveWorkloadForWorkspace("subagent", ctx.workspaceId)).provider;
  if (!provider.isLive) return { layout: null, notes: ["No live language model is configured, so the description was not read."] };
  const content: Array<Record<string, unknown>> = [];
  if (image) {
    if (provider.name === "anthropic" && IMAGE_TYPES.has(image.mimeType) && image.bytes.length <= 5 * 1024 * 1024) {
      content.push({ type: "opaque", provider: "anthropic", kind: "image", raw: { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.bytes.toString("base64") } } });
      notes.push("The floor-plan image was read by the model.");
    } else {
      notes.push(`The floor-plan image was not used: the configured model (${provider.name}) isn't sent images here${IMAGE_TYPES.has(image.mimeType) ? "" : `, and ${image.mimeType} isn't an image type it reads`}. The draft follows the description only.`);
    }
  }
  content.push({
    type: "text",
    text:
      `Lay out this site on a grid of 1 m cells (x east, z south). Objects must not overlap (paths and equipment may). Keep everything inside the grid.\n\n` +
      `${describeContext(draftCtx)}\n\nDescription from the user:\n${description.slice(0, 4000)}`,
  });
  const res = await provider.chat({
    system: "You draft warehouse, factory and store floor layouts for a digital twin. Use only the record codes given when binding objects. Answer by calling propose_layout once.",
    messages: [{ role: "user", content: content as never }],
    tools: [LAYOUT_TOOL],
    toolChoice: "auto",
    maxTokens: 8000,
    usage: { workspaceId: ctx.workspaceId, projectId: ctx.projectId, actorId: ctx.userId, runId: ctx.runId ?? null, agentKey: ctx.agentKey ?? null },
    signal: ctx.signal,
  });
  const call = res.content.find((b) => b.type === "tool_use" && b.name === LAYOUT_TOOL.name && !b.invalid) as { input: unknown } | undefined;
  let raw: unknown = call?.input;
  if (!raw) {
    const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
    const m = text.match(/\{[\s\S]*\}/);
    try {
      raw = m ? JSON.parse(m[0]) : null;
    } catch {
      raw = null;
    }
  }
  if (!raw) return { layout: null, notes: [...notes, "The model didn't return a layout."] };
  return { layout: normaliseModelLayout(raw, draftCtx), notes };
}

export async function loadDraftContext(tx: Tx, actor: OpsActor, warehouseRef: string, kind: TwinSiteKind): Promise<{ warehouse: { id: string; code: string; name: string }; ctx: DraftContext }> {
  const ws = actor.workspaceId;
  const warehouse = await tx.opsWarehouse.findFirst({ where: { workspaceId: ws, OR: [{ id: warehouseRef }, { code: { equals: warehouseRef, mode: "insensitive" } }] } });
  if (!warehouse) throw new Error(`No warehouse "${warehouseRef}" in this workspace.`);
  const locations = await tx.opsLocation.findMany({ where: { workspaceId: ws, warehouseId: warehouse.id, active: true }, select: { id: true, parentId: true, kind: true, code: true, name: true }, orderBy: { path: "asc" }, take: 2000 });
  const locIds = locations.map((l) => l.id);
  const workCenters = await tx.opsWorkCenter.findMany({ where: { workspaceId: ws, active: true, locationId: { in: locIds } }, select: { id: true, code: true, name: true } });
  const registers = await tx.opsPosRegister.findMany({ where: { workspaceId: ws, active: true, locationId: { in: locIds } }, select: { id: true, name: true } });
  return { warehouse, ctx: { kind, locations, workCenters, registers } };
}

export async function writeDraftSite(
  tx: Tx,
  actor: OpsActor,
  input: { kind: TwinSiteKind; name: string; code: string; warehouseId: string; notes: string },
  layout: DraftLayout,
): Promise<{ siteId: string; created: number; skipped: string[] }> {
  const site = await opsCreate(tx, opsEntityDef("twin-sites"), actor, { kind: input.kind, name: input.name, code: input.code, gridW: layout.gridW, gridD: layout.gridD, warehouseId: input.warehouseId, notes: input.notes.slice(0, 5000) });
  if (site.outcome !== "done") throw new Error("expected a draft site");
  const siteId = String(site.row.id);
  const skipped: string[] = [];
  let created = 0;
  for (const o of layout.objects) {
    try {
      const r = await opsCreate(tx, opsEntityDef("twin-objects"), actor, { siteId, ...o });
      if (r.outcome === "done") created++;
    } catch (e) {
      // Validation refusals (OpsError) never touch the database, so the transaction stays usable.
      skipped.push(`"${o.label}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { siteId, created, skipped };
}

export async function twinDraftLayout(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const kind = str(args.kind) as TwinSiteKind | undefined;
  if (!kind || !(TWIN_SITE_KINDS as readonly string[]).includes(kind)) throw new Error('"kind" must be warehouse, factory or store');
  const warehouseRef = str(args.warehouse);
  if (!warehouseRef) throw new Error('"warehouse" (id or code) is required — a site lays out an existing warehouse');
  const description = str(args.description) ?? "";
  const { runOps } = await opsTools();
  const { warehouse, ctx: draftCtx } = await runOps(ctx, (tx, actor) => loadDraftContext(tx, actor, warehouseRef, kind));
  const code = (str(args.code) ?? `${warehouse.code}-TWIN`).slice(0, 32);
  const name = str(args.name) ?? `${warehouse.name} layout`;

  // The image (optional): a workspace file the user uploaded.
  let image: { mimeType: string; bytes: Buffer } | null = null;
  const fileId = str(args.fileId);
  const notes: string[] = [];
  if (fileId) {
    const { readFile } = await import("@/lib/filesystem/service");
    const f = await readFile({ workspaceId: ctx.workspaceId, fileId });
    if (!f) throw new Error(`No file "${fileId}" in this workspace.`);
    image = { mimeType: f.meta.mimeType, bytes: f.bytes };
  }

  let layout: DraftLayout | null = null;
  let source = "records";
  if (description || image) {
    const proposed = await proposeLayoutWithModel(ctx, draftCtx, description || "Lay out the warehouse's records sensibly.", image);
    notes.push(...proposed.notes);
    if (proposed.layout && proposed.layout.objects.length) {
      layout = proposed.layout;
      source = "model";
    }
  }
  if (!layout) {
    layout = autoLayout(draftCtx);
    notes.push("Laid out from the warehouse's own records (racks, zones, shelves, docks, work centres, registers).");
  }
  notes.push(...layout.notes);
  const written = await runOps(ctx, (tx, actor) =>
    writeDraftSite(tx, actor, { kind, name, code, warehouseId: warehouse.id, notes: `Drafted by an agent (${source}). ${notes.join(" ")}` }, layout!),
  );
  return {
    summary:
      `Drafted twin site ${code} [${written.siteId}] over warehouse ${warehouse.code}: ${written.created} object(s) on a ${layout.gridW}×${layout.gridD} grid` +
      `${written.skipped.length ? `, ${written.skipped.length} skipped` : ""}. It is a DRAFT — publishing it needs a person's approval. ${notes.join(" ")}`,
    details: { siteId: written.siteId, code, source, gridW: layout.gridW, gridD: layout.gridD, objects: written.created, skipped: [...written.skipped], notes },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const siteArg = { site: { type: "string", description: "Twin site id or code (optional when the workspace has one site)." } };

export const TWIN_OPS_TOOLS: ToolDef[] = [
  {
    name: "twin_site_state",
    description: "Digital twin: a compact summary of one site — KPIs, busy docks and their trucks, alerts (overdue trucks, low bins, stopped machines, registers left open), equipment and shipments, with object ids.",
    kind: "safe",
    minRole: "viewer",
    argsSchema: { type: "object", properties: { ...siteArg } },
    execute: run((tx, a, args) => twinSiteStateCore(tx, a, args)),
  },
  {
    name: "twin_find",
    description: 'Digital twin: find objects, dock bookings, shipments or products by text ("dock 3", an order ref, "forklift 2", a SKU) and return the matching object ids and what they are bound to.',
    kind: "safe",
    minRole: "viewer",
    argsSchema: { type: "object", properties: { query: { type: "string", description: "What to look for (required)." }, ...siteArg }, required: ["query"] },
    execute: run((tx, a, args) => twinFindCore(tx, a, args)),
  },
  {
    name: "twin_book_dock",
    description:
      "Digital twin: book a truck onto a dock door at an ETA (a named dock, or the first dock free for that slot). The booking can serve one inbound goods order, sales order or stock move. Shows on the twin within one live tick.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        ...siteArg,
        eta: { type: "string", description: "Expected arrival, ISO date-time (required)." },
        dock: { type: "string", description: "Dock door object id, label (\"Dock 3\") or dock location id (optional: first free dock)." },
        durationMinutes: { type: "string", description: "Slot length in minutes (optional, default 60)." },
        direction: { type: "string", description: "inbound or outbound (optional: follows from what it serves)." },
        carrier: { type: "string", description: "Carrier name (optional)." },
        truckRef: { type: "string", description: "Truck / trailer reference (optional)." },
        purchaseOrderId: { type: "string", description: "Inbound goods order (PO) id it brings (optional)." },
        orderId: { type: "string", description: "Sales order id it takes away (optional)." },
        transferId: { type: "string", description: "Stock move id it carries (optional)." },
        notes: { type: "string", description: "Notes (optional)." },
      },
      required: ["eta"],
    },
    execute: run((tx, a, args) => twinBookDockCore(tx, a, args)),
  },
  {
    name: "twin_assign_equipment",
    description: "Digital twin: give a forklift or cart a task (busy, going to a location or object, with a note) or set it available / charging. Its position on the twin is an estimate.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        ...siteArg,
        equipment: { type: "string", description: "Equipment object id or label, e.g. \"Forklift 2\" (required)." },
        status: { type: "string", description: "busy, available or charging (default busy when a task is given)." },
        to: { type: "string", description: "Where the task is: an object id / label or a location id (optional)." },
        note: { type: "string", description: "What to do (optional)." },
      },
      required: ["equipment"],
    },
    execute: run((tx, a, args) => twinAssignEquipmentCore(tx, a, args)),
  },
  {
    name: "twin_draft_layout",
    description:
      "Digital twin: draft a site layout over an existing warehouse from a description and, optionally, an uploaded floor-plan image (read when the model supports images). Objects bind to the warehouse's records by code. Creates a DRAFT site; a person publishes it.",
    kind: "publish",
    minRole: "editor",
    argsSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "warehouse, factory or store (required)." },
        warehouse: { type: "string", description: "Warehouse id or code the site lays out (required)." },
        description: { type: "string", description: "How the floor is arranged (optional)." },
        fileId: { type: "string", description: "Workspace file id of a floor-plan image (optional)." },
        name: { type: "string", description: "Site name (optional)." },
        code: { type: "string", description: "Site code, e.g. WH-04 (optional)." },
      },
      required: ["kind", "warehouse"],
    },
    execute: (ctx, args) => twinDraftLayout(ctx, args),
  },
];
