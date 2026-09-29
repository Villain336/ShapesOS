// Marketr mobile — chat message list with generative-component rendering.
//
// Renders the agent's message store (AbstractAgent.messages, maintained by
// the @ag-ui/client base-class event pipeline — the same pipeline the web
// shell uses). Assistant tool calls whose name is natively mapped render the
// native generative component (NativeApprovalCard); a tool call for a
// web-registered but unmapped name (e.g. report_preview) renders an honest
// "open on web" fallback — never an unregistered render.
//
// The render path goes through the same native-mapped subset that
// GenerativeHostNative registers with the SDK's useComponent, so the
// allowlist story is one map, not two.

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Message, ToolCall } from "@ag-ui/client";
import { aguiMessageText } from "../api/agui-bridge";
import {
  NATIVE_GENERATIVE_COMPONENTS,
  WEB_REGISTRY_NAMES,
  isNativeMappedComponentName,
  type NativeGenerativeComponentName,
} from "./registry.native";
import type { GateClientOptions } from "../api/gate";

function toolCallArgs(tc: ToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(tc.function.arguments ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // malformed args — the component render below will show its error state
  }
  return {};
}

function GenerativeCall({
  name,
  toolCall,
  gate,
}: {
  name: string;
  toolCall: ToolCall;
  gate: GateClientOptions;
}) {
  // Web-registered but not natively mapped: honest fallback, never a render
  // of something unregistered.
  if (WEB_REGISTRY_NAMES.has(name) && !isNativeMappedComponentName(name)) {
    return (
      <View style={styles.fallbackCard}>
        <Text style={styles.fallbackText}>
          This preview isn't available in the mobile app yet — open it on the web dashboard.
        </Text>
      </View>
    );
  }
  if (!isNativeMappedComponentName(name)) {
    // Not on the allowlist at all: reject, never render.
    return null;
  }
  const componentName: NativeGenerativeComponentName = name;
  const Component = NATIVE_GENERATIVE_COMPONENTS[componentName].component;
  const args = toolCallArgs(toolCall);
  return (
    <Component
      itemId={String(args.itemId ?? "")}
      projectId={String(args.projectId ?? "")}
      gate={gate}
    />
  );
}

function AssistantBubble({ message, gate }: { message: Message; gate: GateClientOptions }) {
  const text = aguiMessageText((message as { content?: unknown }).content).trim();
  const toolCalls = (message as { toolCalls?: ToolCall[] }).toolCalls ?? [];
  if (!text && toolCalls.length === 0) return null;
  return (
    <View style={styles.assistantWrap}>
      {text ? (
        <View style={styles.assistantBubble}>
          <Text style={styles.assistantText}>{text}</Text>
        </View>
      ) : null}
      {toolCalls.map((tc) => (
        <GenerativeCall key={tc.id} name={tc.function.name} toolCall={tc} gate={gate} />
      ))}
    </View>
  );
}

export function MessageList({ messages, gate }: { messages: readonly Message[]; gate: GateClientOptions }) {
  return (
    <View>
      {messages.map((m) => {
        if (m.role === "user") {
          const text = aguiMessageText((m as { content?: unknown }).content);
          return (
            <View key={m.id} style={styles.userRow}>
              <View style={styles.userBubble}>
                <Text style={styles.userText}>{text}</Text>
              </View>
            </View>
          );
        }
        if (m.role === "assistant") {
          return <AssistantBubble key={m.id} message={m} gate={gate} />;
        }
        // tool / system / developer messages are transport detail — skip.
        return null;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  userRow: { flexDirection: "row", justifyContent: "flex-end", marginVertical: 4 },
  userBubble: { backgroundColor: "#7c3aed", borderRadius: 16, borderBottomRightRadius: 4, paddingVertical: 10, paddingHorizontal: 14, maxWidth: "85%" },
  userText: { color: "#fff", fontSize: 15 },
  assistantWrap: { marginVertical: 4 },
  assistantBubble: { backgroundColor: "#f5f5f4", borderRadius: 16, borderBottomLeftRadius: 4, paddingVertical: 10, paddingHorizontal: 14, maxWidth: "92%", alignSelf: "flex-start" },
  assistantText: { color: "#1c1917", fontSize: 15 },
  fallbackCard: { backgroundColor: "#fafaf9", borderWidth: 1, borderColor: "#e7e5e4", borderRadius: 12, padding: 12, marginVertical: 6 },
  fallbackText: { fontSize: 13, color: "#78716c", fontStyle: "italic" },
});
