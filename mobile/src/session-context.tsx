// Marketr mobile — session + agent context.
//
// Owns the SessionManager (web app's session cookie), the API base URL, the
// gate client options, and the MarketrAgent (HttpAgent bridged to
// /api/agents/chat). Screens consume this instead of threading auth through
// props.

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { HttpAgent } from "@ag-ui/client";
import { API_BASE_URL } from "./config";
import { SessionManager } from "./auth/session";
import { createMarketrAgent } from "./agents/marketr-agent";
import type { GateClientOptions } from "./api/gate";

interface SessionContextValue {
  session: SessionManager;
  baseUrl: string;
  signedIn: boolean;
  sessionReady: boolean;
  gate: GateClientOptions;
  /** The agent, created once the session is restored. Null until signed in. */
  agent: HttpAgent | null;
  signOut: () => Promise<void>;
  refreshSignedIn: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const session = useMemo(() => new SessionManager(), []);
  const [sessionReady, setSessionReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void session.restore().then((ok) => {
      if (!cancelled) {
        setSignedIn(ok);
        setSessionReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const gate = useMemo<GateClientOptions>(
    () => ({ baseUrl: API_BASE_URL, authHeaders: () => session.authHeaders() }),
    [session],
  );

  const agent = useMemo(
    () => (signedIn ? createMarketrAgent({ baseUrl: API_BASE_URL, authHeaders: () => session.authHeaders() }) : null),
    [signedIn, session],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      baseUrl: API_BASE_URL,
      signedIn,
      sessionReady,
      gate,
      agent,
      signOut: async () => {
        await session.logout();
        setSignedIn(false);
      },
      refreshSignedIn: () => setSignedIn(session.isSignedIn),
    }),
    [session, signedIn, sessionReady, gate, agent],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
