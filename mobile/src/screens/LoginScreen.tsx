// Marketr mobile — sign-in screen.
//
// Authenticates through the web app's existing Credentials provider
// (src/auth/session.ts) — no new server auth infrastructure.

import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSession } from "../session-context";
import { AuthError } from "../auth/session";

export function LoginScreen() {
  const { session, baseUrl, refreshSignedIn } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    setError(null);
    setBusy(true);
    try {
      await session.login(baseUrl, email, password);
      refreshSignedIn();
    } catch (err) {
      setError(err instanceof AuthError ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.root}
    >
      <View style={styles.card}>
        <Text style={styles.title}>Marketr Agent</Text>
        <Text style={styles.subtitle}>Sign in with your Marketr account</Text>
        <Text style={styles.server}>Server: {baseUrl}</Text>
        <TextInput
          style={styles.input}
          placeholder="Email"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
          editable={!busy}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          editable={!busy}
          onSubmitEditing={() => void signIn()}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity style={styles.button} onPress={() => void signIn()} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#FAFAF7", justifyContent: "center", padding: 24 },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 24, borderWidth: 1, borderColor: "#e7e5e4" },
  title: { fontSize: 24, fontWeight: "800", color: "#1c1917", letterSpacing: -0.5 },
  subtitle: { fontSize: 14, color: "#78716c", marginTop: 4, marginBottom: 4 },
  server: { fontSize: 12, color: "#a8a29e", marginBottom: 16 },
  input: { borderWidth: 1, borderColor: "#e7e5e4", borderRadius: 10, padding: 12, fontSize: 15, marginBottom: 12, color: "#1c1917" },
  error: { color: "#b91c1c", fontSize: 13, marginBottom: 12 },
  button: { backgroundColor: "#7c3aed", borderRadius: 10, padding: 14, alignItems: "center" },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
