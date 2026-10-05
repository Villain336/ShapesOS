// ShapesOS mobile — settings: server, push notifications, sign out.
//
// Push preferences are per device and stored on the server
// (PATCH /api/mobile/push-devices): turning notifications off is the user's
// opt-out; each kind can also be muted on its own.

import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from "react-native";
import { useSession } from "../session-context";
import { color, CONTROL_HEIGHT, font, radius } from "../theme";
import { PUSH_KIND_LABELS, listPushDevices, updatePushDevice, type PushDevice, type PushKind } from "../push/push-client";

export function SettingsScreen() {
  const { baseUrl, customServer, push, retryPush, signOut, session } = useSession();
  const [device, setDevice] = useState<PushDevice | null>(null);
  const [kinds, setKinds] = useState<PushKind[]>(["approval_needed", "approval_decided", "run_failed"]);
  const [serverSending, setServerSending] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = push?.status === "registered" ? push.token : null;
  const opts = useCallback(() => ({ baseUrl, authHeaders: () => session.authHeaders() }), [baseUrl, session]);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await listPushDevices(opts());
      setKinds(res.kinds);
      setServerSending(res.pushEnabled);
      const hint = token.replace(/^Expo(nent)?PushToken\[|\]$/g, "").slice(-6);
      setDevice(res.devices.find((d) => d.tokenHint === hint) ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load notification settings.");
    }
  }, [token, opts]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: { enabled?: boolean; mutedKinds?: PushKind[] }) => {
    if (!token) return;
    setBusy(true);
    try {
      const res = await updatePushDevice(opts(), { token, ...patch });
      setDevice(res.device);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  };

  const muted = new Set(device?.mutedKinds ?? []);

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <Text style={styles.heading} accessibilityRole="header">
        Settings
      </Text>

      <View style={styles.card}>
        <Text style={styles.section}>Server</Text>
        <Text style={styles.value}>{baseUrl}</Text>
        <Text style={styles.help}>
          {customServer ? "Set in this app." : "This build's default."} To change it, sign out and choose Change on the sign-in screen.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.section}>Notifications</Text>
        {!push ? (
          <ActivityIndicator color={color.ink} />
        ) : push.status === "skipped" ? (
          <>
            <Text style={styles.help}>{push.reason}</Text>
            <TouchableOpacity style={styles.secondary} onPress={retryPush} accessibilityRole="button">
              <Text style={styles.secondaryText}>Try again</Text>
            </TouchableOpacity>
          </>
        ) : (
          <>
            {serverSending === false ? (
              <Text style={styles.help}>This device is registered, but your server isn't sending push notifications yet (PUSH_PROVIDER).</Text>
            ) : null}
            <Row
              label="Push notifications on this device"
              value={device?.enabled ?? true}
              disabled={busy || !device}
              onChange={(v) => void save({ enabled: v })}
            />
            {kinds.map((k) => (
              <Row
                key={k}
                label={PUSH_KIND_LABELS[k]}
                value={!muted.has(k)}
                disabled={busy || !device || device.enabled === false}
                onChange={(on) => {
                  const next = new Set(muted);
                  if (on) next.delete(k);
                  else next.add(k);
                  void save({ mutedKinds: [...next] as PushKind[] });
                }}
              />
            ))}
          </>
        )}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      <TouchableOpacity style={styles.secondary} onPress={() => void signOut()} accessibilityRole="button">
        <Text style={styles.secondaryText}>Sign out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function Row({ label, value, disabled, onChange }: { label: string; value: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, disabled && styles.rowLabelDisabled]}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: color.ink, false: color.disabledFg }}
        thumbColor={color.paper}
        accessibilityLabel={label}
        accessibilityRole="switch"
        accessibilityState={{ checked: value, disabled }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { padding: 16, gap: 12, backgroundColor: color.canvas },
  heading: { fontSize: font.xl, fontWeight: "800", color: color.ink, letterSpacing: -0.3 },
  card: { backgroundColor: color.paper, borderRadius: radius.lg, padding: 16, borderWidth: 1, borderColor: color.line, gap: 6 },
  section: { fontSize: font.lg, fontWeight: "700", color: color.ink },
  value: { fontSize: font.md, color: color.ink },
  help: { fontSize: font.sm, color: color.muted, lineHeight: 18 },
  row: { minHeight: CONTROL_HEIGHT, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  rowLabel: { flex: 1, fontSize: font.base, color: color.ink },
  rowLabelDisabled: { color: color.disabledFg },
  error: { color: color.failedText, fontSize: font.sm },
  secondary: {
    minHeight: CONTROL_HEIGHT,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: color.ink,
    backgroundColor: color.paper,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 22,
  },
  secondaryText: { color: color.ink, fontWeight: "600", fontSize: font.base },
});
