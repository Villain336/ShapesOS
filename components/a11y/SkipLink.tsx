// ShapesOS — Phase 18.1 (WS=find): the skip link (WCAG 2.4.1 bypass blocks).
// The first focusable element on every dashboard page: hidden until it gets
// keyboard focus, then a black pill at the top-left that jumps past the
// sidebar and top bar to <main id="main-content"> (components/DashboardMain).

export const MAIN_CONTENT_ID = "main-content";

export function SkipLink({ label, target = MAIN_CONTENT_ID }: { label: string; target?: string }) {
  return (
    <a
      href={`#${target}`}
      className="sr-only rounded-full bg-ink px-4 py-2.5 text-base font-semibold text-paper shadow-raised focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100]"
    >
      {label}
    </a>
  );
}
