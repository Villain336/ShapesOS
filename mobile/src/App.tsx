// ShapesOS mobile — app shell.
//
// Phase 16 slice 10; Phase 4b: ShapesOS brand (Agentic OS tokens), Settings
// tab (server, push preferences, sign out), push-notification taps open the
// matching tab. CopilotKit integration, mirroring the web shell
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
import * as Notifications from "expo-notifications";
import { CopilotKitProvider } from "@copilotkit/react-native";
import { ListChecks, MessageCircle, Rocket, Settings } from "lucide-react-native";
import { SessionProvider, useSession } from "./session-context";
import { GenerativeHostNative } from "./components/GenerativeHost.native";
import { LoginScreen } from "./screens/LoginScreen";
import { ChatScreen } from "./screens/ChatScreen";
import { ApprovalQueueScreen } from "./screens/ApprovalQueueScreen";
import { MissionsScreen } from "./screens/MissionsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { configureForegroundHandling } from "./push/register";
import { tabForPushData, type AppTab } from "./push/push-client";
import { color, font } from "./theme";

type Tab = AppTab;

const TABS: Array<{ id: Tab; label: string; Icon: typeof MessageCircle }> = [
  { id: "chat", label: "Chat", Icon: MessageCircle },
  { id: "approvals", label: "Approvals", Icon: ListChecks },
  { id: "missions", label: "Missions", Icon: Rocket },
  { id: "settings", label: "Settings", Icon: Settings },
];

configureForegroundHandling();

function resolveDefaultProjectId(baseUrl: string, authHeaders: () => Record<string, string>): Promise<string | null> {
  return fetch(`${baseUrl}/api/projects`, { headers: authHeaders() })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j?.projects?.[0]?.id as string | undefined) ?? null)
    .catch(() => null);
}

function AuthedApp() {
  const { session, baseUrl, gate } = useSession();
  const [tab, setTab] = useState<Tab>("chat");
  const [projectId, setProjectId] = useState<string | null>(null);

  // A tapped push opens the tab it is about (also on a cold start).
  useEffect(() => {
    let cancelled = false;
    void Notifications.getLastNotificationResponseAsync()
      .then((r) => {
        const t = tabForPushData(r?.notification.request.content.data);
        if (t && !cancelled) setTab(t);
      })
      .catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      const t = tabForPushData(r.notification.request.content.data);
      if (t) setTab(t);
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

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
        console.warn(`[shapesos-mobile] copilotkit: ${event.code}`, event.error?.message);
      }}
    >
      <GenerativeHostNative gate={gate} />
      <SafeAreaView style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.headerTitle} accessibilityRole="header">
            ShapesOS
          </Text>
        </View>
        <View style={styles.body}>
          {tab === "chat" ? <ChatScreen /> : null}
          {tab === "approvals" ? <ApprovalQueueScreen projectId={projectId} /> : null}
          {tab === "missions" ? <MissionsScreen /> : null}
          {tab === "settings" ? <SettingsScreen /> : null}
        </View>
        <View style={styles.tabBar}>
          {TABS.map(({ id, label, Icon }) => (
            <TouchableOpacity
              key={id}
              style={styles.tab}
              onPress={() => setTab(id)}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === id }}
              accessibilityLabel={label}
            >
              <Icon size={22} color={tab === id ? color.ink : color.subtle} />
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
        <Text style={styles.splashBrand}>ShapesOS</Text>
        <ActivityIndicator color={color.ink} />
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
  root: { flex: 1, backgroundColor: color.canvas },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, backgroundColor: color.canvas },
  splashBrand: { fontSize: 28, fontWeight: "800", color: color.ink, letterSpacing: -0.4 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: color.paper,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  headerTitle: { fontSize: font.lg, fontWeight: "800", color: color.ink, letterSpacing: -0.2 },
  body: { flex: 1 },
  tabBar: {
    flexDirection: "row",
    backgroundColor: color.paper,
    borderTopWidth: 1,
    borderTopColor: color.line,
    paddingBottom: 20,
    paddingTop: 8,
  },
  tab: { flex: 1, alignItems: "center", gap: 2, minHeight: 44 },
  tabLabel: { fontSize: 11, color: color.subtle, fontWeight: "600" },
  tabLabelActive: { color: color.ink },
});
