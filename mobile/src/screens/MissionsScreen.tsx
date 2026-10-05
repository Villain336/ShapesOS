// Marketr mobile — missions screen.
//
// Mission progress widgets (GET /api/missions REST fallback; the live
// CoAgents state version rides on the ChatScreen's agent state).

import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSession } from "../session-context";
import { fetchMissions, GateApiError, type MissionLite } from "../api/gate";
import { MissionProgressWidget, type MissionProgress } from "../components/MissionProgressWidget";
import { color } from "../theme";

function toWidget(m: MissionLite): MissionProgress {
  return {
    id: m.id,
    template: m.template,
    goal: m.goal,
    status: m.status,
    progress: m.progress,
    checkpoints: [],
    lastEvent: null,
    updatedAt: m.updatedAt,
  };
}

export function MissionsScreen() {
  const { gate } = useSession();
  const [missions, setMissions] = useState<MissionLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMissions(await fetchMissions(gate));
      setError(null);
    } catch (err) {
      setError(err instanceof GateApiError ? `(${err.status}) ${err.message}` : "Failed to load missions");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [gate]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <View style={styles.root}>
      {loading && !refreshing ? (
        <View style={styles.center}>
          <ActivityIndicator color={color.ink} />
          <Text style={styles.muted}>Loading missions…</Text>
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
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}
        >
          {missions.length === 0 ? (
            <Text style={styles.muted}>No missions yet.</Text>
          ) : (
            missions.map((m) => <MissionProgressWidget key={m.id} mission={toWidget(m)} />)
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvas },
  scroll: { flex: 1 },
  scrollContent: { padding: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 },
  muted: { fontSize: 13, color: color.subtle, textAlign: "center" },
  error: { fontSize: 13, color: color.failedText, textAlign: "center" },
  retry: { marginTop: 8, backgroundColor: color.canvas, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 16 },
  retryText: { color: color.muted, fontWeight: "600", fontSize: 13 },
});
