// ShapesOS mobile — the core apps on the phone (Phase 18.3, WS=trust):
// Missions, and READ-ONLY Files, Calendar and Mail over the 18.2 APIs
// (/api/files, /api/comms/calendar/events, /api/comms/mail/threads). Writing
// stays on the web, where the tool gates and approvals live. A source that
// isn't connected says so; nothing is faked (a mock event is labelled).

import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSession } from "../session-context";
import {
  fetchCalendar,
  fetchFiles,
  fetchMail,
  fetchWorkspace,
  formatSize,
  groupByDay,
  parentPrefix,
  type CalendarEvent,
  type FileListing,
  type MailThread,
} from "../api/os";
import { MissionsScreen } from "./MissionsScreen";
import { color, font, radius } from "../theme";

type App = "missions" | "files" | "calendar" | "mail";
const APPS: Array<{ id: App; label: string }> = [
  { id: "missions", label: "Missions" },
  { id: "files", label: "Files" },
  { id: "calendar", label: "Calendar" },
  { id: "mail", label: "Mail" },
];

export function AppsScreen() {
  const [app, setApp] = useState<App>("missions");
  return (
    <View style={styles.root}>
      <View style={styles.switcher} accessibilityRole="tablist">
        {APPS.map((a) => (
          <TouchableOpacity
            key={a.id}
            style={[styles.chip, app === a.id && styles.chipOn]}
            onPress={() => setApp(a.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: app === a.id }}
          >
            <Text style={[styles.chipText, app === a.id && styles.chipTextOn]}>{a.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.body}>
        {app === "missions" ? <MissionsScreen /> : null}
        {app === "files" ? <FilesView /> : null}
        {app === "calendar" ? <CalendarView /> : null}
        {app === "mail" ? <MailView /> : null}
      </View>
    </View>
  );
}

function useLoader<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const run = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load.");
    } finally {
      setLoading(false);
    }
  }, [load]);
  useEffect(() => {
    void run();
  }, [run]);
  return { data, error, loading, reload: run };
}

function Frame({ loading, error, onRefresh, children }: { loading: boolean; error: string | null; onRefresh: () => void; children: React.ReactNode }) {
  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={color.ink} />
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={false} onRefresh={onRefresh} />}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {children}
    </ScrollView>
  );
}

function FilesView() {
  const { gate } = useSession();
  const [prefix, setPrefix] = useState("/files");
  const load = useCallback(async (): Promise<FileListing> => {
    const o = { baseUrl: gate.baseUrl, authHeaders: gate.authHeaders };
    const ws = await fetchWorkspace(o);
    if (!ws) throw new Error("No workspace.");
    return fetchFiles(o, ws.id, prefix);
  }, [gate, prefix]);
  const { data, error, loading, reload } = useLoader(load);
  return (
    <Frame loading={loading} error={error} onRefresh={() => void reload()}>
      <Text style={styles.path}>{prefix}</Text>
      {prefix !== "/" ? (
        <TouchableOpacity style={styles.row} onPress={() => setPrefix(parentPrefix(prefix))} accessibilityRole="button">
          <Text style={styles.rowTitle}>.. Up</Text>
        </TouchableOpacity>
      ) : null}
      {data?.dirs.map((d) => (
        <TouchableOpacity key={d} style={styles.row} onPress={() => setPrefix(d)} accessibilityRole="button">
          <Text style={styles.rowTitle}>{d.split("/").filter(Boolean).pop()}/</Text>
        </TouchableOpacity>
      ))}
      {data?.files.map((f) => (
        <View key={f.id} style={styles.row}>
          <Text style={styles.rowTitle}>{f.filename}</Text>
          <Text style={styles.meta}>
            {formatSize(f.sizeBytes)} · {new Date(f.createdAt).toLocaleDateString()}
          </Text>
        </View>
      ))}
      {data && data.dirs.length === 0 && data.files.length === 0 ? <Text style={styles.empty}>This folder is empty.</Text> : null}
    </Frame>
  );
}

function CalendarView() {
  const { gate } = useSession();
  const load = useCallback(() => fetchCalendar({ baseUrl: gate.baseUrl, authHeaders: gate.authHeaders }, new Date(), 14), [gate]);
  const { data, error, loading, reload } = useLoader(load);
  const days = data ? groupByDay(data.events, data.timeZone) : [];
  return (
    <Frame loading={loading} error={error} onRefresh={() => void reload()}>
      {data?.errors.map((e) => (
        <Text key={e.source} style={styles.error}>
          {e.source}: {e.message}
        </Text>
      ))}
      {days.length === 0 ? <Text style={styles.empty}>Nothing in the next two weeks.</Text> : null}
      {days.map((d) => (
        <View key={d.day} style={styles.group}>
          <Text style={styles.groupLabel}>{new Date(`${d.day}T12:00:00`).toDateString()}</Text>
          {d.events.map((e: CalendarEvent) => (
            <View key={e.id} style={styles.row}>
              <Text style={styles.rowTitle}>
                {e.title}
                {e.mock ? " (sample data)" : ""}
              </Text>
              <Text style={styles.meta}>
                {e.allDay ? "All day" : new Date(e.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: data?.timeZone })}
                {e.location ? ` · ${e.location}` : ""}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </Frame>
  );
}

function MailView() {
  const { gate } = useSession();
  const load = useCallback(() => fetchMail({ baseUrl: gate.baseUrl, authHeaders: gate.authHeaders }), [gate]);
  const { data, error, loading, reload } = useLoader(load);
  const disconnected = data?.sources.filter((s) => !s.connected) ?? [];
  return (
    <Frame loading={loading} error={error} onRefresh={() => void reload()}>
      {data && data.threads.length === 0 ? (
        <Text style={styles.empty}>{disconnected.length === data.sources.length ? "No mailbox is connected. Connect Gmail or Outlook on the web." : "Your inbox is empty."}</Text>
      ) : null}
      {data?.threads.map((t: MailThread) => (
        <View key={t.key} style={[styles.row, t.unread && styles.unread]}>
          <Text style={styles.meta}>
            {t.from.name ?? t.from.address ?? t.via} · {new Date(t.lastMessageAt).toLocaleDateString()}
          </Text>
          <Text style={styles.rowTitle}>{t.subject || "(no subject)"}</Text>
          {t.snippet ? <Text style={styles.snippet}>{t.snippet}</Text> : null}
        </View>
      ))}
    </Frame>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvas },
  switcher: { flexDirection: "row", gap: 8, padding: 12, backgroundColor: color.paper, borderBottomWidth: 1, borderBottomColor: color.line },
  chip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: color.canvas },
  chipOn: { backgroundColor: color.ink },
  chipText: { fontSize: font.sm, fontWeight: "600", color: color.ink },
  chipTextOn: { color: color.paper },
  body: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: { padding: 16, gap: 8 },
  error: { fontSize: font.sm, color: color.failedText },
  empty: { fontSize: font.base, color: color.muted, marginTop: 12 },
  path: { fontSize: font.xs, color: color.muted, fontFamily: "monospace" },
  group: { gap: 6, marginTop: 8 },
  groupLabel: { fontSize: font.xs, fontWeight: "600", color: color.muted },
  row: { backgroundColor: color.paper, borderRadius: radius.sm, padding: 12, gap: 2 },
  unread: { borderLeftWidth: 4, borderLeftColor: color.ink },
  rowTitle: { fontSize: font.base, fontWeight: "600", color: color.ink },
  meta: { fontSize: font.xs, color: color.subtle },
  snippet: { fontSize: font.md, color: color.muted },
});
