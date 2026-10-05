# ShapesOS — mobile app (iOS + Android)

Expo (React Native) companion app for ShapesOS: agent chat, native approvals,
missions, settings and push notifications.

**One agent, every frontend.** This app contains no mobile agent logic. It talks
to the SAME backend as the web app:

| Surface | Backend | Contract |
|---|---|---|
| Agent chat | `POST /api/agents/chat` (SSE, AG-UI events) | Phase 16 slice 1 |
| Approval HITL (approve/deny/edit) | `/api/autopilot/items/[id]`, `/approve`, `/reject`, `/edit` | Phase 14 gate |
| Approval queue list | `GET /api/autopilot/queue` | milestone 18 |
| Mission progress widget | CoAgents `mission` state over the AG-UI stream, `GET /api/missions` fallback | Phase 16 slice 4 |
| Push device registration | `GET/POST/PATCH/DELETE /api/mobile/push-devices` | Phase 4b |
| Server check | `GET /api/health/live` | Phase 4a |

The agent wiring mirrors the web shell (`components/agents/MarketrAgentShell.tsx`):
an `HttpAgent` from `@ag-ui/client` whose custom `fetch` rewrites the AG-UI
`RunAgentInput` into the route's `{ threadId, content, state? }` body
(`src/api/agui-bridge.ts`, a direct port of the web's `agui-bridge.ts`).
The official [`@copilotkit/react-native`](https://docs.copilotkit.ai/react-native)
SDK provides the provider shell and the `useComponent` generative-component
registrations (`GenerativeHostNative` mirrors the web's `GenerativeComponentHost`).

The web registry (`lib/agents/components/registry.ts`) stays the allowlist
authority. Mobile renders the native-mapped subset (`src/components/registry.native.ts`;
currently `approval_card` → `NativeApprovalCard`). `__tests__/registry-subset.test.ts`
fails if the subset ever drifts from the web allowlist.

Visuals follow the Agentic OS design system (`docs/design/DESIGN.md`) through
`src/theme.ts`: black primary actions, canvas background, white surfaces, and
the four status colors for agent states only.

## Server URL (self-hosted installs)

Resolution order (`src/config.ts`):

1. The in-app **Server** setting: sign-in screen → "Change". The address is
   checked (`/api/health/live`) before it is saved on the device. https is
   required except for localhost and private-network addresses. Switching
   servers signs out.
2. `EXPO_PUBLIC_API_BASE_URL` (build env; set per EAS profile in `eas.json`).
3. `extra.apiBaseUrl` from `app.config.ts` (`SHAPESOS_API_BASE_URL` at config time).
4. `http://localhost:3000`.

On a physical device, `localhost` is the phone: use the dev machine's LAN IP
(e.g. `http://192.168.1.10:3000`).

## Auth: the web app's session, including two-step sign-in

All routes authenticate via `requireUser()` → Auth.js v5 (`auth()`), which reads
the session JWT cookie (12h absolute lifetime). The app signs in through the
same Auth.js endpoints and handles cookies itself (`src/auth/session.ts`;
every auth fetch uses `credentials: "omit"` so the native cookie jar never
interferes):

1. `GET {base}/api/auth/csrf` → `csrfToken` + the `authjs.csrf-token` cookie
   (Auth.js double-submit CSRF: the credentials POST needs both).
2. `POST {base}/api/auth/callback/credentials` (form `csrfToken`, `email`,
   `password`, `callbackUrl`) with `X-Auth-Return-Redirect: 1`, so Auth.js
   answers JSON `{ url }` instead of a 302, plus the session `Set-Cookie`.
3. `GET {base}/api/auth/session` with that cookie: `{ user }` means signed in;
   `{ mfa: { pending, methods } }` means the account has two-step sign-in
   (Phase 4a) and the session is **pending**, not signed in.
4. Second step: `POST {base}/api/auth/callback/two-factor` (form `csrfToken`,
   `code`) with the CSRF cookie and the pending session cookie. The code is the
   6-digit authenticator (TOTP) code or a recovery code. Success re-issues a
   full session cookie. Passkey-only accounts are sent to the web app.

The cookie names the server set (`authjs.session-token` over http,
`__Secure-authjs.session-token` over https, chunked `.0`/`.1` for large JWTs)
are stored verbatim in `expo-secure-store` and sent back as the `Cookie`
header. RBAC stays server-side (viewer+ to read, editor+ to decide).

## Push notifications

After sign-in the app asks for notification permission, gets its Expo push
token (`expo-notifications`; needs `EAS_PROJECT_ID`) and registers it with
`POST /api/mobile/push-devices`. The server pushes approval needed / decided
and failed agent runs from the Phase 3 notification producers when
`PUSH_PROVIDER=expo` is set on the server (`EXPO_ACCESS_TOKEN` only if
"enhanced push security" is on). Tokens Expo reports as `DeviceNotRegistered`
are deleted at once; a token that keeps failing is deleted after 5 attempts.
Settings → Notifications turns push off for this device (opt-out) or mutes
single kinds. Signing out unregisters the device. Tapping a push opens the
matching tab.

## Builds (EAS)

`app.config.ts` reads everything per build from the environment; `eas.json`
has `development` (dev client, simulator), `preview` (internal distribution)
and `production` (store, auto-incremented build numbers) profiles.

| Variable | Purpose |
|---|---|
| `SHAPESOS_IOS_BUNDLE_ID` / `SHAPESOS_ANDROID_PACKAGE` | Your bundle ids. The defaults (`com.example.shapesos`) are placeholders: replace them before submitting. Non-production variants get `.dev` / `.preview` suffixes. |
| `EAS_PROJECT_ID` | EAS project id (from `eas init`); required for push tokens and updates. |
| `SHAPESOS_API_BASE_URL` / `EXPO_PUBLIC_API_BASE_URL` | Default server for the build. |
| `SHAPESOS_APP_VARIANT` | `development` / `preview` / `production` (set by the profiles). |

No credentials are in the repo: signing is managed by EAS, and the `submit`
block in `eas.json` holds `REPLACE_WITH_…` placeholders. `secrets/` is
git-ignored for a Play service-account key.

## Run it

```sh
cd mobile
npm install
npm run typecheck   # tsc --noEmit (own tsconfig, includes app.config.ts)
npm test            # vitest
npx expo start      # Expo Go (push needs a dev build: npm run build:dev)
```

## Workspace isolation

This directory is **outside** the root npm workspace: it has its own
`package.json` + `package-lock.json`, is not referenced by the root manifest,
and the root `tsconfig.json` excludes `mobile/` so the root typecheck/build
never sees it.

## What was verified vs. what was not

- ✅ `tsc --noEmit` clean on the app's own tsconfig
- ✅ vitest suites green (bridge, gate contracts, session cookies, two-step
  sign-in against a mocked Auth.js, server URL rules, push client, app config,
  registry subset)
- ✅ `npx expo config --type prebuild` resolves (plugins included)
- ❌ **No iOS simulator / Android emulator on this box**: the app has not been
  booted on a device. `expo start` + a phone (or a dev build for push) is the
  first real boot.
- ❌ The sign-in and push flows are implemented against the documented
  Auth.js / Expo behavior and tested with mocked servers; they have not been
  exercised against a live server from a device.
