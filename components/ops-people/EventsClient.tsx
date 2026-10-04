"use client";

// ShapesOS — Phase 12 (people): client islands for /dashboard/ops/events —
// new event (with its first ticket type), publish / unpublish / cancel,
// reminder sequence, sessions, ticket types, staff registrations (free or
// complimentary), cancelling a registration, and the reminders catch-up.
// Writes go through the generic /api/ops/{entity} route (editor+, audited).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { aosButton } from "@/components/aos";
import { Dialog, ErrorLine, Note, inputCls, labelCls, parseMoneyInput } from "@/components/ops-finance/kit";
import { confirmAction } from "@/lib/ui/feedback";
import { jsonPost } from "@/components/ops-finance/useGated";

async function readErr(r: Response): Promise<string> {
  const d = (await r.json().catch(() => ({}))) as { error?: string };
  return d.error ?? "That didn't work.";
}

/** "2026-11-05T18:00" (local input) → ISO. */
const iso = (local: string) => new Date(local).toISOString();

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<Response | void>, onOk: (r: Response | void) => void | Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r && !r.ok) setError(await readErr(r));
      else await onOk(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

export function NewEventButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: "", startsAt: "", endsAt: "", venue: "", webinarUrl: "", capacity: "", ticketName: "General admission", price: "", quantity: "" });
  const s = useSubmit();
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });

  function save(e: React.FormEvent) {
    e.preventDefault();
    const price = f.price.trim() ? parseMoneyInput(f.price) : 0;
    if (Number.isNaN(price)) return s.setError("Check the ticket price.");
    void s.run(
      async () => {
        const r = await jsonPost("/api/ops/events", {
          title: f.title.trim(),
          startsAt: iso(f.startsAt),
          endsAt: iso(f.endsAt),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(f.venue.trim() ? { venue: f.venue.trim() } : {}),
          ...(f.webinarUrl.trim() ? { webinarUrl: f.webinarUrl.trim() } : {}),
          ...(f.capacity.trim() ? { capacity: Number(f.capacity) } : {}),
        });
        if (!r.ok) return r;
        const d = (await r.json()) as { row: { id: string } };
        const t = await jsonPost("/api/ops/event-ticket-types", {
          eventId: d.row.id,
          name: f.ticketName.trim() || "General admission",
          priceCents: price,
          ...(f.quantity.trim() ? { quantity: Number(f.quantity) } : {}),
        });
        router.push(`/dashboard/ops/events/${d.row.id}${t.ok ? "" : `?error=${encodeURIComponent(await readErr(t))}`}`);
      },
      () => setOpen(false),
    );
  }

  return (
    <>
      <button type="button" className={aosButton({ variant: "primary" })} onClick={() => setOpen(true)}>
        <Plus size={18} aria-hidden /> New event
      </button>
      {open ? (
        <Dialog title="New event" onClose={() => !s.busy && setOpen(false)} wide>
          <form onSubmit={save} className="flex flex-col gap-4">
            <label>
              <span className={labelCls}>Title</span>
              <input className={inputCls} value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder="Autumn customer meetup" required />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label>
                <span className={labelCls}>Starts</span>
                <input type="datetime-local" className={inputCls} value={f.startsAt} onChange={(e) => set({ startsAt: e.target.value })} required />
              </label>
              <label>
                <span className={labelCls}>Ends</span>
                <input type="datetime-local" className={inputCls} value={f.endsAt} onChange={(e) => set({ endsAt: e.target.value })} required />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label>
                <span className={labelCls}>Venue (optional)</span>
                <input className={inputCls} value={f.venue} onChange={(e) => set({ venue: e.target.value })} placeholder="12 Market St, Boston" />
              </label>
              <label>
                <span className={labelCls}>Webinar link (optional)</span>
                <input className={inputCls} value={f.webinarUrl} onChange={(e) => set({ webinarUrl: e.target.value })} placeholder="https://" />
              </label>
            </div>
            <label>
              <span className={labelCls}>Total seats (optional)</span>
              <input className={inputCls} inputMode="numeric" value={f.capacity} onChange={(e) => set({ capacity: e.target.value })} placeholder="Unlimited" />
            </label>
            <fieldset className="grid grid-cols-3 gap-3 rounded-md bg-canvas p-4">
              <legend className="px-1 text-xs font-semibold text-muted">First ticket type</legend>
              <label>
                <span className={labelCls}>Name</span>
                <input className={inputCls} value={f.ticketName} onChange={(e) => set({ ticketName: e.target.value })} />
              </label>
              <label>
                <span className={labelCls}>Price</span>
                <input className={inputCls} inputMode="decimal" value={f.price} onChange={(e) => set({ price: e.target.value })} placeholder="Free" />
              </label>
              <label>
                <span className={labelCls}>How many</span>
                <input className={inputCls} inputMode="numeric" value={f.quantity} onChange={(e) => set({ quantity: e.target.value })} placeholder="No limit" />
              </label>
            </fieldset>
            <p className="text-sm text-muted">The event starts as a draft. Publish it when it's ready; paid tickets need Stripe connected in Finance settings.</p>
            {s.error ? <ErrorLine>{s.error}</ErrorLine> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={aosButton({ variant: "quiet" })} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" disabled={s.busy} className={aosButton({ variant: "primary" })}>
                {s.busy ? "Saving" : "Create draft"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

export function EventStatusActions({ id, status, title }: { id: string; status: string; title: string }) {
  const router = useRouter();
  const s = useSubmit();
  const move = async (to: string) => {
    if (
      to === "cancelled" &&
      !(await confirmAction({ title: `Cancel "${title}"?`, description: "Registration closes and tickets stop working. Refunds for paid tickets are issued in Stripe.", confirmLabel: "Cancel event", cancelLabel: "Keep event", destructive: true }))
    )
      return;
    void s.run(() => jsonPost("/api/ops/events", { id, status: to }, "PATCH"), () => router.refresh());
  };
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {status === "draft" ? (
          <button type="button" className={aosButton({ variant: "primary", size: "sm" })} disabled={s.busy} onClick={() => void move("published")}>
            Publish
          </button>
        ) : null}
        {status === "published" ? (
          <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} disabled={s.busy} onClick={() => void move("draft")}>
            Unpublish
          </button>
        ) : null}
        {status !== "cancelled" ? (
          <button type="button" className={aosButton({ variant: "deny", size: "sm" })} disabled={s.busy} onClick={() => void move("cancelled")}>
            Cancel event
          </button>
        ) : null}
      </div>
      {s.error ? <ErrorLine>{s.error}</ErrorLine> : null}
    </div>
  );
}

export function ReminderSequencePicker({ id, current, sequences }: { id: string; current: string | null; sequences: Array<{ id: string; name: string; status: string }> }) {
  const router = useRouter();
  const s = useSubmit();
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2 px-5 py-4">
      <label className="flex flex-wrap items-center gap-3">
        <span className="text-md">Enroll confirmed registrants in</span>
        <select
          className={`${inputCls} max-w-[320px]`}
          value={current ?? ""}
          disabled={s.busy}
          onChange={(e) => void s.run(() => jsonPost("/api/ops/events", { id, reminderSequenceId: e.target.value || null }, "PATCH"), () => router.refresh())}
        >
          <option value="">No reminders</option>
          {sequences.map((q) => (
            <option key={q.id} value={q.id}>
              {q.name}
              {q.status !== "active" ? ` (${q.status})` : ""}
            </option>
          ))}
        </select>
        {current ? (
          <button
            type="button"
            className={aosButton({ variant: "quiet", size: "xs" })}
            disabled={s.busy}
            onClick={() =>
              void s.run(
                () => jsonPost(`/api/ops/events/${id}/reminders`, {}),
                async (r) => {
                  const d = r ? ((await r.json()) as { enrolled: number; skipped: number }) : { enrolled: 0, skipped: 0 };
                  setNote(`${d.enrolled} enrolled${d.skipped ? `, ${d.skipped} skipped` : ""}.`);
                },
              )
            }
          >
            Enroll anyone missing
          </button>
        ) : null}
      </label>
      <p className="text-sm text-muted">Reminders use your nurture sequences: every message still waits for approval in the queue before it's sent.</p>
      {note ? <Note>{note}</Note> : null}
      {s.error ? <ErrorLine>{s.error}</ErrorLine> : null}
    </div>
  );
}

export function AddSessionButton({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: "", startsAt: "", endsAt: "", venue: "", capacity: "" });
  const s = useSubmit();
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  return (
    <>
      <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => setOpen(true)}>
        <Plus size={16} aria-hidden /> Add session
      </button>
      {open ? (
        <Dialog title="Add a session" onClose={() => !s.busy && setOpen(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void s.run(
                () =>
                  jsonPost("/api/ops/event-sessions", {
                    eventId,
                    title: f.title.trim(),
                    startsAt: iso(f.startsAt),
                    endsAt: iso(f.endsAt),
                    ...(f.venue.trim() ? { venue: f.venue.trim() } : {}),
                    ...(f.capacity.trim() ? { capacity: Number(f.capacity) } : {}),
                  }),
                () => {
                  setOpen(false);
                  router.refresh();
                },
              );
            }}
            className="flex flex-col gap-4"
          >
            <label>
              <span className={labelCls}>Title</span>
              <input className={inputCls} value={f.title} onChange={(e) => set({ title: e.target.value })} required />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label>
                <span className={labelCls}>Starts</span>
                <input type="datetime-local" className={inputCls} value={f.startsAt} onChange={(e) => set({ startsAt: e.target.value })} required />
              </label>
              <label>
                <span className={labelCls}>Ends</span>
                <input type="datetime-local" className={inputCls} value={f.endsAt} onChange={(e) => set({ endsAt: e.target.value })} required />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label>
                <span className={labelCls}>Room or venue (optional)</span>
                <input className={inputCls} value={f.venue} onChange={(e) => set({ venue: e.target.value })} />
              </label>
              <label>
                <span className={labelCls}>Seats (optional)</span>
                <input className={inputCls} inputMode="numeric" value={f.capacity} onChange={(e) => set({ capacity: e.target.value })} placeholder="Unlimited" />
              </label>
            </div>
            {s.error ? <ErrorLine>{s.error}</ErrorLine> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={aosButton({ variant: "quiet" })} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" disabled={s.busy} className={aosButton({ variant: "primary" })}>
                Add session
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

export function AddTicketButton({ eventId, sessions }: { eventId: string; sessions: Array<{ id: string; title: string }> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", price: "", quantity: "", sessionId: "", salesStartAt: "", salesEndAt: "", maxPerOrder: "10" });
  const s = useSubmit();
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  return (
    <>
      <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => setOpen(true)}>
        <Plus size={16} aria-hidden /> Add ticket type
      </button>
      {open ? (
        <Dialog title="Add a ticket type" onClose={() => !s.busy && setOpen(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const price = f.price.trim() ? parseMoneyInput(f.price) : 0;
              if (Number.isNaN(price)) return s.setError("Check the price.");
              void s.run(
                () =>
                  jsonPost("/api/ops/event-ticket-types", {
                    eventId,
                    name: f.name.trim(),
                    priceCents: price,
                    maxPerOrder: Number(f.maxPerOrder) || 10,
                    ...(f.quantity.trim() ? { quantity: Number(f.quantity) } : {}),
                    ...(f.sessionId ? { sessionId: f.sessionId } : {}),
                    ...(f.salesStartAt ? { salesStartAt: iso(f.salesStartAt) } : {}),
                    ...(f.salesEndAt ? { salesEndAt: iso(f.salesEndAt) } : {}),
                  }),
                () => {
                  setOpen(false);
                  router.refresh();
                },
              );
            }}
            className="flex flex-col gap-4"
          >
            <label>
              <span className={labelCls}>Name</span>
              <input className={inputCls} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Early bird" required />
            </label>
            <div className="grid grid-cols-3 gap-3">
              <label>
                <span className={labelCls}>Price</span>
                <input className={inputCls} inputMode="decimal" value={f.price} onChange={(e) => set({ price: e.target.value })} placeholder="Free" />
              </label>
              <label>
                <span className={labelCls}>How many</span>
                <input className={inputCls} inputMode="numeric" value={f.quantity} onChange={(e) => set({ quantity: e.target.value })} placeholder="No limit" />
              </label>
              <label>
                <span className={labelCls}>Max per order</span>
                <input className={inputCls} inputMode="numeric" value={f.maxPerOrder} onChange={(e) => set({ maxPerOrder: e.target.value })} />
              </label>
            </div>
            {sessions.length ? (
              <label>
                <span className={labelCls}>Admits to</span>
                <select className={inputCls} value={f.sessionId} onChange={(e) => set({ sessionId: e.target.value })}>
                  <option value="">The whole event</option>
                  {sessions.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.title} only
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <label>
                <span className={labelCls}>Sales open (optional)</span>
                <input type="datetime-local" className={inputCls} value={f.salesStartAt} onChange={(e) => set({ salesStartAt: e.target.value })} />
              </label>
              <label>
                <span className={labelCls}>Sales close (optional)</span>
                <input type="datetime-local" className={inputCls} value={f.salesEndAt} onChange={(e) => set({ salesEndAt: e.target.value })} />
              </label>
            </div>
            {s.error ? <ErrorLine>{s.error}</ErrorLine> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={aosButton({ variant: "quiet" })} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" disabled={s.busy} className={aosButton({ variant: "primary" })}>
                Add ticket type
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

export function TicketActiveToggle({ id, active }: { id: string; active: boolean }) {
  const router = useRouter();
  const s = useSubmit();
  return (
    <button
      type="button"
      className={aosButton({ variant: "quiet", size: "xs" })}
      disabled={s.busy}
      title={s.error ?? undefined}
      onClick={() => void s.run(() => jsonPost("/api/ops/event-ticket-types", { id, active: !active }, "PATCH"), () => router.refresh())}
    >
      {active ? "Stop selling" : "Sell again"}
    </button>
  );
}

export function AddRegistrationButton({ tickets }: { tickets: Array<{ id: string; name: string; priceCents: number }> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ ticketTypeId: tickets[0]?.id ?? "", name: "", email: "", quantity: "1", comp: false });
  const s = useSubmit();
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const paid = (tickets.find((t) => t.id === f.ticketTypeId)?.priceCents ?? 0) > 0;
  return (
    <>
      <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => setOpen(true)} disabled={!tickets.length}>
        <Plus size={16} aria-hidden /> Add registration
      </button>
      {open ? (
        <Dialog title="Register someone" onClose={() => !s.busy && setOpen(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void s.run(
                () =>
                  jsonPost("/api/ops/event-registrations", {
                    ticketTypeId: f.ticketTypeId,
                    name: f.name.trim(),
                    email: f.email.trim(),
                    quantity: Number(f.quantity) || 1,
                    comp: paid && f.comp,
                  }),
                () => {
                  setOpen(false);
                  router.refresh();
                },
              );
            }}
            className="flex flex-col gap-4"
          >
            <label>
              <span className={labelCls}>Ticket type</span>
              <select className={inputCls} value={f.ticketTypeId} onChange={(e) => set({ ticketTypeId: e.target.value })}>
                {tickets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.priceCents > 0 ? " (paid)" : " (free)"}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-[1fr_1fr_90px] gap-3">
              <label>
                <span className={labelCls}>Name</span>
                <input className={inputCls} value={f.name} onChange={(e) => set({ name: e.target.value })} required />
              </label>
              <label>
                <span className={labelCls}>Email</span>
                <input type="email" className={inputCls} value={f.email} onChange={(e) => set({ email: e.target.value })} required />
              </label>
              <label>
                <span className={labelCls}>Seats</span>
                <input className={inputCls} inputMode="numeric" value={f.quantity} onChange={(e) => set({ quantity: e.target.value })} />
              </label>
            </div>
            {paid ? (
              <label className="flex items-center gap-2 text-md">
                <input type="checkbox" checked={f.comp} onChange={(e) => set({ comp: e.target.checked })} />
                Complimentary — no charge (paid seats are otherwise bought on the public page)
              </label>
            ) : null}
            {s.error ? <ErrorLine>{s.error}</ErrorLine> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={aosButton({ variant: "quiet" })} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" disabled={s.busy || (paid && !f.comp)} className={aosButton({ variant: "primary" })}>
                Register
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

export function CancelRegistrationButton({ id, label, paid }: { id: string; label: string; paid: boolean }) {
  const router = useRouter();
  const s = useSubmit();
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={aosButton({ variant: "quiet", size: "xs" })}
        disabled={s.busy}
        onClick={async () => {
          const ok = await confirmAction({
            title: `Cancel ${label}?`,
            description: `The seats are released and its tickets stop working.${paid ? " The refund is yours to issue in Stripe." : ""}`,
            confirmLabel: "Cancel registration",
            cancelLabel: "Keep it",
            destructive: true,
          });
          if (!ok) return;
          void s.run(() => jsonPost("/api/ops/event-registrations", { id, status: "cancelled" }, "PATCH"), () => router.refresh());
        }}
      >
        Cancel
      </button>
      {s.error ? <span className="text-sm text-failed-text">{s.error}</span> : null}
    </span>
  );
}
