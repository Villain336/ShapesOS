# THIRD_PARTY — dependency license audit (SBOM)

**Audit date:** 2026-09-25 (Phase 7, F6 launch-readiness)
**Method:** every direct dependency's `package.json` license field, plus a full
`node_modules` sweep for GPL/AGPL/proprietary/commercial license strings.
**Verdict: no blockers.** No GPL/AGPL/proprietary dependency poisons the
AGPLv3 + commercial dual-license story.

## Flags (non-blocking)

1. **`ssh2@^1.17.0` — missing `license` field in its package.json.** Its bundled
   `LICENSE` file is the MIT license text ("Copyright Brian White… Permission is
   hereby granted, free of charge…"). Treated as MIT; the missing field is an
   upstream packaging nit, not a license risk. Re-check on major upgrades.
2. **`sharp` native binaries (transitive) — LGPL-3.0-or-later**
   (`@img/sharp-libvips-linux-x64`, `-linuxmusl-x64`, `@img/sharp-wasm32`
   Apache-2.0 AND LGPL-3.0-or-later AND MIT). These are dynamically-linked native
   image-processing libraries. LGPL-3.0 §3 permits linking with GPLv3-family
   programs, so they are compatible with AGPLv3 Marketr — but they are the only
   copyleft-adjacent artifacts in the tree, so they stay on the watch list.
3. **GrowthBook stats core (Phase 7, F3):** must be the MIT OSS core only. Nothing
   under GrowthBook's `packages/enterprise` (visual editor, packaged CUPED, SSO)
   may enter the tree — license-forbidden, permanently (SPEC-PHASE7 §9.14).

## Direct dependencies (83)

| Package | Version range | License |
|---|---|---|
| @anthropic-ai/sdk | ^0.128.0 | MIT |
| @base-ui/react | ^1.8.0 | MIT |
| @floating-ui/dom | ^1.8.0 | MIT |
| @fontsource/inter | ^5.3.0 | OFL-1.1 |
| @fontsource/newsreader | ^5.3.0 | OFL-1.1 |
| @lob/lob-typescript-sdk | ^1.3.5 | MIT |
| @modelcontextprotocol/sdk | ^1.30.0 | MIT |
| @monaco-editor/react | ^4.7.0 | MIT |
| @phosphor-icons/react | ^2.1.10 | MIT |
| @playwright/test | ^1.63.0 | Apache-2.0 |
| @prisma/client | ^6.19.3 | Apache-2.0 |
| @react-email/components | ^1.0.12 | MIT |
| @shadcn/react | ^0.3.1 | MIT |
| @tailwindcss/postcss | ^4 | MIT |
| @takumi-rs/helpers | ^2.14.0 | (MIT OR Apache-2.0) |
| @tiptap/core | ^3.31.3 | MIT |
| @tiptap/extension-code-block-lowlight | ^3.31.3 | MIT |
| @tiptap/extension-collaboration | ^3.31.3 | MIT |
| @tiptap/extension-color | ^3.31.3 | MIT |
| @tiptap/extension-drag-handle | ^3.31.3 | MIT |
| @tiptap/extension-drag-handle-react | ^3.31.3 | MIT |
| @tiptap/extension-highlight | ^3.31.3 | MIT |
| @tiptap/extension-image | ^3.31.3 | MIT |
| @tiptap/extension-link | ^3.31.3 | MIT |
| @tiptap/extension-node-range | ^3.31.3 | MIT |
| @tiptap/extension-placeholder | ^3.31.3 | MIT |
| @tiptap/extension-table | ^3.31.3 | MIT |
| @tiptap/extension-table-cell | ^3.31.3 | MIT |
| @tiptap/extension-table-header | ^3.31.3 | MIT |
| @tiptap/extension-table-row | ^3.31.3 | MIT |
| @tiptap/extension-task-item | ^3.31.3 | MIT |
| @tiptap/extension-task-list | ^3.31.3 | MIT |
| @tiptap/extension-text-align | ^3.31.3 | MIT |
| @tiptap/extension-text-style | ^3.31.3 | MIT |
| @tiptap/extension-underline | ^3.31.3 | MIT |
| @tiptap/pm | ^3.31.3 | MIT |
| @tiptap/react | ^3.31.3 | MIT |
| @tiptap/starter-kit | ^3.31.3 | MIT |
| @tiptap/suggestion | ^3.31.3 | MIT |
| @tiptap/y-tiptap | ^3.0.9 | MIT |
| @types/adm-zip | ^0.5.8 | MIT |
| @types/node | ^20 | MIT |
| @types/nodemailer | ^8.0.2 | MIT |
| @types/qrcode | ^1.5.6 | MIT |
| @types/react | ^19 | MIT |
| @types/react-dom | ^19 | MIT |
| @types/ssh2 | ^1.15.6 | MIT |
| @xyflow/react | ^12.11.6 | MIT |
| adm-zip | ^0.6.1 | MIT |
| class-variance-authority | ^0.7.1 | Apache-2.0 |
| clsx | ^2.1.1 | MIT |
| cn | ^0.4.0 | MIT |
| diff | ^9.0.0 | BSD-3-Clause |
| dotenv | ^18.0.1 | BSD-2-Clause |
| eslint | ^9 | MIT |
| eslint-config-next | 16.3.5 | MIT |
| glimm | ^0.3.1 | MIT |
| jsqr | ^1.4.0 | Apache-2.0 |
| liveline | ^0.0.7 | MIT |
| lowlight | ^3.3.0 | MIT |
| lucide-react | ^1.48.0 | ISC |
| motion | ^13.4.0 | MIT |
| next | 16.3.5 | MIT |
| next-auth | ^5.0.0-beta.32 | ISC |
| nodemailer | ^10.0.10 | MIT-0 |
| postgrid-node-client | ^0.11.0 | MIT |
| prisma | ^6.19.3 | Apache-2.0 |
| qrcode | ^1.5.4 | MIT |
| radix-ui | ^1.6.7 | MIT |
| react | 19.2.8 | MIT |
| react-dom | 19.2.8 | MIT |
| react-email | ^6.9.5 | MIT |
| resend | ^6.28.1 | MIT |
| ssh2 | ^1.17.0 | (no license field) |
| stripe | ^22.6.2 | MIT |
| tailwind-merge | ^3.7.0 | MIT |
| tailwindcss | ^4 | MIT |
| takumi-pdf | ^0.15.0 | (MIT OR Apache-2.0) |
| tsx | ^4.23.15 | MIT |
| typescript | ^5 | Apache-2.0 |
| y-protocols | ^1.0.7 | MIT |
| yjs | ^13.6.32 | MIT |
| zod | ^4.6.5 | MIT |
---

Regenerate: run the license-sweep snippet from the F6 audit notes against `package.json` + `node_modules`.
