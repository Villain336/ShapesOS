// ShapesOS mobile — the unified approvals queue (Phase 18.3, WS=trust).
//
// The same feed as the web's Needs you inbox (GET /api/approvals/inbox, all
// 17 sources: missions, ad spend, outreach, messaging, … autopilot and
// workflow approval gates). Approve / deny POST the item's OWN action — its
// source's existing decide route, which re-checks every rule — and an item
// this person can't decide here says why and opens on the web.

import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSession } from "../session-context";
import { decideInboxItem, decisionRequest, fetchInbox, groupInbox, OsApiError, type InboxItem, type InboxResult } from "../api/os";
import { color, CONTROL_HEIGHT, font, radius } from "../theme";

export function ApprovalQueueScreen() {
  const { gate, baseUrl } = useSession();
  const opts = { baseUrl: gate.baseUrl, authHeaders: gate.authHeaders };
  const [result, setResult] = useState<InboxResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setResult(await fetchInbox({ baseUrl: gate.baseUrl, authHeaders: gate.authHeaders }));
      setError(null);
    } catch (err) {
      setError(err instanceof OsApiError ? `(${err.status}) ${err.message}` : "Couldn't load approvals.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [gate]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (item: InboxItem, decision: "approve" | "deny") => {
    setBusy(item.key);
    try {
      await decideInboxItem(opts, item, decision);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't decide that.");
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={color.ink} />
        <Text style={styles.muted}>Loading approvals…</Text>
      </View>
    );
  }
  const groups = result ? groupInbox(result) : [];
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}
    >
      <Text style={styles.heading} accessibilityRole="header">
        Needs you
      </Text>
      <Text style={styles.muted}>
        {result ? `${result.actionable} you can decide · ${result.total} waiting` : ""}
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {groups.length === 0 && !error ? <Text style={styles.empty}>Nothing is waiting on you.</Text> : null}
      {groups.map((g) => (
        <View key={g.source} style={styles.group}>
          <Text style={styles.groupLabel}>{g.label}</Text>
          {g.items.map((item) => (
            <View key={item.key} style={styles.card}>
              <View style={styles.cardHead}>
                <View style={styles.needsMark} accessibilityLabel="Needs you" />
                <Text style={styles.type}>{item.typeLabel}</Text>
              </View>
              <Text style={styles.title}>{item.title}</Text>
              {item.detail ? <Text style={styles.detail}>{item.detail}</Text> : null}
              {item.requester ? <Text style={styles.meta}>Asked by {item.requester}</Text> : null}
              {decisionRequest(item, "approve") ? (
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={[styles.approve, busy === item.key && styles.disabled]}
                    disabled={busy !== null}
                    onPress={() => void decide(item, "approve")}
                    accessibilityRole="button"
                    accessibilityLabel={`Approve ${item.title}`}
                  >
                    <Text style={styles.approveText}>{busy === item.key ? "Approving" : "Approve"}</Text>
                  </TouchableOpacity>
                  {decisionRequest(item, "deny") ? (
                    <TouchableOpacity
                      style={styles.deny}
                      disabled={busy !== null}
                      onPress={() => void decide(item, "deny")}
                      accessibilityRole="button"
                      accessibilityLabel={`Deny ${item.title}`}
                    >
                      <Text style={styles.denyText}>Deny</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : (
                <TouchableOpacity onPress={() => void Linking.openURL(`${baseUrl}${item.href}`)} accessibilityRole="link">
                  <Text style={styles.link}>{item.blockedReason ?? "Review on the web"}</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvas },
  content: { padding: 16, gap: 8 },
  heading: { fontSize: font.xl, fontWeight: "800", color: color.ink, letterSpacing: -0.3 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 },
  muted: { fontSize: font.sm, color: color.subtle },
  empty: { fontSize: font.base, color: color.muted, marginTop: 16 },
  error: { fontSize: font.sm, color: color.failedText },
  group: { marginTop: 12, gap: 8 },
  groupLabel: { fontSize: font.xs, fontWeight: "600", color: color.muted },
  card: { backgroundColor: color.paper, borderRadius: radius.lg, padding: 14, gap: 6 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  // Needs-you triangle stand-in: the status colour with its black edge.
  needsMark: { width: 10, height: 10, backgroundColor: color.needs, borderWidth: 1, borderColor: color.ink, transform: [{ rotate: "45deg" }] },
  type: { fontSize: font.xs, fontWeight: "600", color: color.muted },
  title: { fontSize: font.base, fontWeight: "600", color: color.ink },
  detail: { fontSize: font.md, color: color.muted },
  meta: { fontSize: font.xs, color: color.subtle },
  actions: { flexDirection: "row", gap: 8, marginTop: 6 },
  approve: { minHeight: CONTROL_HEIGHT, paddingHorizontal: 20, borderRadius: radius.pill, backgroundColor: color.done, alignItems: "center", justifyContent: "center" },
  approveText: { color: color.paper, fontWeight: "600", fontSize: font.base },
  deny: { minHeight: CONTROL_HEIGHT, paddingHorizontal: 20, borderRadius: radius.pill, backgroundColor: color.paper, borderWidth: 1.5, borderColor: color.failed, alignItems: "center", justifyContent: "center" },
  denyText: { color: color.failedText, fontWeight: "600", fontSize: font.base },
  disabled: { opacity: 0.6 },
  link: { fontSize: font.sm, fontWeight: "600", color: color.ink, textDecorationLine: "underline", marginTop: 4 },
});
