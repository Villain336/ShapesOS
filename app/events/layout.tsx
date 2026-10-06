// ShapesOS — Phase 12 (people): public event pages shell (/events/*).
// PUBLIC, unauthenticated: an event page renders only for a PUBLISHED event
// (lib/ops/events/catalog.ts resolvePublishedEvent → notFound otherwise);
// registration and ticket pages are reached by signed links. Agentic OS
// tokens on the canvas background; no app chrome.

export default function EventsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-10">{children}</main>
      <footer className="border-t border-line bg-paper">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 px-5 py-4 text-[0.8125rem] text-muted">
          <span>Registration by ShapesOS</span>
          <span>Payments are processed securely by Stripe.</span>
        </div>
      </footer>
    </div>
  );
}
