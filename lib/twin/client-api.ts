// ShapesOS — Phase 13 (twinui): request bodies + entity slugs for the twin's
// writes through the generic ops CRUD (TWIN_API in lib/twin/types.ts). Kept in
// ONE place so the pages, inspector and layout editor agree with the data
// side's entity schemas (lib/ops/twin/entities.ts). PURE builders + tiny
// fetch helpers (client).

import { TWIN_API, type TwinBindingType, type TwinDockBookingStatus, type TwinFootprint, type TwinObjectKind, type TwinSiteKind } from "./types";
import { BOOKING_TRANSITIONS } from "./derive";

/** "/api/ops/twin-objects" → "twin-objects" (the generic route's entity slug). */
export function opsSlug(path: string): string {
  return path.replace(/^\/api\/ops\//, "");
}

export const TWIN_SLUGS = {
  sites: opsSlug(TWIN_API.sites),
  objects: opsSlug(TWIN_API.objects),
  dockBookings: opsSlug(TWIN_API.dockBookings),
} as const;

export interface ObjectDraft {
  kind: TwinObjectKind;
  label: string;
  footprint: TwinFootprint;
  binding: { type: TwinBindingType; id: string } | null;
}

/** POST body for a new layout object. */
export function createObjectBody(siteId: string, d: ObjectDraft): Record<string, unknown> {
  return {
    siteId,
    kind: d.kind,
    label: d.label,
    x: d.footprint.x,
    z: d.footprint.z,
    w: d.footprint.w,
    d: d.footprint.d,
    h: d.footprint.h,
    rotation: d.footprint.rotation,
    ...(d.binding ? { bindingType: d.binding.type, bindingId: d.binding.id } : {}),
  };
}

/** PATCH body: only what changed (footprint fields, label, binding). */
export function patchObjectBody(
  id: string,
  change: { label?: string; footprint?: Partial<TwinFootprint>; binding?: { type: TwinBindingType; id: string } | null },
): Record<string, unknown> {
  const body: Record<string, unknown> = { id };
  if (change.label !== undefined) body.label = change.label;
  if (change.footprint) {
    for (const k of ["x", "z", "w", "d", "h", "rotation"] as const) {
      if (change.footprint[k] !== undefined) body[k] = change.footprint[k];
    }
  }
  if (change.binding !== undefined) {
    body.bindingType = change.binding?.type ?? null;
    body.bindingId = change.binding?.id ?? null;
  }
  return body;
}

export function createSiteBody(input: { kind: TwinSiteKind; name: string; code: string; gridW: number; gridD: number; warehouseId: string }) {
  return { ...input };
}

export function bookDockBody(input: {
  siteId: string;
  dockObjectId: string;
  direction: "inbound" | "outbound";
  carrier: string;
  truckRef: string;
  eta: string;
}): Record<string, unknown> {
  return {
    siteId: input.siteId,
    dockObjectId: input.dockObjectId,
    direction: input.direction,
    carrier: input.carrier.trim() || undefined,
    truckRef: input.truckRef.trim() || undefined,
    eta: input.eta,
  };
}

/** The booking's next forward step (booked → arrived → loading | unloading → done), from the data side's BOOKING_TRANSITIONS. */
export function nextBookingStatus(status: string, direction: "inbound" | "outbound"): TwinDockBookingStatus | null {
  const moves = (BOOKING_TRANSITIONS[status as TwinDockBookingStatus] ?? []).filter((s) => s !== "cancelled");
  if (moves.length === 0) return null;
  const preferred = direction === "inbound" ? "unloading" : "loading";
  return moves.includes(preferred) ? preferred : moves[0]!;
}

/** Error text from a failed JSON response (server validation messages shown inline). */
export async function errorText(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: unknown; issues?: unknown };
  if (typeof data.error === "string" && data.error) return data.error;
  return fallback;
}

/** Remove a layout object (DELETE on the generic ops route; twin objects opt in with hooks.remove). */
export async function deleteObject(id: string): Promise<void> {
  const res = await fetch(`${TWIN_API.objects}?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorText(res, "Could not delete the object."));
}

/** PATCH body sending a piece of equipment to a location (its estimated position follows). */
export function assignEquipmentBody(id: string, task: { locationId: string; note: string }): Record<string, unknown> {
  return { id, equipmentStatus: "busy", taskLocationId: task.locationId, taskNote: task.note.trim() || null };
}

/** PATCH body freeing a piece of equipment (or parking it to charge). */
export function freeEquipmentBody(id: string, status: "available" | "charging" = "available"): Record<string, unknown> {
  return { id, equipmentStatus: status, taskLocationId: null, taskNote: null };
}
