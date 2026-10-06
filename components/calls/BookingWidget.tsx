// Marketr — public booking widget (R5).
// Rendered at /book/[token]. Fetches availability from the public API,
// submits with explicit consent. Public by design; the token IS the
// capability, rate-limited server-side.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Calendar, Check } from "lucide-react";

interface Slot { startAt: string; endAt: string }

export function BookingWidget({ token }: { token: string }) {
  const [title, setTitle] = useState("Book a time");
  const [description, setDescription] = useState<string | null>(null);
  const [durationMin, setDurationMin] = useState(30);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [day, setDay] = useState<string>("");
  const [selected, setSelected] = useState<Slot | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/calls/public/booking/${encodeURIComponent(token)}`);
      if (r.status === 404) { setNotFound(true); return; }
      const d = await r.json();
      setTitle(d.page?.title ?? "Book a time");
      setDescription(d.page?.description ?? null);
      setDurationMin(d.page?.durationMin ?? 30);
      setSlots(d.slots ?? []);
    } catch {
      setError("Could not load availability.");
    }
    setLoading(false);
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const days: { key: string; label: string; count: number }[] = [];
  for (const s of slots) {
    const k = s.startAt.slice(0, 10);
    const last = days[days.length - 1];
    if (last && last.key === k) last.count++;
    else {
      const d = new Date(s.startAt);
      days.push({
        key: k,
        label: d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
        count: 1,
      });
    }
  }
  const activeDay = day || days[0]?.key || "";
  const daySlots = slots.filter((s) => s.startAt.slice(0, 10) === activeDay);

  async function submit() {
    setError("");
    if (!selected) { setError("Pick a time slot first."); return; }
    if (!consent) { setError("Please check the reminder consent box to receive confirmation and reminder emails."); return; }
    setSubmitting(true);
    try {
      const r = await fetch(`/api/calls/public/booking/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name, email: email || undefined, phone: phone || undefined,
          startAt: selected.startAt, consent,
          notes: notes || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Booking failed");
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Booking failed");
    }
    setSubmitting(false);
  }

  const inputCls = "w-full rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-[0.875rem] text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";

  return (
    <div className="min-h-screen bg-canvas px-4 py-10">
      <div className="mx-auto w-full max-w-[560px]">
        <div className="rounded-lg bg-paper shadow-hairline p-6">
          {notFound ? (
            <div className="py-8 text-center">
              <Calendar size={28} className="mx-auto text-subtle" />
              <p className="mt-3 text-[0.9375rem] font-semibold text-ink">This booking page is no longer available.</p>
              <p className="mt-1 text-[0.8125rem] text-muted">The link may be expired or the page was disabled.</p>
            </div>
          ) : done ? (
            <div className="py-8 text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-canvas">
                <Check size={24} className="text-ink" />
              </span>
              <p className="mt-3 text-[1rem] font-semibold text-ink">You're booked, {name}.</p>
              <p className="mt-1 text-[0.8125rem] text-muted">
                A confirmation email is on its way, and you'll get reminders 24 hours and 1 hour before.
              </p>
            </div>
          ) : (
            <>
              <p className="text-[0.75rem] font-semibold text-muted">ShapesOS booking</p>
              <h1 className="mt-1 text-xl font-heading tracking-heading stretch-heading text-ink">{title}</h1>
              {description && <p className="mt-1 text-[0.8125rem] text-muted">{description}</p>}
              <p className="mt-1 text-[0.78125rem] text-muted">{durationMin} minutes</p>

              {loading ? (
                <p className="py-10 text-center text-sm text-muted">Loading availability…</p>
              ) : (
                <>
                  <div className="mt-5">
                    <p className="mb-2 text-[0.75rem] font-semibold text-muted">Pick a day</p>
                    <div className="flex flex-wrap gap-2">
                      {days.map((d) => (
                        <button
                          key={d.key}
                          onClick={() => { setDay(d.key); setSelected(null); }}
                          className={`h-chip rounded-full px-3.5 text-[0.8125rem] font-semibold transition-colors ${
                            activeDay === d.key
                              ? "bg-ink text-white"
                              : "bg-paper text-ink shadow-control hover:shadow-outline"
                          }`}
                        >
                          {d.label}
                        </button>
                      ))}
                      {days.length === 0 && <p className="text-[0.8125rem] text-muted">No availability in the next 14 days.</p>}
                    </div>
                  </div>

                  {daySlots.length > 0 && (
                    <div className="mt-4">
                      <p className="mb-2 text-[0.75rem] font-semibold text-muted">Pick a time</p>
                      <div className="grid grid-cols-3 gap-2">
                        {daySlots.map((s) => (
                          <button
                            key={s.startAt}
                            onClick={() => setSelected(s)}
                            className={`h-chip rounded-full px-2 text-[0.8125rem] font-semibold tabular-nums transition-colors ${
                              selected?.startAt === s.startAt
                                ? "bg-ink text-white"
                                : "bg-paper text-ink shadow-control hover:shadow-outline"
                            }`}
                          >
                            {new Date(s.startAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="mt-5 grid gap-3">
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className={inputCls} />
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" inputMode="email" className={inputCls} />
                      <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (optional)" inputMode="tel" className={inputCls} />
                    </div>
                    <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything we should know? (optional)" rows={2} className={inputCls} />
                    <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line bg-canvas p-3">
                      <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-4 w-4 accent-ink" />
                      <span className="text-[0.78125rem] leading-snug text-muted">
                        I agree to receive a booking confirmation and appointment reminders by email (and text if I provided a phone number). I can opt out of reminders at any time.
                      </span>
                    </label>
                  </div>

                  {error && <p className="mt-3 text-[0.8125rem] text-failed-text">{error}</p>}
                  <button
                    onClick={submit}
                    disabled={submitting || !selected || !name.trim() || (!email.trim() && !phone.trim())}
                    className="mt-4 h-control w-full rounded-full bg-ink px-4 text-[0.9375rem] font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-50"
                  >
                    {submitting ? "Booking…" : "Confirm booking"}
                  </button>
                  <p className="mt-2 text-[0.71875rem] text-muted">Email or phone is required so we can send your confirmation.</p>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
