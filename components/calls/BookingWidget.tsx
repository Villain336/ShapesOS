// Marketr — public booking widget (R5).
// Rendered at /book/[token]. Fetches availability from the public API,
// submits with explicit consent. Public by design; the token IS the
// capability, rate-limited server-side.

"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarBlank, Check } from "@phosphor-icons/react";

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

  const inputCls = "w-full rounded-[8px] border border-stone-200 bg-white px-3 py-2 text-[14px] text-stone-900 placeholder:text-stone-400 focus:border-violet-500 focus:outline-none";

  return (
    <div className="min-h-screen bg-[#FAFAF7] px-4 py-10">
      <div className="mx-auto w-full max-w-[560px]">
        <div className="rounded-[12px] border border-stone-200 bg-white p-6 shadow-sm">
          {notFound ? (
            <div className="py-8 text-center">
              <CalendarBlank size={28} className="mx-auto text-stone-300" />
              <p className="mt-3 text-[15px] font-semibold text-stone-900">This booking page is no longer available.</p>
              <p className="mt-1 text-[13px] text-stone-500">The link may be expired or the page was disabled.</p>
            </div>
          ) : done ? (
            <div className="py-8 text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50">
                <Check size={24} className="text-emerald-600" />
              </span>
              <p className="mt-3 text-[16px] font-semibold text-stone-900">You're booked, {name}.</p>
              <p className="mt-1 text-[13px] text-stone-500">
                A confirmation email is on its way, and you'll get reminders 24 hours and 1 hour before.
              </p>
            </div>
          ) : (
            <>
              <p className="text-[12px] font-medium text-violet-700">Marketr booking</p>
              <h1 className="mt-1 text-[20px] font-semibold tracking-tight text-stone-900">{title}</h1>
              {description && <p className="mt-1 text-[13px] text-stone-500">{description}</p>}
              <p className="mt-1 text-[12.5px] text-stone-400">{durationMin} minutes</p>

              {loading ? (
                <p className="py-10 text-center text-sm text-stone-500">Loading availability…</p>
              ) : (
                <>
                  <div className="mt-5">
                    <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-stone-500">Pick a day</p>
                    <div className="flex flex-wrap gap-2">
                      {days.map((d) => (
                        <button
                          key={d.key}
                          onClick={() => { setDay(d.key); setSelected(null); }}
                          className={`rounded-[8px] border px-3 py-2 text-[13px] font-medium transition-colors ${
                            activeDay === d.key
                              ? "border-violet-600 bg-violet-50 text-violet-800"
                              : "border-stone-200 bg-white text-stone-700 hover:border-stone-300"
                          }`}
                        >
                          {d.label}
                        </button>
                      ))}
                      {days.length === 0 && <p className="text-[13px] text-stone-500">No availability in the next 14 days.</p>}
                    </div>
                  </div>

                  {daySlots.length > 0 && (
                    <div className="mt-4">
                      <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-stone-500">Pick a time</p>
                      <div className="grid grid-cols-3 gap-2">
                        {daySlots.map((s) => (
                          <button
                            key={s.startAt}
                            onClick={() => setSelected(s)}
                            className={`rounded-[8px] border px-2 py-2 text-[13px] font-medium tabular-nums transition-colors ${
                              selected?.startAt === s.startAt
                                ? "border-violet-600 bg-violet-600 text-white"
                                : "border-stone-200 bg-white text-stone-700 hover:border-stone-300"
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
                    <label className="flex cursor-pointer items-start gap-2.5 rounded-[8px] border border-stone-200 bg-stone-50 p-3">
                      <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-4 w-4 accent-violet-600" />
                      <span className="text-[12.5px] leading-snug text-stone-600">
                        I agree to receive a booking confirmation and appointment reminders by email (and text if I provided a phone number). I can opt out of reminders at any time.
                      </span>
                    </label>
                  </div>

                  {error && <p className="mt-3 text-[13px] text-red-600">{error}</p>}
                  <button
                    onClick={submit}
                    disabled={submitting || !selected || !name.trim() || (!email.trim() && !phone.trim())}
                    className="mt-4 w-full rounded-[8px] bg-violet-600 px-4 py-2.5 text-[14px] font-medium text-white transition-colors hover:bg-violet-700 disabled:opacity-50"
                  >
                    {submitting ? "Booking…" : "Confirm booking"}
                  </button>
                  <p className="mt-2 text-[11.5px] text-stone-400">Email or phone is required so we can send your confirmation.</p>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
