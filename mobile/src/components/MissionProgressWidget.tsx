// Marketr mobile — mission progress widget.
//
// Renders one mission's CoAgents shared state (lib/agents/agui/shared-state.ts
// `mission` domain shape): progress bar, checkpoint list, status badge, last
// agent event. Fed either by the live agent state (STATE_SNAPSHOT/DELTA over
// the AG-UI stream) or by the GET /api/missions REST fallback — the widget
// itself is data-source agnostic.

import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { CheckCircle2, Circle, Rocket } from "lucide-react-native";

export interface MissionProgress {
  id: string;
  template: string;
  goal: string;
  status: string;
  /** 0–1 */
  progress: number;
  checkpoints: string[];
  lastEvent: { step: string; tool: string; at: string } | null;
  updatedAt: string;
}

const STATUS_STYLE: Record<string, { bg: object; text: object }> = {
  running: { bg: { backgroundColor: "#f5f3ff" }, text: { color: "#7c3aed" } },
  paused: { bg: { backgroundColor: "#fffbeb" }, text: { color: "#92400e" } },
  complete: { bg: { backgroundColor: "#f0fdf4" }, text: { color: "#15803d" } },
};

function statusStyle(status: string) {
  return STATUS_STYLE[status] ?? { bg: { backgroundColor: "#f5f5f4" }, text: { color: "#57534e" } };
}

export function MissionProgressWidget({ mission }: { mission: MissionProgress }) {
  const pct = Math.round(Math.min(1, Math.max(0, mission.progress)) * 100);
  const st = statusStyle(mission.status);
  return (
    <View style={styles.card} testID="mission-progress-widget">
      <View style={styles.headerRow}>
        <Rocket size={14} color="#7c3aed" />
        <Text style={styles.template} numberOfLines={1}>
          {mission.template}
        </Text>
        <View style={[styles.statusBadge, st.bg]}>
          <Text style={[styles.statusText, st.text]}>{mission.status}</Text>
        </View>
      </View>
      <Text style={styles.goal} numberOfLines={2}>
        {mission.goal}
      </Text>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${pct}%` }]} />
      </View>
      <Text style={styles.pct}>{pct}% complete</Text>
      {mission.checkpoints.length > 0 ? (
        <View style={styles.checkpoints}>
          {mission.checkpoints.slice(0, 5).map((c, i) => (
            <View key={`${i}-${c}`} style={styles.checkpointRow}>
              <CheckCircle2 size={13} color="#16a34a" />
              <Text style={styles.checkpointText} numberOfLines={1}>
                {c}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.checkpointRow}>
          <Circle size={13} color="#a8a29e" />
          <Text style={styles.muted}>No checkpoints yet</Text>
        </View>
      )}
      {mission.lastEvent ? (
        <Text style={styles.muted}>
          Last: {mission.lastEvent.step} · {mission.lastEvent.tool}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e7e5e4",
    padding: 14,
    marginVertical: 6,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  template: { fontSize: 13, fontWeight: "700", color: "#1c1917", flex: 1 },
  statusBadge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { fontSize: 11, fontWeight: "600", textTransform: "capitalize" },
  goal: { fontSize: 14, color: "#44403c", marginBottom: 8 },
  barTrack: { height: 8, borderRadius: 999, backgroundColor: "#f5f5f4", overflow: "hidden" },
  barFill: { height: 8, borderRadius: 999, backgroundColor: "#7c3aed" },
  pct: { fontSize: 12, color: "#78716c", marginTop: 4, marginBottom: 8 },
  checkpoints: { gap: 4, marginBottom: 6 },
  checkpointRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  checkpointText: { fontSize: 13, color: "#44403c", flex: 1 },
  muted: { fontSize: 12, color: "#a8a29e" },
});
