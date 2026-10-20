"use client";

// ShapesOS — Phase 12 (people): the public registration form on
// /events/[slug]. Posts to /api/events/[slug]/register; free tickets land on
// the registration page with the QR tickets, paid tickets go to the
// organiser's Stripe Checkout (and are confirmed only by Stripe's webhook).
// When the server asks for the CAPTCHA step-up, the existing widget
// (components/security/CaptchaWidget) is shown.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CaptchaWidget, type CaptchaPublicConfig } from "@/components/security/CaptchaWidget";
import { shopBtnPrimary, shopErrorMark, shopErrorText, shopInput, shopSelect } from "@/components/store/styles";

export interface FormTicket {
  id: string;
  name: string;
  priceLabel: string;
  free: boolean;
  maxNow: number;
  stateLabel: string | null;
}

export function RegisterForm({
  slug,
  tickets,
  captcha,
  paymentsReady,
}: {
  slug: string;
  tickets: FormTicket[];
  captcha: CaptchaPublicConfig | null;
  paymentsReady: boolean;
}) {
  const router = useRouter();
  const onSale = tickets.filter((t) => t.maxNow > 0 && (t.free || paymentsReady));
  const [ticketId, setTicketId] = useState(onSale[0]?.id ?? "");
  const [quantity, setQuantity] = useState(1);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [guests, setGuests] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);
  const ticket = tickets.find((t) => t.id === ticketId);
  const max = ticket?.maxNow ?? 1;

  function setQty(n: number) {
    const q = Math.max(1, Math.min(max, n));
    setQuantity(q);
    setGuests((g) => Array.from({ length: q - 1 }, (_, i) => g[i] ?? ""));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ticket) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/events/${slug}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticketTypeId: ticket.id,
          quantity,
          name: name.trim(),
          email: email.trim(),
          attendees: [{ name: name.trim(), email: email.trim() }, ...guests.map((g) => ({ name: g.trim() }))].filter((a) => a.name),
          ...(captchaToken ? { captchaToken } : {}),
        }),
      });
      const d = (await r.json().catch(() => ({}))) as { status?: string; url?: string; viewUrl?: string; error?: string; code?: string };
      if (r.ok && d.status === "payment_required" && d.url) {
        window.location.assign(d.url);
        return;
      }
      if (r.ok && d.viewUrl) {
        router.push(d.viewUrl);
        return;
      }
      if (d.code === "captcha_required" && captcha) {
        setNeedCaptcha(true);
        setCaptchaToken(null);
        setCaptchaKey((k) => k + 1);
      }
      setError(d.error ?? "Registration didn't go through. Try again.");
    } catch {
      setError("Registration didn't go through. Check your connection and try again.");
    }
    setBusy(false);
  }

  if (onSale.length === 0) {
    return <p className="text-[0.9375rem] text-muted">{tickets.some((t) => !t.free) && !paymentsReady ? "Online payment isn't set up for this event yet." : "Registration is closed."}</p>;
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-[0.8125rem] font-semibold text-muted">Ticket</span>
        <select className={shopSelect} value={ticketId} onChange={(e) => { setTicketId(e.target.value); setQty(1); }}>
          {onSale.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {t.priceLabel}
              {t.stateLabel ? ` · ${t.stateLabel}` : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[0.8125rem] font-semibold text-muted">How many</span>
        <input className={`${shopInput} w-28`} type="number" min={1} max={max} value={quantity} onChange={(e) => setQty(Number(e.target.value) || 1)} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-[0.8125rem] font-semibold text-muted">Your name</span>
          <input className={shopInput} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[0.8125rem] font-semibold text-muted">Email</span>
          <input className={shopInput} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
      </div>
      {guests.map((g, i) => (
        <label key={i} className="flex flex-col gap-1">
          <span className="text-[0.8125rem] font-semibold text-muted">Guest {i + 2} name (optional)</span>
          <input className={shopInput} value={g} onChange={(e) => setGuests(guests.map((x, j) => (j === i ? e.target.value : x)))} />
        </label>
      ))}
      {needCaptcha && captcha ? <CaptchaWidget config={captcha} onToken={setCaptchaToken} resetKey={captchaKey} /> : null}
      {error ? (
        <p role="alert" className={shopErrorText}>
          <span aria-hidden className={shopErrorMark} />
          {error}
        </p>
      ) : null}
      <div>
        <button type="submit" className={shopBtnPrimary} disabled={busy || !ticket || (needCaptcha && !captchaToken)}>
          {busy ? "One moment" : ticket?.free ? "Register" : "Continue to payment"}
        </button>
      </div>
      {!ticket?.free ? <p className="text-[0.8125rem] text-muted">Your seats are held while you pay. Payment is processed securely by Stripe.</p> : null}
    </form>
  );
}
