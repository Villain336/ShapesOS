# Agentic OS design system

Read this before building or changing any UI. Values live in `tokens.css` (plain CSS variables) and `tailwind.css` (Tailwind v4 theme). Use tokens, never raw hex values or Tailwind's default palette.

## Setup

1. Load the fonts in the document head:
   ```html
   <link rel="preconnect" href="https://fonts.googleapis.com">
   <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
   <link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
   ```
   With Next.js, load Archivo through `next/font/google` with `axes: ["wdth"]` so the width axis survives.
2. Tailwind v4: make `tailwind.css` the main stylesheet. Anything else: import `tokens.css` once, globally.
3. The app background is `canvas` (#F3F3F1), not white. White (`paper`) is for things that sit on it.

## The one rule: color means status

Red, blue, yellow and green each mean exactly one agent state, and each state has its own shape. Color never appears without its shape, so the UI still works for people who can't tell red from green.

| State | Color token | Shape | Text on fill | Motion |
|---|---|---|---|---|
| Running | `running` #2450E0 | Circle | White | Shape pulses while live |
| Needs you | `needs` #F7C21B | Triangle | **Black, always** | None |
| Done | `done` #0F7F45 | Quarter-disc (corner bottom-left) | White | None |
| Failed | `failed` #D92D20 | Square | White | None |
| Queued | `ink` | Outline circle | n/a | None |
| Paused | `ink` | Two vertical bars | n/a | None |

On black surfaces (sidebar, toasts) use the brighter `*-night` variants for marks and text.

Do not use these four colors for anything else: not brand accents, categories, charts of unrelated data, agent identity, avatars, illustrations or decoration. The single exception is blue for keyboard focus rings and link hover. Agents are identified by black letter tiles (white letter, `radius-sm`), never by color.

Primary actions are **black**, not blue. A colored button means the action changes that state:

| Action | Fill |
|---|---|
| Run, Resume | `running` |
| Review (an approval) | `needs`, black text |
| Approve, Approve and send | `done` |
| Stop run | `failed` |
| Deny, Delete | White with `failed-text` label and a 1.5px `failed` inset ring |

## Status shapes

Use the CSS classes (`aos-shape aos-shape--running`, add `aos-is-live` to pulse) or these SVG paths, all on a `0 0 14 14` viewBox:

```
running  M0 7a7 7 0 1 0 14 0a7 7 0 1 0-14 0z
needs    M7 0.8 13.6 13.2H0.4z
done     M1 13V1a12 12 0 0 1 12 12z
failed   M1 1h12v12H1z
queued   <circle cx="7" cy="7" r="5.6" fill="none" stroke-width="2.4"/>
paused   M4 1.5v11M10 1.5v11  (stroke-width 2.8, no fill)
```

A yellow triangle sitting directly on white or canvas needs a 1px black edge (`aos-shape--edged`, or `stroke="#000"` on the SVG). Inside a filled badge the shape takes the badge's text color: white circle on blue, black triangle on yellow.

## Shape language

Round things you press, square-ish things that hold.

- **Pills** (`rounded-full`): buttons, icon buttons, chips, badges, toggles, segmented controls, switches, the send button.
- **Containers** use the radius scale by size: `key` 6px for keycaps, `sm` 8px for list rows and nav items, `md` 10px for inputs and tool-call blocks, `lg` 14px for cards, menus, popovers and the command palette, `xl` 18px for the composer.

Never put a pill radius on a container or a square corner on a button.

## Typography

Archivo for everything; JetBrains Mono only for tool calls, code, IDs, file paths and keycaps.

| Role | Size | Weight | Width (font-stretch) | Tracking |
|---|---|---|---|---|
| Display | 32–40px | 800 | 125% | -0.02em |
| Page heading | 24px | 750 | 115% | -0.01em |
| Section heading | 18px | 750 | 115% | -0.01em |
| Body, buttons, rows | 15px | 500–600 | 100% | 0 |
| Secondary body | 14px | 400–500 | 100% | 0 |
| Badges, chips, helper | 13px | 600 | 100% | 0 |
| Captions, group labels | 12px | 600 | 100% | 0 |

Headings get **wider**, not just bolder; that width is the brand's signature. Sentence case everywhere. No all-caps labels, no eyebrow text above headings.

## Components

**Buttons.** Heights 36 / 44 / 52 (`h-control-sm` / `h-control` / `h-control-lg`); 44 is the default. Horizontal padding 16 / 22 / 26. Label 15px, weight 600. Secondary: white with a 1.5px black inset ring (`shadow-outline`). Quiet: transparent, `hover` background on hover. Disabled: `disabled` background, `disabled-fg` text. Hover lifts 1px, press scales to 0.97 (`aos-press`). Loading keeps the width, swaps the label to the present participle ("Starting") and shows a spinner.

**Status badges.** 28px tall, pill, filled with the status color, 10px shape before the label, 13px/600. Queued is white with a 1.5px black ring. Paused is `line` gray.

**Chips and tool toggles.** 32px pill, white with `shadow-control`; black ring on hover. Pressed (`aria-pressed="true"`) is solid black with white text.

**Inputs.** 44px, `radius-md`, 1.5px `control` border, white. Focus: `focus` border plus a 3px `focus-halo`. Error: `failed` border, message below in `failed-text` led by a small red square, and `aria-invalid` plus `aria-describedby` on the field. Helper text 13px `muted`.

**Cards.** White, `radius-lg`, `shadow-hairline`. Agent cards carry a status-colored header band with the large cropped status shape.

**Menus, popovers, palette.** White, `radius-lg`. Menus use `shadow-raised`; the command palette and dialogs use `shadow-overlay`. Rows are 44px, `radius-sm`; the active row is solid black with white text. Destructive rows use `failed-text` and a `failed-tint` hover.

**Sidebar.** Black (`aos-night`), 288px expanded, 80px collapsed rail. Nav items 40–44px, `radius-sm`; inactive text `night-soft`, hover `night-hover`, current page is a **white** row with black text (`aria-current="page"`). Counts sit in small pills.

**Toasts.** Black, `radius-lg`, `shadow-toast`, enter with `animate-toast-in`. Lead with the status shape in its `-night` color. Exactly one action per toast; the action's name matches the result ("Approve" becomes "Approved").

**Banners.** Full status fill with the matching text color (black on yellow), shape first, one action at the end.

**Tool-call blocks.** `radius-md`, mono 13px, tool name like `web.search` in mono, arguments below.

**Switches.** 44×26 pill track, white 20px knob. On: `ink` track. Off: #8A8A86 track. Always `role="switch"` with `aria-checked`, and a visible label to the left.

**Permission segmented control.** Pill group on #F0F0EE. Selected option takes its meaning: Ask first = `needs` with black text, Auto-run = `running`, Off = `ink`.

## Writing

- Name things the way the user thinks of them: "Tools", "Schedules", "Memory", not internal system names.
- Buttons say exactly what happens ("Approve and send", "Run Researcher"), and the result keeps the same verb ("Sent", "Approved").
- Errors say what failed and how to fix it, without apology: "Calendar access expired. Reconnect to resume."
- Empty states invite an action: "No matches for 'x'. Press ↵ to hand it to an agent as a new task."

## Accessibility floor

- Status is always color + shape + text label. Never color alone.
- Visible focus on everything interactive (2px blue outline, 2px offset; brighter blue on black).
- Minimum 44px targets for primary controls; 32px chips need 44px spacing or a larger hit area on touch.
- Respect `prefers-reduced-motion` (already handled in `tokens.css`). Pulsing stops; nothing else animates by itself.
- Contrast: white on blue 6.4:1, white on green 5.1:1, white on red 4.8:1, black on yellow 12.7:1. Never put white text on yellow or yellow text on white.

## Never

- Tailwind default colors, grays or radii (they are removed on purpose).
- Gradients, glows, glassmorphism or colored shadows.
- A fifth accent color.
- Off-black stand-ins like #111 or #0B0B0B; black is #000000.
- The status colors as decoration, even "just this once".
