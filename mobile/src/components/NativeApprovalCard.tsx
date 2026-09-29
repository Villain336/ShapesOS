// Marketr mobile — NativeApprovalCard.
//
// Native mirror of components/agents/ApprovalCard.tsx (Phase 16 slice 3),
// the FIRST registered generative component. Renders a pending AutopilotItem
// in-flow (the agent emits only { itemId, projectId }; the card loads live
// item data from the gate) with native approve/deny/edit.
//
// Gate law (same as web): Approve/Deny/Edit execute through the Phase 14
// gate's own service functions via the existing API routes — the card never
// reimplements approval logic, and every action writes an audit entry
// server-side.
//
// Risk-tier badge is a PRESENTATIONAL heuristic (kind → tier), not gate
// semantics: decay_refresh = low, keyword_brief = medium,
// programmatic_page = high (publishes a new page to the web).
//
// Brand: violet primary (#7c3aed / #6d28d9), matching the web's
// --brand-600/--brand-700 defaults. Lucide icons only.

import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { AlertTriangle, Check, Pencil, ShieldAlert, ShieldCheck, X } from "lucide-react-native";
import {
  decideGateItem,
  editGateItem,
  fetchGateItem,
  GateApiError,
  type GateClientOptions,
  type GateItem,
  type GateItemKind,
} from "../api/gate";

export interface NativeApprovalCardProps {
  /** AutopilotItem id (the agent emits this; never agent-invented content). */
  itemId: string;
  /** Project the item belongs to. */
  projectId: string;
  /** Gate client options (baseUrl + session-cookie auth headers). */
  gate: GateClientOptions;
  /** Called after a decision lands (approve/deny/edit). */
  onResolved?: (decision: "approved" | "denied" | "edited", itemId: string) => void;
}

type RiskTier = "low" | "medium" | "high";

const RISK_BY_KIND: Record<GateItemKind, { tier: RiskTier; label: string }> = {
  decay_refresh: { tier: "low", label: "Low risk" },
  keyword_brief: { tier: "medium", label: "Medium risk" },
  programmatic_page: { tier: "high", label: "High risk" },
};

const KIND_LABEL: Record<GateItemKind, string> = {
  decay_refresh: "Content refresh",
  programmatic_page: "New page",
  keyword_brief: "Keyword brief",
};

const TIER_STYLE: Record<RiskTier, { badge: object; text: object; iconColor: string; Icon: typeof ShieldCheck }> = {
  low: { badge: { backgroundColor: "#f5f5f4", borderColor: "#e7e5e4" }, text: { color: "#57534e" }, iconColor: "#57534e", Icon: ShieldCheck },
  medium: { badge: { backgroundColor: "#fffbeb", borderColor: "#fde68a" }, text: { color: "#92400e" }, iconColor: "#92400e", Icon: AlertTriangle },
  high: { badge: { backgroundColor: "#fff1f2", borderColor: "#fecdd3" }, text: { color: "#9f1239" }, iconColor: "#9f1239", Icon: ShieldAlert },
};

type CardPhase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready" }
  | { kind: "editing" }
  | { kind: "working"; label: string }
  | { kind: "done"; decision: "approved" | "denied" | "edited"; message: string };

export function NativeApprovalCard({ itemId, projectId, gate, onResolved }: NativeApprovalCardProps) {
  const [item, setItem] = useState<GateItem | null>(null);
  const [phase, setPhase] = useState<CardPhase>({ kind: "loading" });
  const [editTitle, setEditTitle] = useState("");
  const [editDraft, setEditDraft] = useState("");

  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const loaded = await fetchGateItem(gate, itemId, projectId);
      setItem(loaded);
      setEditTitle(loaded.title);
      setEditDraft(loaded.draftMarkdown ?? "");
      setPhase({ kind: "ready" });
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof GateApiError ? `(${err.status}) ${err.message}` : "Failed to load approval item",
      });
    }
  }, [gate, itemId, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (decision: "approved" | "denied") => {
      setPhase({ kind: "working", label: decision === "approved" ? "Approving…" : "Denying…" });
      try {
        await decideGateItem(gate, itemId, projectId, decision === "approved" ? "approve" : "reject");
        setPhase({
          kind: "done",
          decision,
          message: decision === "approved" ? "Approved — the gate is executing it." : "Denied — the item was rejected.",
        });
        onResolved?.(decision, itemId);
      } catch (err) {
        setPhase({
          kind: "error",
          message: err instanceof GateApiError ? `(${err.status}) ${err.message}` : "Decision failed",
        });
      }
    },
    [gate, itemId, projectId, onResolved],
  );

  const saveEdit = useCallback(async () => {
    setPhase({ kind: "working", label: "Saving edit…" });
    try {
      await editGateItem(gate, itemId, projectId, { title: editTitle, draftMarkdown: editDraft });
      // Edit-then-requeue-pending: reload the live item; it still needs approval.
      const loaded = await fetchGateItem(gate, itemId, projectId);
      setItem(loaded);
      setPhase({ kind: "done", decision: "edited", message: "Edit saved — the item is still pending approval." });
      onResolved?.("edited", itemId);
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof GateApiError ? `(${err.status}) ${err.message}` : "Edit failed",
      });
    }
  }, [gate, itemId, projectId, editTitle, editDraft, onResolved]);

  if (phase.kind === "loading") {
    return (
      <View style={styles.card} testID="approval-card-loading">
        <ActivityIndicator color="#7c3aed" />
        <Text style={styles.muted}>Loading approval…</Text>
      </View>
    );
  }

  if (phase.kind === "error") {
    return (
      <View style={styles.card} testID="approval-card-error">
        <Text style={styles.errorTitle}>Couldn't load this approval</Text>
        <Text style={styles.muted}>{phase.message}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => void load()}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!item) return null;
  const risk = RISK_BY_KIND[item.kind];
  const tier = TIER_STYLE[risk.tier];
  const TierIcon = tier.Icon;

  return (
    <View style={styles.card} testID="approval-card">
      <View style={styles.headerRow}>
        <Text style={styles.kindLabel}>{KIND_LABEL[item.kind]}</Text>
        <View style={[styles.tierBadge, tier.badge]}>
          <TierIcon size={12} color={tier.iconColor} />
          <Text style={[styles.tierBadgeText, tier.text]}>{risk.label}</Text>
        </View>
      </View>

      <Text style={styles.title}>{item.title}</Text>
      {item.reviewNote ? <Text style={styles.reviewNote}>{item.reviewNote}</Text> : null}
      <Text style={styles.meta}>
        {item.rule.name} · {new Date(item.createdAt).toLocaleString()}
      </Text>

      {phase.kind === "editing" ? (
        <View style={styles.editBlock}>
          <Text style={styles.fieldLabel}>Title</Text>
          <TextInput style={styles.input} value={editTitle} onChangeText={setEditTitle} />
          <Text style={styles.fieldLabel}>Draft</Text>
          <TextInput
            style={[styles.input, styles.draftInput]}
            value={editDraft}
            onChangeText={setEditDraft}
            multiline
          />
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, styles.primaryButton]}
              onPress={() => void saveEdit()}
            >
              <Check size={16} color="#fff" />
              <Text style={styles.primaryButtonText}>Save edit</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, styles.ghostButton]} onPress={() => setPhase({ kind: "ready" })}>
              <Text style={styles.ghostButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : phase.kind === "done" ? (
        <View style={styles.doneBlock}>
          <Check size={16} color="#15803d" />
          <Text style={styles.doneText}>{phase.message}</Text>
        </View>
      ) : (
        <>
          {item.draftMarkdown ? (
            <Text style={styles.draftPreview} numberOfLines={6}>
              {item.draftMarkdown}
            </Text>
          ) : null}
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, styles.primaryButton]}
              onPress={() => void decide("approved")}
              disabled={phase.kind === "working"}
            >
              {phase.kind === "working" ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Check size={16} color="#fff" />
              )}
              <Text style={styles.primaryButtonText}>Approve</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.dangerButton]}
              onPress={() => void decide("denied")}
              disabled={phase.kind === "working"}
            >
              <X size={16} color="#b91c1c" />
              <Text style={styles.dangerButtonText}>Deny</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.button, styles.ghostButton]} onPress={() => setPhase({ kind: "editing" })}>
              <Pencil size={16} color="#44403c" />
              <Text style={styles.ghostButtonText}>Edit</Text>
            </TouchableOpacity>
          </View>
          {phase.kind === "working" ? <Text style={styles.muted}>{phase.label}</Text> : null}
        </>
      )}
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
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  kindLabel: { fontSize: 12, fontWeight: "600", color: "#78716c", textTransform: "uppercase", letterSpacing: 0.5 },
  tierBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  tierBadgeText: { fontSize: 11, fontWeight: "600" },
  title: { fontSize: 16, fontWeight: "700", color: "#1c1917", marginBottom: 4 },
  reviewNote: { fontSize: 13, color: "#57534e", fontStyle: "italic", marginBottom: 4 },
  meta: { fontSize: 12, color: "#a8a29e", marginBottom: 8 },
  draftPreview: { fontSize: 13, color: "#44403c", backgroundColor: "#fafaf9", borderRadius: 8, padding: 10, marginBottom: 10 },
  buttonRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  button: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, flex: 1 },
  primaryButton: { backgroundColor: "#7c3aed" },
  primaryButtonText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  dangerButton: { backgroundColor: "#fef2f2", borderWidth: 1, borderColor: "#fecaca" },
  dangerButtonText: { color: "#b91c1c", fontWeight: "600", fontSize: 14 },
  ghostButton: { backgroundColor: "#f5f5f4" },
  ghostButtonText: { color: "#44403c", fontWeight: "600", fontSize: 14 },
  doneBlock: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#f0fdf4", borderRadius: 8, padding: 10 },
  doneText: { fontSize: 13, color: "#15803d", flex: 1 },
  editBlock: { marginTop: 4 },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: "#57534e", marginBottom: 4, marginTop: 8 },
  input: { borderWidth: 1, borderColor: "#e7e5e4", borderRadius: 8, padding: 10, fontSize: 14, color: "#1c1917", backgroundColor: "#fff" },
  draftInput: { minHeight: 120, textAlignVertical: "top" },
  muted: { fontSize: 13, color: "#a8a29e", marginTop: 6 },
  errorTitle: { fontSize: 14, fontWeight: "700", color: "#b91c1c", marginBottom: 4 },
  retryButton: { marginTop: 10, alignSelf: "flex-start", backgroundColor: "#f5f5f4", borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14 },
  retryText: { color: "#44403c", fontWeight: "600", fontSize: 13 },
});
