// ShapesOS — Phase 19A (WS=server): English strings for Settings → You →
// Cursor (ShapesOS Desktop's agentic cursor). Spread into en.ts as the
// top-level `cursor` block. Sentence case, the ICU subset in lib/i18n/icu.ts.

export const cursorEn = {
  cursor: {
    title: "Cursor",
    subtitle: "The voice cursor in ShapesOS Desktop: hold a key, talk, and it points at what to click.",
    voice: {
      title: "Voice",
      help: "The voice the cursor answers in. The list comes from the voice service this server uses.",
      label: "Cursor voice",
      default: "Default voice",
      loading: "Loading voices",
      saved: "Voice saved",
      saveFailed: "Couldn't save the voice",
      notConfigured: "Spoken answers are not set up on this server yet. The cursor shows its answers as text.",
      listFailed: "The voice list couldn't be read. Try again in a moment.",
      mock: "Test voice (silent): this server runs with test providers.",
      provider: "Voice service: {name}",
    },
    talk: {
      title: "Talk minutes",
      help: "Each started minute you hold the talk key counts. Minutes past your plan's included ones use credits.",
      used: "{used, plural, one {# minute used} other {# minutes used}} this month",
      included: "{included, plural, one {# minute included} other {# minutes included}}",
      unlimited: "Unlimited on a self-hosted server",
      usage: "See credits in Usage",
    },
    providers: {
      title: "What the cursor uses",
      speechIn: "Speech in",
      speechOut: "Speech out",
      brain: "Seeing and answering",
      ready: "Ready",
      notSet: "Not set up",
      test: "Test provider",
    },
    desktop: {
      title: "ShapesOS Desktop",
      body: "The cursor lives in the desktop app for Mac and Windows. It sees your screen only while you hold the talk key, and never stores screenshots.",
      download: "Download ShapesOS Desktop",
    },
    safety: "Money and irreversible actions are never approved by voice: you click Approve on the card.",
  },
} as const;
