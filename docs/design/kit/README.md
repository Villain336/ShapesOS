# Agentic OS UI kit — reference screenshots

These are the owner's reference renders of the Agentic OS UI kit (2026-10-04). The
app's components in `components/aos/` must match them; `docs/design/DESIGN.md` is the
written spec. Pages:

- `foundations.png` — logo mark, the four status colors + shapes (agent states only),
  neutrals, status badges, tool chips, agent avatars/counts/keycaps, type scale, tool output.
- `agent-blocks.png` — agent cards (status header band + large cropped shape), run
  timeline with tool-call block, approval card (yellow header, Deny / Edit / Approve and send).
- `toasts-and-banners.png` — live activity pill + run strip, full-fill status banners,
  black toasts led by the status shape, undo toast.
- `sidebar-and-menus.png` — black sidebar (logo, New task pill + search, nav with white
  current row, inbox count, Running now list with shapes, usage meter, user), collapsed
  rail with tooltip, workspace switcher, agent context menu.
- `command-and-inputs.png` — command palette (agents with status at right, actions with
  keycaps, tools with connection state), composer, tool permissions segmented control,
  run-setting switches, text fields with helper / error.

## Figma source of truth

Owner's Figma file "Agentic OS design system" (file key `cruEtQKYZb5v1WrGexwQq6`):

- `0:1` Cover — logo mark + the four status shapes.
- `2:82` Foundations — logo mark component (`5:7`), status colors, neutrals + night
  palette, type styles (Display/Large 40/800, Display/Default 32/800, Heading/Page 24/700,
  Heading/Section 18/700, Body/Strong 15/600, Body/Default 15/400, Body/Small 14/400,
  Label/Default 13/600, Label/Helper 13/400, Caption/Default 12/600, Mono/Code 13/400,
  Mono/Key 12/500), radii (pill, key 6, sm 8, md 10, lg 14, xl 18) and elevation
  (Hairline, Raised, Overlay, Toast).

`docs/design/tokens.css` matches the Figma foundations value-for-value (checked
2026-10-04). Assets exported from Figma live in `public/brand/` (`logo-mark.svg` — "Scale
proportionally; never recolor" — and the four 160px foundation shapes). The kit's
composite components (agent cards, banners, sidebar, approval card, palette, permissions)
are not in the Figma file yet; the screenshots above are their reference.
