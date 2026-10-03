// Marketr mobile — app shell.
//
// Phase 16 slice 10. CopilotKit integration, mirroring the web shell
// (components/agents/MarketrAgentShell.tsx):
//   - CopilotKitProvider from the official @copilotkit/react-native SDK
//     (v1.75.0, verified on npm 2026-09-29) is the provider shell.
//   - The agent is self-managed: an HttpAgent bridged to the SAME
//     /api/agents/chat AG-UI backend as the web (src/agents/marketr-agent.ts)
//     — no @copilotkit/runtime, no separate mobile agent logic. This mirrors
//     the web shell's `selfManagedAgents` pattern; the provider's own runtime
//     sync is unused (runtimeUrl is required by the SDK's props, so it
//     points at the API base and any sync failure is logged, never fatal to
//     the self-managed agent path).
//   - GenerativeHostNative registers the native-mapped component subset via
//     the SDK's useComponent — the same registration the web shell uses.

import React, { useEffect, useState } from "react";
import { ActivityIndicator, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { CopilotKitProvider } from "@copilotkit/react-native";
import { ListChecks, MessageCircle, Rocket } from "lucide-react-native";
import { SessionProvider, useSession } from "./session-context";
import { GenerativeHostNative } from "./components/GenerativeHost.native";
import { LoginScreen } from "./screens/LoginScreen";
import { ChatScreen } from "./screens/ChatScreen";
import { ApprovalQueueScreen } from "./screens/ApprovalQueueScreen";
import { MissionsScreen } from "./screens/MissionsScreen";

type Tab = "chat" | "approvals" | "missions";

const TABS: Array<{ id: Tab; label: string; Icon: typeof MessageCircle }> = [
  { id: "chat", label: "Chat", Icon: MessageCircle },
  { id: "approvals", label: "Approvals", Icon: ListChecks },
  { id: "missions", label: "Missions", Icon: Rocket },
];

function resolveDefaultProjectId(baseUrl: string, authHeaders: () => Record<string, string>): Promise<string | null> {
  return fetch(`${baseUrl}/api/projects`, { headers: authHeaders() })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j?.projects?.[0]?.id as string | undefined) ?? null)
    .catch(() => null);
}

function AuthedApp() {
  const { session, baseUrl, gate, signOut } = useSession();
  const [tab, setTab] = useState<Tab>("chat");
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void resolveDefaultProjectId(baseUrl, gate.authHeaders).then((pid) => {
      if (!cancelled) setProjectId(pid);
    });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, gate]);

  return (
    <CopilotKitProvider
      runtimeUrl={`${baseUrl}/api/copilotkit`}
      headers={() => session.authHeaders()}
      onError={(event) => {
        // Provider-level runtime sync is unused (self-managed agent); log it.
        console.warn(`[marketr-mobile] copilotkit: ${event.code}`, event.error?.message);
      }}
    >
      <GenerativeHostNative gate={gate} />
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>ShapesOS Agent</Text>
          <TouchableOpacity onPress={() => void signOut()} style={styles.signOut}>
            <Text style={styles.signOutText}>Sign out</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.body}>
          {tab === "chat" ? <ChatScreen /> : null}
          {tab === "approvals" ? <ApprovalQueueScreen projectId={projectId} /> : null}
          {tab === "missions" ? <MissionsScreen /> : null}
        </View>
        <View style={styles.tabBar}>
          {TABS.map(({ id, label, Icon }) => (
            <TouchableOpacity key={id} style={styles.tab} onPress={() => setTab(id)}>
              <Icon size={22} color={tab === id ? "#7c3aed" : "#a8a29e"} />
              <Text style={[styles.tabLabel, tab === id && styles.tabLabelActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </SafeAreaView>
    </CopilotKitProvider>
  );
}

function Root() {
  const { sessionReady, signedIn } = useSession();
  if (!sessionReady) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color="#7c3aed" />
      </View>
    );
  }
  return signedIn ? <AuthedApp /> : <LoginScreen />;
}

export function App() {
  return (
    <SessionProvider>
      <Root />
    </SessionProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#FAFAF7" },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#FAFAF7" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#e7e5e4",
  },
  headerTitle: { fontSize: 17, fontWeight: "800", color: "#1c1917", letterSpacing: -0.3 },
  signOut: { padding: 6 },
  signOutText: { fontSize: 13, color: "#7c3aed", fontWeight: "600" },
  body: { flex: 1 },
  tabBar: {
    flexDirection: "row",
    backgroundColor: "#fff",
    borderTopWidth: 1,
    borderTopColor: "#e7e5e4",
    paddingBottom: 20,
    paddingTop: 8,
  },
  tab: { flex: 1, alignItems: "center", gap: 2 },
  tabLabel: { fontSize: 11, color: "#a8a29e", fontWeight: "600" },
  tabLabelActive: { color: "#7c3aed" },
});
