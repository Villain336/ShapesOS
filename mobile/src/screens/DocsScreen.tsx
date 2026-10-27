// ShapesOS mobile - Office docs. List, open, and edit plain-text documents.
// Anything richer opens read-only with the reason (see src/api/docs.ts), and
// a save that hits a newer version is refused, never forced.

import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { useSession } from "../session-context";
import {
  DocConflictError,
  fetchDoc,
  fetchDocs,
  plainText,
  previewText,
  readPlainDoc,
  rebuildPlainDoc,
  saveDocSnapshot,
  type DocListItem,
  type DocRecord,
} from "../api/docs";
import { color, font, radius } from "../theme";

export function DocsScreen() {
  const { gate } = useSession();
  const opts = { baseUrl: gate.baseUrl, authHeaders: gate.authHeaders };
  const [list, setList] = useState<DocListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await fetchDocs({ baseUrl: gate.baseUrl, authHeaders: gate.authHeaders }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load documents.");
    }
  }, [gate]);
  useEffect(() => {
    void load();
  }, [load]);

  if (openId) return <DocEditor id={openId} opts={opts} onClose={() => { setOpenId(null); void load(); }} />;
  if (!list && !error) return <View style={styles.center}><ActivityIndicator color={color.ink} /></View>;
  return (
    <ScrollView contentContainerStyle={styles.content}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {list?.map((d) => (
        <TouchableOpacity key={d.id} style={styles.row} onPress={() => setOpenId(d.id)} accessibilityRole="button" accessibilityLabel={`Open ${d.title}`}>
          <Text style={styles.rowTitle}>{d.title}</Text>
          <Text style={styles.meta}>Updated {new Date(d.updatedAt).toLocaleDateString()}</Text>
        </TouchableOpacity>
      ))}
      {list && list.length === 0 ? <Text style={styles.empty}>No documents yet. Create one on the web.</Text> : null}
    </ScrollView>
  );
}

function DocEditor({ id, opts, onClose }: { id: string; opts: { baseUrl: string; authHeaders: () => Record<string, string> }; onClose: () => void }) {
  const [doc, setDoc] = useState<DocRecord | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);

  const open = useCallback(async () => {
    try {
      const d = await fetchDoc(opts, id);
      setDoc(d);
      const plain = readPlainDoc(d.kind, d.snapshot);
      setText(plain.editable ? plainText(plain.lines) : previewText(d.snapshot));
      setConflict(false);
      setStatus(null);
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : "Couldn't open the document." });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    void open();
  }, [open]);

  if (!doc) {
    return status ? (
      <View style={styles.content}>
        <Text style={styles.error}>{status.text}</Text>
        <TouchableOpacity onPress={onClose} accessibilityRole="button"><Text style={styles.link}>Back</Text></TouchableOpacity>
      </View>
    ) : (
      <View style={styles.center}><ActivityIndicator color={color.ink} /></View>
    );
  }
  const plain = readPlainDoc(doc.kind, doc.snapshot);
  const dirty = plain.editable && text !== plainText(plain.lines);

  async function save() {
    if (!doc || !plain.editable) return;
    setBusy(true);
    setStatus(null);
    try {
      const next = rebuildPlainDoc(doc.snapshot, text);
      const saved = await saveDocSnapshot(opts, doc.id, next, doc.version);
      setDoc({ ...doc, version: saved.version, snapshot: next });
      setStatus({ kind: "ok", text: "Saved." });
    } catch (e) {
      if (e instanceof DocConflictError) setConflict(true);
      setStatus({ kind: "error", text: e instanceof Error ? e.message : "Couldn't save." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <TouchableOpacity onPress={onClose} accessibilityRole="button"><Text style={styles.link}>Back to documents</Text></TouchableOpacity>
      <Text style={styles.title}>{doc.title}</Text>
      {plain.editable ? null : (
        <Text style={styles.notice} accessibilityRole="alert">
          Read-only on the phone. {plain.reason}. Open it on the web to edit.
        </Text>
      )}
      <TextInput
        style={[styles.input, !plain.editable && styles.inputReadonly]}
        multiline
        value={text}
        editable={plain.editable && !conflict}
        onChangeText={setText}
        accessibilityLabel="Document text"
        textAlignVertical="top"
      />
      {status ? <Text style={status.kind === "error" ? styles.error : styles.ok} accessibilityRole={status.kind === "error" ? "alert" : undefined}>{status.text}</Text> : null}
      {conflict ? (
        <View style={styles.row}>
          <Text style={styles.meta}>Your edits are still in the box above. Reloading replaces them with the latest version.</Text>
          <TouchableOpacity style={styles.btn} onPress={() => void open()} accessibilityRole="button"><Text style={styles.btnText}>Reload latest</Text></TouchableOpacity>
        </View>
      ) : plain.editable ? (
        <TouchableOpacity style={[styles.btn, (!dirty || busy) && styles.btnOff]} disabled={!dirty || busy} onPress={() => void save()} accessibilityRole="button">
          <Text style={styles.btnText}>{busy ? "Saving..." : "Save"}</Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  content: { padding: 16, gap: 10 },
  error: { fontSize: font.sm, color: color.failedText },
  ok: { fontSize: font.sm, color: color.muted },
  empty: { fontSize: font.base, color: color.muted, marginTop: 12 },
  row: { backgroundColor: color.paper, borderRadius: radius.sm, padding: 12, gap: 6 },
  rowTitle: { fontSize: font.base, fontWeight: "600", color: color.ink },
  meta: { fontSize: font.xs, color: color.subtle },
  title: { fontSize: font.lg, fontWeight: "700", color: color.ink },
  link: { fontSize: font.sm, color: color.ink, textDecorationLine: "underline" },
  notice: { fontSize: font.sm, color: color.ink, backgroundColor: color.paper, borderRadius: radius.sm, padding: 10 },
  input: { minHeight: 240, backgroundColor: color.paper, borderRadius: radius.sm, padding: 12, fontSize: font.base, color: color.ink },
  inputReadonly: { color: color.muted },
  btn: { alignSelf: "flex-start", backgroundColor: color.ink, borderRadius: radius.pill, paddingVertical: 10, paddingHorizontal: 18 },
  btnOff: { opacity: 0.4 },
  btnText: { color: color.paper, fontSize: font.sm, fontWeight: "600" },
});
