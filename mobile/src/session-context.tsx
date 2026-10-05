// ShapesOS mobile — session + agent context.
//
// Owns the SessionManager (web app's session cookie), the server URL (build
// default or the in-app "Server" setting for self-hosted installs), the gate
// client options, push registration, and the agent (HttpAgent bridged to
// /api/agents/chat). Screens consume this instead of threading auth through
// props.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { HttpAgent } from "@ag-ui/client";
import { API_BASE_URL, createServerUrlStore, normalizeServerUrl, probeServer, resolveServerUrl } from "./config";
import { SessionManager } from "./auth/session";
import { createMarketrAgent } from "./agents/marketr-agent";
import type { GateClientOptions } from "./api/gate";
import { registerForPush, unregisterPush, type PushRegistration } from "./push/register";

interface SessionContextValue {
  session: SessionManager;
  baseUrl: string;
  /** The build's default server (shown as "Default" in the server setting). */
  defaultBaseUrl: string;
  /** True when the user picked a server in the app. */
  customServer: boolean;
  signedIn: boolean;
  sessionReady: boolean;
  gate: GateClientOptions;
  /** The agent, created once the session is restored. Null until signed in. */
  agent: HttpAgent | null;
  push: PushRegistration | null;
  /** Validate, probe and save a server URL (null = back to the default). Signs out. */
  setServer: (input: string | null) => Promise<{ ok: true } | { ok: false; error: string }>;
  signOut: () => Promise<void>;
  refreshSignedIn: () => void;
  retryPush: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const session = useMemo(() => new SessionManager(), []);
  const serverStore = useMemo(() => createServerUrlStore(), []);
  const [baseUrl, setBaseUrl] = useState(API_BASE_URL);
  const [customServer, setCustomServer] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [push, setPush] = useState<PushRegistration | null>(null);
  const [pushAttempt, setPushAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const url = await resolveServerUrl(serverStore);
      const ok = await session.restore();
      if (cancelled) return;
      setBaseUrl(url);
      setCustomServer(url !== API_BASE_URL);
      setSignedIn(ok);
      setSessionReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [session, serverStore]);

  const gate = useMemo<GateClientOptions>(
    () => ({ baseUrl, authHeaders: () => session.authHeaders() }),
    [session, baseUrl],
  );

  // Register this device for push once signed in (best-effort).
  useEffect(() => {
    if (!signedIn) {
      setPush(null);
      return;
    }
    let cancelled = false;
    registerForPush({ baseUrl, authHeaders: () => session.authHeaders() })
      .then((r) => {
        if (!cancelled) setPush(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setPush({ status: "skipped", reason: e instanceof Error ? e.message : "Push registration failed." });
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, baseUrl, session, pushAttempt]);

  const agent = useMemo(
    () => (signedIn ? createMarketrAgent({ baseUrl, authHeaders: () => session.authHeaders() }) : null),
    [signedIn, session, baseUrl],
  );

  const signOut = useCallback(async () => {
    if (session.isSignedIn) await unregisterPush({ baseUrl, authHeaders: () => session.authHeaders() });
    await session.logout();
    setSignedIn(false);
  }, [session, baseUrl]);

  const setServer = useCallback(
    async (input: string | null): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (input === null || !input.trim()) {
        await serverStore.clear();
        if (API_BASE_URL !== baseUrl) await signOut();
        setBaseUrl(API_BASE_URL);
        setCustomServer(false);
        return { ok: true };
      }
      const n = normalizeServerUrl(input);
      if (!n.ok) return n;
      const probe = await probeServer(n.url);
      if (!probe.ok) return probe;
      await serverStore.set(n.url);
      // A session belongs to one server: switching servers signs out.
      if (n.url !== baseUrl) await signOut();
      setBaseUrl(n.url);
      setCustomServer(n.url !== API_BASE_URL);
      return { ok: true };
    },
    [serverStore, baseUrl, signOut],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      baseUrl,
      defaultBaseUrl: API_BASE_URL,
      customServer,
      signedIn,
      sessionReady,
      gate,
      agent,
      push,
      setServer,
      signOut,
      refreshSignedIn: () => setSignedIn(session.isSignedIn),
      retryPush: () => setPushAttempt((n) => n + 1),
    }),
    [session, baseUrl, customServer, signedIn, sessionReady, gate, agent, push, setServer, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
