// Marketr — Funding/VC slice 1: network view (client).
// The tenant's funding graph with Boardy as the FIRST card in the deck —
// the preloaded starter contact — plus intro requests. Agentic OS design
// system: canvas bg, white paper cards, black pill primary actions, Lucide
// icons only, tokens only. Boardy is an AI agent: black letter tile with a
// white "B" (never a status color).

"use client";

import { Handshake, Loader2, Mail, Sparkles, Users } from "lucide-react";

export interface ContactView {
  id: string;
  name: string;
  role: string | null;
  handle: string | null;
  note: string | null;
  source: string;
  isStarterContact: boolean;
}

export interface IntroRequestView {
  id: string;
  status: string;
  reason: string;
  founderAsk: string;
  requestedAt: string;
  contactName: string;
  investorName: string;
}

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  pending_approval: "Pending approval",
  approved: "Approved",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
};

function ContactCard({ contact }: { contact: ContactView }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline">
      <div className="flex items-center gap-3">
        {/* Agent identity: black letter tile, white letter. */}
        <span
          aria-hidden
          className="flex h-10 w-10 items-center justify-center rounded-sm bg-black text-lg font-bold text-white"
        >
          {contact.name.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-ink">{contact.name}</span>
            {contact.isStarterContact && (
              <span className="inline-flex items-center gap-1 rounded-full bg-black px-2 py-0.5 text-[11px] font-semibold text-white">
                <Sparkles size={11} />
                Starter contact
              </span>
            )}
          </div>
          {contact.role && <div className="text-[13px] text-muted">{contact.role}</div>}
        </div>
      </div>
      {contact.handle && (
        <div className="flex items-center gap-1.5 text-[13px] text-muted">
          <Mail size={13} />
          <span className="font-mono">{contact.handle}</span>
        </div>
      )}
      {contact.note && <p className="text-[13px] text-muted">{contact.note}</p>}
    </div>
  );
}

export function NetworkView({
  contacts,
  introRequests,
  loading,
}: {
  contacts: ContactView[];
  introRequests: IntroRequestView[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" />
        Loading your network
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section aria-label="Your network">
        <div className="mb-2 flex items-center gap-2">
          <Users size={15} className="text-ink" />
          <h2 className="text-[18px] font-bold text-ink" style={{ fontStretch: "115%" }}>
            Your network
          </h2>
        </div>
        <p className="mb-3 text-[13px] text-muted">
          Boardy is preloaded as your first contact — your starter network. His
          job is to help you grow this graph through warm intros matched to
          your target investor profile. There is no programmatic Boardy API;
          intros run as an email flow under his double-opt-in norms.
        </p>
        {contacts.length === 0 ? (
          <div className="rounded-lg bg-paper p-6 text-center text-sm text-muted shadow-hairline">
            No contacts yet.
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {contacts.map((c) => (
              <ContactCard key={c.id} contact={c} />
            ))}
          </div>
        )}
      </section>

      <section aria-label="Intro requests">
        <div className="mb-2 flex items-center gap-2">
          <Handshake size={15} className="text-ink" />
          <h2 className="text-[18px] font-bold text-ink" style={{ fontStretch: "115%" }}>
            Intro requests
          </h2>
        </div>
        <p className="mb-3 text-[13px] text-muted">
          Intro requests are rate-limited and context-rich — one per contact and
          investor pair, no spray-and-pray. Boardy&rsquo;s reputation is the
          asset; this feature protects it.
        </p>
        {introRequests.length === 0 ? (
          <div className="rounded-lg bg-paper p-6 text-center text-sm text-muted shadow-hairline">
            No intro requests yet. Set your target investor profile under
            Raise, then request intros matched to it.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {introRequests.map((r) => (
              <div
                key={r.id}
                className="flex flex-col gap-1 rounded-lg bg-paper p-3 shadow-hairline md:flex-row md:items-center md:justify-between"
              >
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold text-ink">
                    {r.contactName} → {r.investorName}
                  </div>
                  <div className="truncate text-[13px] text-muted">{r.reason}</div>
                </div>
                <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-paper px-2.5 py-1 text-[12px] font-semibold text-muted shadow-control">
                  {STATUS_LABELS[r.status] ?? r.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
