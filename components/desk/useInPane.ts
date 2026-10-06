"use client";

// ShapesOS — Phase 18.1 (WS=desk): is this page inside a split-view pane?
// The server already drops the chrome when the browser marks the request
// Sec-Fetch-Dest: iframe (app/dashboard/layout.tsx); this is the client-side
// backstop (a browser without that header, or a refresh re-rendered inside
// the pane), so the sidebar and top bar never stack inside a pane.

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

function inPaneSnapshot(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true; // a cross-origin parent: treat as embedded
  }
}

export function useInPane(): boolean {
  return useSyncExternalStore(subscribe, inPaneSnapshot, () => false);
}

/** A boolean kept in localStorage (a per-viewer convenience; never throws). */
const FLAG_EVENT = "shapes:local-flag";
export function readLocalFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
export function writeLocalFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // storage unavailable: the flag just doesn't persist
  }
  window.dispatchEvent(new Event(FLAG_EVENT));
}
export function useLocalFlag(key: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(FLAG_EVENT, cb);
      window.addEventListener("storage", cb);
      return () => {
        window.removeEventListener(FLAG_EVENT, cb);
        window.removeEventListener("storage", cb);
      };
    },
    () => readLocalFlag(key),
    () => false,
  );
}
