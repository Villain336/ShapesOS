// ShapesOS — logo mark: the 2×2 of status shapes, exported from the owner's
// Figma file (component 5:7, public/brand/logo-mark.svg). "Scale
// proportionally; never recolor" — so it is the asset itself, never redrawn.

import { cn } from "@/lib/utils";

export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static brand SVG, scaled proportionally
    <img
      src="/brand/logo-mark.svg"
      width={size}
      height={size}
      alt=""
      aria-hidden
      draggable={false}
      className={cn("shrink-0 select-none", className)}
    />
  );
}

/** Mark + "ShapesOS" wordmark (wide, extra bold) as in the kit header. */
export function Wordmark({
  size = 28,
  tone = "paper",
  className,
}: {
  size?: number;
  tone?: "paper" | "night";
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark size={size} />
      <span
        className={cn(
          "font-extrabold stretch-display tracking-heading",
          tone === "night" ? "text-paper" : "text-ink",
        )}
        style={{ fontSize: Math.round(size * 0.86), lineHeight: 1 }}
      >
        ShapesOS
      </span>
    </span>
  );
}

export default LogoMark;
