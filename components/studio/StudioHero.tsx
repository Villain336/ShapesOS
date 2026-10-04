// Marketr — studio page hero (Phase 12 "embeds": flag demo).
// Wired to the `studio.compact-hero` GrowthBook flag. Off (default): the
// roomy two-line hero. On: the compact single-row treatment. This is the
// proof loop for GrowthBook — flip the flag in Settings → Experiments and
// this header changes without a deploy.

"use client";

import { useFlag } from "@/components/experiments/GrowthBookProvider";

export function StudioHero() {
  const compact = useFlag("studio.compact-hero");

  if (compact) {
    return (
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h1 className="aos-subheading text-ink">
          Creative Studio
        </h1>
        <p className="text-[13px] text-muted">
          Design, assets, and templates — one canvas.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="aos-heading text-ink">Creative Studio</h1>
      <p className="mt-0.5 text-[13px] text-muted">
        The central home for all creative and design work across ShapesOS.
        v1 ships print/mail creative plus the asset library; email and social templates plug in later.
      </p>
    </div>
  );
}
