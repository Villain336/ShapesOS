// Marketr mobile — approval queue screen.
//
// The gate's pending items as a native list; each item renders the
// NativeApprovalCard in-flow (approve/deny/edit execute through the same
// Phase 14 gate routes as the web card). No separate mobile approval logic.

import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSession } from "../session-context";
import { fetchApprovalQueue, GateApiError, type GateItem } from "../api/gate";
import { NativeApprovalCard } from "../components/NativeApprovalCard";

const STATUSES = ["pending", "approved", "rejected"] as const;

export function ApprovalQueueScreen({ projectId }: { projectId: string | null }) {
  const { gate } = useSession();
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("pending");
  const [items, setItems] = useState<GateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    try {
      const list = await fetchApprovalQueue({ baseUrl: gate.baseUrl, authHeaders: gate.authHeaders }, projectId, status);
      setItems(list);
      setError(null);
    } catch (err) {
      setError(err instanceof GateApiError ? `(${err.status}) ${err.message}` : "Failed to load the queue");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [gate, projectId, status]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  // A decision on one card refreshes the list (the item left the pending set).
  const onResolved = useCallback(() => {
    void load();
  }, [load]);

  return (
    <View style={styles.root}>
      <View style={styles.tabs}>
        {STATUSES.map((s) => (
          <TouchableOpacity
            key={s}
            style={[styles.tab, status === s && styles.tabActive]}
            onPress={() => {
              setStatus(s);
              setLoading(true);
            }}
          >
            <Text style={[styles.tabText, status === s && styles.tabTextActive]}>
              {s[0]?.toUpperCase() + s.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      {!projectId ? (
        <View style={styles.center}>
          <Text style={styles.muted}>No project available — create one on the web dashboard first.</Text>
        </View>
      ) : loading && !refreshing ? (
        <View style={styles.center}>
          <ActivityIndicator color="#7c3aed" />
          <Text style={styles.muted}>Loading approvals…</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <TouchableOpacity style={styles.retry} onPress={() => { setLoading(true); void load(); }}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
          {items.length === 0 ? (
            <Text style={styles.muted}>No {status} items.</Text>
          ) : (
            items.map((item) => (
              <NativeApprovalCard
                key={item.id}
                itemId={item.id}
                projectId={projectId}
                gate={gate}
                onResolved={onResolved}
              />
            ))
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#FAFAF7" },
  tabs: { flexDirection: "row", padding: 12, gap: 8, backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e7e5e4" },
  tab: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: "#f5f5f4" },
  tabActive: { backgroundColor: "#7c3aed" },
  tabText: { fontSize: 13, fontWeight: "600", color: "#57534e", textTransform: "capitalize" },
  tabTextActive: { color: "#fff" },
  scroll: { flex: 1 },
  scrollContent: { padding: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 },
  muted: { fontSize: 13, color: "#a8a29e", textAlign: "center" },
  error: { fontSize: 13, color: "#b91c1c", textAlign: "center" },
  retry: { marginTop: 8, backgroundColor: "#f5f5f4", borderRadius: 8, paddingVertical: 8, paddingHorizontal: 16 },
  retryText: { color: "#44403c", fontWeight: "600", fontSize: 13 },
});
