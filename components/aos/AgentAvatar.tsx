// ShapesOS — agent identity atoms. Agents are identified by a black monogram
// tile (white letter), never by color (DESIGN.md "Agents: one lead, many
// sub-agents"). Counts and keycaps live here too.

import { monogram } from "@/lib/aos/agents";
import { cn } from "@/lib/utils";

const TILE: Record<"xs" | "sm" | "md" | "lg", string> = {
  xs: "size-5 rounded-key text-2xs",
  sm: "size-6 rounded-key text-xs",
  md: "size-8 rounded-key text-sm",
  lg: "size-10 rounded-key text-base",
};

export function AgentAvatar({
  name,
  size = "md",
  tone = "ink",
  className,
}: {
  name: string;
  size?: keyof typeof TILE;
  /** "ink" = black tile, white letter; "paper" = white tile (on black surfaces). */
  tone?: "ink" | "paper";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-extrabold leading-none stretch-heading",
        tone === "ink" ? "bg-ink text-paper" : "bg-paper text-ink",
        TILE[size],
        className,
      )}
    >
      {monogram(name)}
    </span>
  );
}

/** Overlapping tiles ("R W A O +3"), each ringed in the surface color. */
export function AvatarStack({
  names,
  max = 4,
  size = "md",
  className,
}: {
  names: string[];
  max?: number;
  size?: keyof typeof TILE;
  className?: string;
}) {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return (
    <span className={cn("inline-flex items-center", className)} aria-label={names.join(", ")} role="img">
      {shown.map((n, i) => (
        <AgentAvatar key={`${n}-${i}`} name={n} size={size} className={cn("ring-2 ring-canvas", i > 0 && "-ml-1.5")} />
      ))}
      {rest > 0 ? (
        <span
          aria-hidden
          className={cn(
            "-ml-1.5 inline-flex shrink-0 items-center justify-center bg-paper font-semibold text-ink shadow-control ring-2 ring-canvas",
            TILE[size],
            "text-xs",
          )}
        >
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

/** Small round count. Tone follows meaning: needs = waiting on you, running = live, ink = plain. */
export function CountBadge({
  count,
  tone = "ink",
  label,
  className,
}: {
  count: number;
  tone?: "needs" | "running" | "ink" | "paper";
  /** Accessible meaning, e.g. "3 approvals waiting". */
  label?: string;
  className?: string;
}) {
  const text = count > 99 ? "99+" : String(count);
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums leading-none",
        tone === "needs" && "bg-needs text-ink",
        tone === "running" && "bg-running text-paper",
        tone === "ink" && "bg-ink text-paper",
        tone === "paper" && "bg-paper text-ink",
        className,
      )}
      {...(label ? { role: "img", "aria-label": label, title: label } : {})}
    >
      {text}
    </span>
  );
}

/** Keycap: JetBrains Mono, key radius, inset bottom edge. */
export function KeyCap({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "aos-mono inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-key bg-paper px-1.5 text-2xs font-medium text-muted shadow-key",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/**
 * A shortcut as keycaps: ["⌘", "N"], ["G", "I"] (a sequence), ["⌥", "1"].
 * The combo is announced once ("Shortcut ⌘ N"); the caps themselves are hidden.
 */
export function KeyCaps({ keys, className }: { keys: readonly string[]; className?: string }) {
  if (keys.length === 0) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)} role="img" aria-label={`Shortcut ${keys.join(" ")}`}>
      {keys.map((k, i) => (
        <KeyCap key={`${k}-${i}`}>{k}</KeyCap>
      ))}
    </span>
  );
}
