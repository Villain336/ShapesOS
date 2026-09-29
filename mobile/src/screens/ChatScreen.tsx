// Marketr mobile — agent chat screen.
//
// Drives the MarketrAgent (HttpAgent bridged to POST /api/agents/chat, same
// AG-UI backend as the web shell) directly: addMessage → runAgent, with the
// message store rendered by MessageList (generative components render
// natively in-flow). The CopilotKitProvider above this screen (src/App.tsx)
// hosts the SDK's useComponent registrations — the same native-mapped
// subset MessageList renders from.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Send } from "lucide-react-native";
import type { Message } from "@copilotkit/react-native";
import { useSession } from "../session-context";
import { MessageList } from "../components/MessageList";
import { MissionProgressWidget, type MissionProgress } from "../components/MissionProgressWidget";

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Pull the `mission` domain out of CoAgents shared state (defensive). */
function missionFromState(state: unknown): MissionProgress | null {
  if (!state || typeof state !== "object") return null;
  const m = (state as Record<string, unknown>).mission;
  if (!m || typeof m !== "object") return null;
  const mm = m as Record<string, unknown>;
  if (typeof mm.id !== "string") return null;
  return {
    id: mm.id,
    template: typeof mm.template === "string" ? mm.template : "",
    goal: typeof mm.goal === "string" ? mm.goal : "",
    status: typeof mm.status === "string" ? mm.status : "unknown",
    progress: typeof mm.progress === "number" ? mm.progress : 0,
    checkpoints: Array.isArray(mm.checkpoints) ? mm.checkpoints.filter((c): c is string => typeof c === "string") : [],
    lastEvent:
      mm.lastEvent && typeof mm.lastEvent === "object"
        ? {
            step: String((mm.lastEvent as Record<string, unknown>).step ?? ""),
            tool: String((mm.lastEvent as Record<string, unknown>).tool ?? ""),
            at: String((mm.lastEvent as Record<string, unknown>).at ?? ""),
          }
        : null,
    updatedAt: typeof mm.updatedAt === "string" ? mm.updatedAt : "",
  };
}

export function ChatScreen() {
  const { agent, gate } = useSession();
  const [messages, setMessages] = useState<readonly Message[]>(agent?.messages ?? []);
  const [mission, setMission] = useState<MissionProgress | null>(null);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<React.ElementRef<typeof ScrollView> | null>(null);

  useEffect(() => {
    if (!agent) return;
    setMessages([...agent.messages]);
    setMission(missionFromState(agent.state));
    const sub = agent.subscribe({
      onEvent: () => {
        setMessages([...agent.messages]);
        setMission(missionFromState(agent.state));
      },
    });
    return () => sub.unsubscribe();
  }, [agent]);

  const send = useCallback(async () => {
    if (!agent || running) return;
    const text = input.trim();
    if (!text) return;
    setInput("");
    setError(null);
    setRunning(true);
    try {
      agent.addMessage({ id: makeId(), role: "user", content: text } as Message);
      setMessages([...agent.messages]);
      await agent.runAgent();
      setMessages([...agent.messages]);
      setMission(missionFromState(agent.state));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The agent run failed");
    } finally {
      setRunning(false);
    }
  }, [agent, input, running]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.root}
      keyboardVerticalOffset={90}
    >
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {mission ? <MissionProgressWidget mission={mission} /> : null}
        <MessageList messages={messages} gate={gate} />
        {running ? (
          <View style={styles.thinking}>
            <ActivityIndicator color="#7c3aed" size="small" />
            <Text style={styles.thinkingText}>Agent is working…</Text>
          </View>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          placeholder="Ask the Marketr agent…"
          value={input}
          onChangeText={setInput}
          multiline
          editable={!running}
          onSubmitEditing={() => void send()}
        />
        <TouchableOpacity style={styles.send} onPress={() => void send()} disabled={running || !input.trim()}>
          <Send size={18} color="#fff" />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#FAFAF7" },
  scroll: { flex: 1 },
  scrollContent: { padding: 12, paddingBottom: 24 },
  thinking: { flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 8 },
  thinkingText: { fontSize: 13, color: "#78716c", fontStyle: "italic" },
  error: { color: "#b91c1c", fontSize: 13, marginVertical: 8 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 12, backgroundColor: "#fff", borderTopWidth: 1, borderTopColor: "#e7e5e4" },
  input: { flex: 1, borderWidth: 1, borderColor: "#e7e5e4", borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15, maxHeight: 120, color: "#1c1917" },
  send: { backgroundColor: "#7c3aed", borderRadius: 999, width: 44, height: 44, alignItems: "center", justifyContent: "center" },
});
