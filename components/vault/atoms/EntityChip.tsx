export function Monogram({
  children,
  // Identity is never color-coded: a black letter tile by default. A caller's
  // explicit color (e.g. a stored brand value) still wins.
  color = "var(--aos-ink)",
  className = "",
}: {
  children: React.ReactNode;
  color?: string;
  className?: string;
}) {
  return (
    <span
      className={`flex size-4 shrink-0 items-center justify-center rounded-key
        text-[0.5625rem] font-semibold leading-none text-white ${className}`}
      style={{ background: color }}
    >
      {children}
    </span>
  );
}

/** Inline entity reference — a monogram + name in a soft field pill.
 *  Names a supplier, person, or record inside running text. Softer than a
 *  StatusPill (no dot, no state) and not a mono token (see Chip). */
export function EntityChip({
  name,
  color,
  monogram,
  className = "",
}: {
  name: string;
  color?: string;
  monogram?: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`mx-0.5 inline-flex items-center gap-1 rounded-full bg-paper
        py-px pl-[3px] pr-1.5 align-middle shadow-hairline ${className}`}
    >
      <Monogram color={color}>{monogram ?? name.charAt(0)}</Monogram>
      <span className="text-[0.75rem] font-medium text-ink">{name}</span>
    </span>
  );
}
