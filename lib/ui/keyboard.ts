// ShapesOS — keyboard helpers for elements that can't be a <button>
// (clickable table rows, drag cards, modal backdrops).

import type { KeyboardEvent } from "react";

/**
 * onKeyDown for a clickable non-button element (e.g. a table row): Enter or
 * Space runs `fn`, like a button. Ignores keys that bubble up from inner
 * controls (inputs, buttons, links) so they keep their own behavior.
 */
export function activateOnKey(fn: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

/** onKeyDown for a modal overlay: Escape (from anywhere inside) closes it. */
export function closeOnEscape(fn: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      fn();
    }
  };
}

/** onClick for a modal overlay: only a click on the backdrop itself closes. */
export function closeOnBackdrop(fn: () => void) {
  return (e: { target: EventTarget; currentTarget: EventTarget }) => {
    if (e.target === e.currentTarget) fn();
  };
}
