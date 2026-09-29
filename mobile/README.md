# Marketr Agent — mobile app (iOS + Android)

Expo (React Native) companion app for the Marketr agent. Phase 16 slice 10.

**One agent, every frontend.** This app contains no mobile agent logic. It talks
to the SAME backend as the web app:

| Surface | Backend | Contract |
|---|---|---|
| Agent chat | `POST /api/agents/chat` (SSE, AG-UI events) | Phase 16 slice 1 |
| Approval HITL (approve/deny/edit) | `/api/autopilot/items/[id]`, `/approve`, `/reject`, `/edit` | Phase 14 gate |
| Approval queue list | `GET /api/autopilot/queue` | milestone 18 |
| Mission progress widget | CoAgents `mission` state over the AG-UI stream, `GET /api/missions` fallback | Phase 16 slice 4 |

The agent wiring mirrors the web shell (`components/agents/MarketrAgentShell.tsx`):
an `HttpAgent` from `@ag-ui/client` whose custom `fetch` rewrites the AG-UI
`RunAgentInput` into the route's `{ threadId, content, state? }` body
(`src/api/agui-bridge.ts` — a direct port of the web's `agui-bridge.ts`).
The official [`@copilotkit/react-native`](https://docs.copilotkit.ai/react-native)
SDK (v1.75.0, verified on npm 2026-09-28) provides the provider shell and the
`useComponent` generative-component registrations (`GenerativeHostNative`
mirrors the web's `GenerativeComponentHost`).

The web registry (`lib/agents/components/registry.ts`) stays the allowlist
authority. Mobile renders the native-mapped subset (`src/components/registry.native.ts`;
currently `approval_card` → `NativeApprovalCard`). `__tests__/registry-subset.test.ts`
fails the build if the subset ever drifts from the web allowlist.

## Auth — the web app's session, no new infrastructure

All routes authenticate via `requireUser()` → NextAuth v5 (`auth()`), which reads
the `authjs.session-token` JWT cookie (12h absolute lifetime). React Native has no
cookie jar, so the app reuses the existing Credentials provider endpoint:

1. `GET {base}/api/auth/csrf` → `csrfToken`
2. `POST {base}/api/auth/callback/credentials` (form body, `json=true`,
   `{ csrfToken, email, password, callbackUrl }`)
   → `Set-Cookie: authjs.session-token=<jwt>` (or `__Secure-authjs.session-token` over https)
3. The cookie value is extracted from the `Set-Cookie` header, stored in
   `expo-secure-store` (device keychain/keystore; in-memory fallback in tests),
   and attached as a `Cookie` header on every API call — the exact session the
   web app uses. See `src/auth/session.ts`.

RBAC stays server-side (viewer+ to read, editor+ to decide). The app surfaces
401/403 as typed `GateApiError`s.

## Run it

```sh
cd mobile
npm install
npm run typecheck   # tsc --noEmit (own tsconfig)
npm test            # vitest (35 tests)
npx expo start      # scan the QR with Expo Go, or `npm run ios` / `npm run android`
```

Point the app at your backend:

- `EXPO_PUBLIC_API_BASE_URL=https://your-server` (build env), or
- `app.json` → `expo.extra.apiBaseUrl`, or
- default `http://localhost:3000`

On a physical device, `localhost` is the phone — use the dev machine's LAN IP
(e.g. `http://192.168.1.10:3000`).

## Workspace isolation

This directory is **outside** the root npm workspace: it has its own
`package.json` + `package-lock.json`, is not referenced by the root manifest
(`npm ls marketr-mobile` from the repo root is empty), and the root
`tsconfig.json` excludes `mobile/` so the root typecheck/build never sees it.

## What was verified vs. what was not

- ✅ `tsc --noEmit` clean on the app's own tsconfig (genuine run, exit 0)
- ✅ 35/35 unit tests green (bridge, gate contracts, session cookie parsing,
  registry subset against the real web registry file)
- ✅ Root `npx tsc --noEmit` unaffected (mobile excluded)
- ✅ No live network calls were made by the tests (all pure or mocked)
- ❌ **No iOS simulator / Android emulator on this box** — the app has not been
  booted on a device or simulator. `expo start` + QR scan on a phone is the
  first real boot. Known first-boot risks are documented in `src/App.tsx`
  (the SDK provider's runtime sync is unused by design; the self-managed agent
  path does not depend on it).
- ❌ No screenshots (no device to capture from)
- ❌ The credentials-POST login flow is implemented against documented Auth.js
  behavior but has not been exercised against a live server from this box
