// ShapesOS — inline error line: led by the small red square (DESIGN.md
// inputs/errors), text in failed-text. Pair with aria-describedby on the field.

export function FormError({ id, message }: { id?: string; message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-2 flex items-start gap-2 text-sm text-failed-text">
      <span className="aos-shape aos-shape--failed mt-[3px]" aria-hidden />
      <span>{message}</span>
    </p>
  );
}

/** Neutral confirmation line after a save (no status color: not an agent state). */
export function FormNote({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="status" className="mt-2 text-sm text-muted">
      {message}
    </p>
  );
}
