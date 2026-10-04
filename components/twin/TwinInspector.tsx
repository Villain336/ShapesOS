// ShapesOS — Phase 13 (twinui): the inspector (right panel) for the selected
// object: its derived facts, the bound record with a link to its ops page,
// agents working on it, its alert, and ACTIONS — book a dock, advance or
// cancel a booking, assign / free equipment, start / pause or open the work
// order — through the generic ops routes with the gated-write pattern
// (useGatedWrite / useGatedPatch + OpsApprovalCard when a gate applies).

"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { ArrowRight, BellRing, CalendarPlus, ExternalLink, Pause, Play, Unlink, X } from "lucide-react";
import type { TwinObject, TwinSnapshot } from "@/lib/twin/types";
import { STATUS_META } from "@/lib/aos/status";
import { StatusShape } from "@/components/aos/StatusShape";
import { OpsApprovalCard } from "@/components/crm/OpsApprovalCard";
import { btnGhostSm, btnPrimarySm, btnDenySm, errorBoxCls, inputCls, labelCls, noteBoxCls, selectCls } from "@/components/crm/ui";
import { useGatedPatch, useGatedWrite } from "@/components/ops/shared";
import { BINDING_LABEL, KIND_LABEL, agentsByObject, inspectorFacts, recordHref, sentenceCase } from "@/lib/twin/view-model";
import { TWIN_SLUGS, assignEquipmentBody, bookDockBody, freeEquipmentBody, nextBookingStatus } from "@/lib/twin/client-api";
import { cn } from "@/lib/utils";

type Gate = ReturnType<typeof useGatedWrite>;

function GateUi({ gate, label }: { gate: Gate; label: string }) {
  return (
    <>
      {gate.error && <div className={cn(errorBoxCls, "mb-2")}>{gate.error}</div>}
      {gate.note && <div className={cn(noteBoxCls, "mb-2")}>{gate.note}</div>}
      {gate.pending && (
        <OpsApprovalCard
          pending={gate.pending}
          busy={gate.busy}
          executeLabel={label}
          onApprove={() => gate.decide("approved")}
          onDeny={() => gate.decide("denied")}
          onExecute={gate.execute}
        />
      )}
    </>
  );
}

/** "2026-10-04T10:30" for <input type="datetime-local">, one hour from now. */
function inAnHour(): string {
  const d = new Date(Date.now() + 3600_000);
  d.setSeconds(0, 0);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 16);
}

function DockActions({ o, onChanged }: { o: TwinObject; onChanged: () => void }) {
  const st = o.state.kind === "dock_door" ? o.state : null;
  const create = useGatedWrite(TWIN_SLUGS.dockBookings, "POST", onChanged);
  const patch = useGatedPatch(TWIN_SLUGS.dockBookings, onChanged);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ direction: "inbound" as "inbound" | "outbound", carrier: "", truckRef: "", eta: inAnHour() });
  const b = st?.booking ?? null;
  const next = b ? nextBookingStatus(b.status, b.direction) : null;
  return (
    <div className="flex flex-col gap-2">
      <GateUi gate={create} label="Book the dock" />
      <GateUi gate={patch} label="Update the booking" />
      <div className="flex flex-wrap gap-2">
        {b && next && (
          <button type="button" className={btnPrimarySm} disabled={patch.busy} onClick={() => patch.request({ id: b.id, status: next }, `${o.label}: ${b.truckRef ?? "booking"} → ${sentenceCase(next)}`)}>
            <ArrowRight size={13} /> Mark {sentenceCase(next).toLowerCase()}
          </button>
        )}
        {b && b.status === "booked" && (
          <button type="button" className={btnDenySm} disabled={patch.busy} onClick={() => patch.request({ id: b.id, status: "cancelled" }, `${o.label}: cancel ${b.truckRef ?? "booking"}`)}>
            Cancel booking
          </button>
        )}
        <button type="button" className={btnGhostSm} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <CalendarPlus size={13} /> Book this dock
        </button>
      </div>
      {open && (
        <form
          className="grid grid-cols-2 gap-2 rounded-md border border-line bg-canvas p-3"
          onSubmit={(e) => {
            e.preventDefault();
            const eta = new Date(form.eta);
            if (Number.isNaN(eta.getTime())) {
              create.setError("Pick an arrival time.");
              return;
            }
            void create.request(
              bookDockBody({ dockObjectId: o.id, direction: form.direction, carrier: form.carrier, truckRef: form.truckRef, eta: eta.toISOString() }),
              `${o.label}: ${form.direction} ${form.truckRef || "truck"} at ${form.eta.replace("T", " ")}`,
            );
          }}
        >
          <label className="col-span-2">
            <span className={labelCls}>Direction</span>
            <select className={cn(selectCls, "w-full")} value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value as "inbound" | "outbound" })}>
              <option value="inbound">Inbound (goods arriving)</option>
              <option value="outbound">Outbound (goods leaving)</option>
            </select>
          </label>
          <label>
            <span className={labelCls}>Carrier</span>
            <input className={cn(inputCls, "w-full")} value={form.carrier} onChange={(e) => setForm({ ...form, carrier: e.target.value })} />
          </label>
          <label>
            <span className={labelCls}>Truck</span>
            <input className={cn(inputCls, "w-full")} value={form.truckRef} onChange={(e) => setForm({ ...form, truckRef: e.target.value })} />
          </label>
          <label className="col-span-2">
            <span className={labelCls}>Arrives</span>
            <input type="datetime-local" className={cn(inputCls, "w-full")} value={form.eta} onChange={(e) => setForm({ ...form, eta: e.target.value })} required />
          </label>
          <div className="col-span-2">
            <button type="submit" className={btnPrimarySm} disabled={create.busy}>
              Book the dock
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function EquipmentActions({ o, snapshot, onChanged }: { o: TwinObject; snapshot: TwinSnapshot; onChanged: () => void }) {
  const st = o.state.kind === "equipment" ? o.state : null;
  const gate = useGatedPatch(TWIN_SLUGS.objects, onChanged);
  const targets = snapshot.objects.filter((x) => x.binding?.type === "location" && !x.bindingBroken);
  const [target, setTarget] = useState(targets[0]?.binding?.id ?? "");
  const [note, setNote] = useState("");
  return (
    <div className="flex flex-col gap-2">
      <GateUi gate={gate} label="Update the equipment" />
      {st?.status === "busy" ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnPrimarySm} disabled={gate.busy} onClick={() => gate.request(freeEquipmentBody(o.id), `${o.label}: free`)}>
            <Unlink size={13} /> Free {o.label}
          </button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2 rounded-md border border-line bg-canvas p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!target) return;
            const t = targets.find((x) => x.binding?.id === target);
            void gate.request(assignEquipmentBody(o.id, { locationId: target, note }), `${o.label} → ${t?.label ?? "location"}${note ? `: ${note}` : ""}`);
          }}
        >
          <label>
            <span className={labelCls}>Send to</span>
            <select className={cn(selectCls, "w-full")} value={target} onChange={(e) => setTarget(e.target.value)} disabled={targets.length === 0}>
              {targets.length === 0 ? <option value="">No bound locations on this site</option> : null}
              {targets.map((x) => (
                <option key={x.id} value={x.binding!.id}>
                  {x.label} ({KIND_LABEL[x.kind].toLowerCase()})
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={labelCls}>Task</span>
            <input className={cn(inputCls, "w-full")} value={note} placeholder="Put away PO-0012 pallets" onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={btnPrimarySm} disabled={gate.busy || !target}>
              <ArrowRight size={13} /> Assign task
            </button>
            {st?.status !== "charging" && (
              <button type="button" className={btnGhostSm} disabled={gate.busy} onClick={() => gate.request(freeEquipmentBody(o.id, "charging"), `${o.label}: charging`)}>
                Park to charge
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

function WorkCentreActions({ o, onChanged }: { o: TwinObject; onChanged: () => void }) {
  const st = o.state.kind === "work_center" ? o.state : null;
  const gate = useGatedPatch("work-orders", onChanged);
  const wo = st?.workOrder ?? null;
  return (
    <div className="flex flex-col gap-2">
      <GateUi gate={gate} label="Update the work order" />
      <div className="flex flex-wrap gap-2">
        {wo && st?.status !== "running" && (
          <button type="button" className={btnPrimarySm} disabled={gate.busy} onClick={() => gate.request({ id: wo.id, status: "in_progress" }, `${o.label}: start ${wo.name}`)}>
            <Play size={13} /> Start work order
          </button>
        )}
        {wo && st?.status === "running" && (
          <button type="button" className={btnGhostSm} disabled={gate.busy} onClick={() => gate.request({ id: wo.id, status: "paused" }, `${o.label}: pause ${wo.name}`)}>
            <Pause size={13} /> Pause work order
          </button>
        )}
        <Link href="/dashboard/ops/manufacturing?view=work-orders" className={btnGhostSm}>
          <ExternalLink size={13} /> {wo ? "Open the work order" : "Work orders"}
        </Link>
      </div>
    </div>
  );
}

export function TwinInspector({
  object,
  snapshot,
  canEdit,
  onChanged,
  onClose,
  className,
}: {
  object: TwinObject | null;
  snapshot: TwinSnapshot;
  canEdit: boolean;
  onChanged: () => void;
  onClose: () => void;
  className?: string;
}) {
  const done = useCallback(() => onChanged(), [onChanged]);
  if (!object) {
    return (
      <aside aria-label="Inspector" className={cn("rounded-lg bg-paper px-4 py-3 shadow-hairline", className)}>
        <p className="text-sm font-semibold text-ink">Inspector</p>
        <p className="mt-1 text-sm text-muted">Select a dock, rack, machine or forklift to see its live state and actions.</p>
      </aside>
    );
  }
  const o = object;
  const facts = inspectorFacts(o);
  const href = recordHref(o.binding);
  const agents = agentsByObject(snapshot).get(o.id) ?? [];
  const tillHref = o.state.kind === "register" && o.state.sessionId ? `/dashboard/ops/pos/till/${encodeURIComponent(o.state.sessionId)}` : null;
  return (
    <aside aria-label={`Inspector: ${o.label}`} className={cn("flex min-h-0 flex-col rounded-lg bg-paper shadow-hairline", className)}>
      <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-muted">{KIND_LABEL[o.kind]}</p>
          <h2 className="stretch-heading truncate text-lg font-heading text-ink">{o.label}</h2>
          {o.pill ? (
            <span className="mt-1 inline-flex h-6 items-center rounded-full bg-paper px-2.5 text-xs font-semibold text-muted shadow-control">{o.pill}</span>
          ) : null}
        </div>
        <button type="button" onClick={onClose} aria-label="Close inspector" className="rounded-full p-1.5 text-muted hover:bg-hover-paper hover:text-ink">
          <X size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {o.alert && (
          <p className="mb-3 flex items-start gap-2 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink">
            <BellRing size={15} className="mt-0.5 shrink-0" aria-hidden />
            {o.alert.message}
          </p>
        )}
        {agents.length > 0 && (
          <div className="mb-3 flex flex-col gap-1.5">
            {agents.map((a) => (
              <Link key={a.runId} href={`/dashboard/runs/${encodeURIComponent(a.runId)}`} className="flex items-center gap-2 rounded-sm px-1 py-1 text-sm hover:bg-hover-paper">
                <StatusShape status={a.status} size={11} />
                <span className="font-semibold text-ink">{STATUS_META[a.status].label}</span>
                <span className="min-w-0 truncate text-muted">{a.label}</span>
              </Link>
            ))}
          </div>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {facts.map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-muted">{f.label}</dt>
              <dd className={cn("text-right font-medium text-ink", f.mono && "aos-mono text-xs leading-5")}>{f.value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 rounded-md border border-line px-3 py-2 text-sm">
          {o.binding ? (
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs text-muted">{BINDING_LABEL[o.binding.type]}</p>
                <p className={cn("truncate font-semibold", o.bindingBroken ? "text-muted" : "text-ink")}>
                  {o.bindingBroken ? "Unbound — the record is gone" : (o.binding.label ?? o.binding.id)}
                </p>
              </div>
              {href && !o.bindingBroken ? (
                <Link href={href} className={btnGhostSm}>
                  <ExternalLink size={13} /> Open
                </Link>
              ) : null}
            </div>
          ) : (
            <p className="text-muted">Not bound to a record{o.kind === "equipment" ? " — equipment keeps its own status" : ""}.</p>
          )}
        </div>
        {tillHref ? (
          <Link href={tillHref} className={cn(btnGhostSm, "mt-3")}>
            <ExternalLink size={13} /> Open the till
          </Link>
        ) : null}
        {canEdit && (
          <div className="mt-4">
            {o.kind === "dock_door" && <DockActions key={o.id} o={o} onChanged={done} />}
            {o.kind === "equipment" && <EquipmentActions key={o.id} o={o} snapshot={snapshot} onChanged={done} />}
            {o.kind === "work_center" && <WorkCentreActions key={o.id} o={o} onChanged={done} />}
          </div>
        )}
        {!canEdit && ["dock_door", "equipment", "work_center"].includes(o.kind) && (
          <p className="mt-4 text-xs text-muted">Editors can book docks, send equipment and run work orders from here.</p>
        )}
      </div>
    </aside>
  );
}
