// ShapesOS mobile — notifications (Phase 18.3, WS=trust).
//
// The person's notifications in the current workspace (GET /api/notifications),
// tap to mark read, "Mark all read", and their OWN notification preferences —
// the same store as the web's Settings → You → Notifications
// (GET/PATCH /api/preferences): mute a kind everywhere, or keep it off the
// phone. Per-device opt-out stays in Settings.

import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from "react-native";
import { useSession } from "../session-context";
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_LABELS,
  fetchNotificationPrefs,
  fetchNotifications,
  markNotificationsRead,
  saveNotificationPrefs,
  setPhonePush,
  toggleMuted,
  type NotificationItem,
  type NotificationPrefs,
} from "../api/os";
import { color, CONTROL_HEIGHT, font, radius } from "../theme";

export function NotificationsScreen() {
  const { gate } = useSession();
  const opts = useCallback(() => ({ baseUrl: gate.baseUrl, authHeaders: gate.authHeaders }), [gate]);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [showPrefs, setShowPrefs] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, p] = await Promise.all([fetchNotifications(opts()), fetchNotificationPrefs(opts()).catch(() => null)]);
      setItems(list.notifications);
      setUnread(list.unread);
      if (p) setPrefs(p);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load notifications.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [opts]);

  useEffect(() => {
    void load();
  }, [load]);

  const read = async (ids: string[] | "all") => {
    try {
      const r = await markNotificationsRead(opts(), ids);
      setUnread(r.unread);
      const now = new Date().toISOString();
      setItems((prev) => prev.map((n) => (ids === "all" || ids.includes(n.id) ? { ...n, readAt: n.readAt ?? now } : n)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't mark read.");
    }
  };

  const save = async (next: NotificationPrefs) => {
    const before = prefs;
    setPrefs(next);
    try {
      setPrefs(await saveNotificationPrefs(opts(), next));
    } catch (e) {
      setPrefs(before);
      setError(e instanceof Error ? e.message : "Couldn't save.");
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={color.ink} />
      </View>
    );
  }
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} />}
    >
      <View style={styles.headRow}>
        <Text style={styles.heading} accessibilityRole="header">
          Notifications
        </Text>
        {unread > 0 ? (
          <TouchableOpacity style={styles.secondary} onPress={() => void read("all")} accessibilityRole="button">
            <Text style={styles.secondaryText}>Mark all read</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {items.length === 0 ? <Text style={styles.empty}>You're all caught up.</Text> : null}
      {items.map((n) => (
        <TouchableOpacity
          key={n.id}
          style={[styles.card, !n.readAt && styles.unread]}
          onPress={() => (n.readAt ? undefined : void read([n.id]))}
          accessibilityRole="button"
          accessibilityLabel={`${n.readAt ? "" : "Unread. "}${n.title}`}
        >
          <Text style={styles.kind}>{NOTIFICATION_KIND_LABELS[n.kind as keyof typeof NOTIFICATION_KIND_LABELS] ?? n.kind}</Text>
          <Text style={styles.title}>{n.title}</Text>
          {n.body ? <Text style={styles.body}>{n.body}</Text> : null}
          <Text style={styles.meta}>{new Date(n.createdAt).toLocaleString()}</Text>
        </TouchableOpacity>
      ))}

      <TouchableOpacity style={styles.secondary} onPress={() => setShowPrefs((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: showPrefs }}>
        <Text style={styles.secondaryText}>{showPrefs ? "Hide what reaches you" : "Choose what reaches you"}</Text>
      </TouchableOpacity>
      {showPrefs && prefs ? (
        <View style={styles.prefs}>
          <Text style={styles.help}>The same choices as on the web (Settings → You → Notifications).</Text>
          {NOTIFICATION_KINDS.map((k) => {
            const muted = prefs.mutedKinds.includes(k);
            const phone = prefs.channels?.[k]?.push;
            return (
              <View key={k} style={styles.prefRow}>
                <Text style={styles.prefLabel}>{NOTIFICATION_KIND_LABELS[k]}</Text>
                <View style={styles.prefControls}>
                  <Text style={styles.prefHint}>On</Text>
                  <Switch
                    value={!muted}
                    onValueChange={(on) => void save(toggleMuted(prefs, k, !on))}
                    trackColor={{ true: color.ink, false: color.disabledFg }}
                    thumbColor={color.paper}
                    accessibilityLabel={`${NOTIFICATION_KIND_LABELS[k]}: on`}
                  />
                  <Text style={styles.prefHint}>Phone</Text>
                  <Switch
                    value={!muted && prefs.push && phone !== false}
                    disabled={muted || !prefs.push || k === "alert_fired" || k === "invite_accepted"}
                    onValueChange={(on) => void save(setPhonePush(prefs, k, on))}
                    trackColor={{ true: color.ink, false: color.disabledFg }}
                    thumbColor={color.paper}
                    accessibilityLabel={`${NOTIFICATION_KIND_LABELS[k]}: on this phone`}
                  />
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvas },
  content: { padding: 16, gap: 8 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  heading: { fontSize: font.xl, fontWeight: "800", color: color.ink, letterSpacing: -0.3 },
  error: { fontSize: font.sm, color: color.failedText },
  empty: { fontSize: font.base, color: color.muted, marginTop: 16 },
  card: { backgroundColor: color.paper, borderRadius: radius.lg, padding: 14, gap: 4 },
  unread: { borderLeftWidth: 4, borderLeftColor: color.ink },
  kind: { fontSize: font.xs, fontWeight: "600", color: color.muted },
  title: { fontSize: font.base, fontWeight: "600", color: color.ink },
  body: { fontSize: font.md, color: color.muted },
  meta: { fontSize: font.xs, color: color.subtle },
  secondary: { minHeight: CONTROL_HEIGHT, paddingHorizontal: 16, borderRadius: radius.pill, borderWidth: 1.5, borderColor: color.ink, backgroundColor: color.paper, alignItems: "center", justifyContent: "center", marginTop: 8 },
  secondaryText: { color: color.ink, fontWeight: "600", fontSize: font.base },
  prefs: { backgroundColor: color.paper, borderRadius: radius.lg, padding: 14, gap: 10 },
  help: { fontSize: font.sm, color: color.muted },
  prefRow: { gap: 4 },
  prefLabel: { fontSize: font.base, fontWeight: "600", color: color.ink },
  prefControls: { flexDirection: "row", alignItems: "center", gap: 8 },
  prefHint: { fontSize: font.xs, color: color.muted },
});
