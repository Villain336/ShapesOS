// ShapesOS mobile — Agentic OS design tokens for React Native.
//
// Mirrors docs/design/tokens.css (the web app's single source of truth).
// Screens use these names, never raw hex: black primary actions, canvas
// background, white surfaces, and the four status colors for agent states
// only (running / needs you / done / failed) — never decoration.

export const color = {
  ink: "#000000",
  paper: "#FFFFFF",
  canvas: "#F3F3F1",
  line: "#E2E2DF",
  lineStrong: "#D6D6D2",
  control: "#CFCFCB",
  hover: "#E6E6E3",
  muted: "#5E5E5B",
  subtle: "#76766F",
  disabledBg: "#E2E2DF",
  disabledFg: "#8A8A86",
  running: "#2450E0",
  runningTint: "#EAF0FF",
  needs: "#F7C21B",
  needsTint: "#FFF6D6",
  done: "#0F7F45",
  failed: "#D92D20",
  failedText: "#C42A1E",
  failedTint: "#FCECEA",
  nightText: "#FFFFFF",
  nightSoft: "#BDBDB8",
  focus: "#2450E0",
} as const;

export const radius = { sm: 8, md: 10, lg: 14, xl: 18, pill: 999 } as const;

export const font = { xs: 12, sm: 13, md: 14, base: 15, lg: 18, xl: 24 } as const;

/** Minimum touch target for primary controls (Agentic OS accessibility floor). */
export const CONTROL_HEIGHT = 44;
