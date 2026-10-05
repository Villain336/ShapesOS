// ShapesOS mobile — sign-in screen.
//
// Three steps, all through the web app's own Auth.js endpoints
// (src/auth/session.ts) — no separate mobile auth:
//   server    which ShapesOS server to use (self-hosted installs change it)
//   password  email + password
//   code      the Phase 4a second factor: a 6-digit authenticator code or a
//             recovery code, when the account has two-step sign-in on

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
import { color, CONTROL_HEIGHT, font, radius } from "../theme";

type Step = "password" | "code" | "server";

export function LoginScreen() {
  const { session, baseUrl, defaultBaseUrl, customServer, refreshSignedIn, setServer } = useSession();
  const [step, setStep] = useState<Step>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [server, setServerInput] = useState(baseUrl);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof AuthError ? err.message : "Sign-in failed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const signIn = () =>
    run(async () => {
      const res = await session.login(baseUrl, email, password);
      setPassword("");
      if (res.status === "two_factor") {
        setCode("");
        setUseRecovery(false);
        setStep("code");
        return;
      }
      refreshSignedIn();
    });

  const verify = () =>
    run(async () => {
      try {
        await session.completeTwoFactor(code);
      } catch (e) {
        if (e instanceof AuthError && e.code === "expired") setStep("password");
        throw e;
      }
      refreshSignedIn();
    });

  const saveServer = (value: string | null) =>
    run(async () => {
      const res = await setServer(value);
      if (!res.ok) throw new AuthError(res.error);
      setStep("password");
    });

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.root}>
      <View style={styles.card}>
        <Text style={styles.brand} accessibilityRole="header">
          ShapesOS
        </Text>

        {step === "password" ? (
          <>
            <Text style={styles.subtitle}>Sign in to your workspace</Text>
            <TouchableOpacity onPress={() => { setServerInput(baseUrl); setError(null); setStep("server"); }} accessibilityRole="button" accessibilityLabel={`Server ${baseUrl}. Change server`}>
              <Text style={styles.server}>
                Server: {baseUrl} <Text style={styles.link}>Change</Text>
              </Text>
            </TouchableOpacity>
            <TextInput
              style={styles.input}
              placeholder="Email"
              placeholderTextColor={color.subtle}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
              editable={!busy}
            />
            <TextInput
              style={styles.input}
              placeholder="Password"
              placeholderTextColor={color.subtle}
              secureTextEntry
              autoComplete="password"
              value={password}
              onChangeText={setPassword}
              editable={!busy}
              onSubmitEditing={() => void signIn()}
            />
            {error ? <ErrorText text={error} /> : null}
            <PrimaryButton label={busy ? "Signing in" : "Sign in"} busy={busy} onPress={() => void signIn()} disabled={!email.trim() || !password} />
          </>
        ) : null}

        {step === "code" ? (
          <>
            <Text style={styles.subtitle}>Two-step sign-in</Text>
            <Text style={styles.help}>
              {useRecovery
                ? "Enter one of the recovery codes you saved when you turned on two-step sign-in. Each code works once."
                : "Enter the 6-digit code from your authenticator app."}
            </Text>
            <TextInput
              style={[styles.input, !useRecovery && styles.codeInput]}
              placeholder={useRecovery ? "xxxxx-xxxxx" : "123456"}
              placeholderTextColor={color.subtle}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete={useRecovery ? "off" : "one-time-code"}
              textContentType={useRecovery ? "none" : "oneTimeCode"}
              keyboardType={useRecovery ? "default" : "number-pad"}
              maxLength={useRecovery ? 32 : 6}
              value={code}
              onChangeText={setCode}
              editable={!busy}
              autoFocus
              onSubmitEditing={() => void verify()}
              accessibilityLabel={useRecovery ? "Recovery code" : "Authenticator code"}
            />
            {error ? <ErrorText text={error} /> : null}
            <PrimaryButton label={busy ? "Verifying" : "Verify"} busy={busy} onPress={() => void verify()} disabled={!code.trim()} />
            <TouchableOpacity style={styles.quiet} onPress={() => { setUseRecovery((v) => !v); setCode(""); setError(null); }} accessibilityRole="button">
              <Text style={styles.link}>{useRecovery ? "Use an authenticator code" : "Use a recovery code"}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.quiet}
              onPress={() => {
                session.cancelTwoFactor();
                setError(null);
                setStep("password");
              }}
              accessibilityRole="button"
            >
              <Text style={styles.quietText}>Back to sign in</Text>
            </TouchableOpacity>
          </>
        ) : null}

        {step === "server" ? (
          <>
            <Text style={styles.subtitle}>Server</Text>
            <Text style={styles.help}>
              Self-hosting ShapesOS? Enter your server's address. Use https:// for servers on the internet.
            </Text>
            <TextInput
              style={styles.input}
              placeholder="https://shapes.example.com"
              placeholderTextColor={color.subtle}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              value={server}
              onChangeText={setServerInput}
              editable={!busy}
              onSubmitEditing={() => void saveServer(server)}
              accessibilityLabel="Server address"
            />
            {error ? <ErrorText text={error} /> : null}
            <PrimaryButton label={busy ? "Checking" : "Use this server"} busy={busy} onPress={() => void saveServer(server)} disabled={!server.trim()} />
            {customServer ? (
              <TouchableOpacity style={styles.quiet} onPress={() => void saveServer(null)} accessibilityRole="button">
                <Text style={styles.link}>Use the default server ({defaultBaseUrl})</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={styles.quiet} onPress={() => { setError(null); setStep("password"); }} accessibilityRole="button">
              <Text style={styles.quietText}>Cancel</Text>
            </TouchableOpacity>
          </>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

function ErrorText({ text }: { text: string }) {
  return (
    <View style={styles.errorRow} accessibilityLiveRegion="polite">
      <View style={styles.errorMark} />
      <Text style={styles.error}>{text}</Text>
    </View>
  );
}

function PrimaryButton({ label, busy, onPress, disabled }: { label: string; busy: boolean; onPress: () => void; disabled?: boolean }) {
  const off = busy || disabled;
  return (
    <TouchableOpacity
      style={[styles.button, disabled && !busy && styles.buttonDisabled]}
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
    >
      {busy ? <ActivityIndicator color={color.paper} style={styles.spinner} /> : null}
      <Text style={[styles.buttonText, off && !busy && styles.buttonTextDisabled]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.canvas, justifyContent: "center", padding: 24 },
  card: { backgroundColor: color.paper, borderRadius: radius.lg, padding: 24, borderWidth: 1, borderColor: color.line },
  brand: { fontSize: 28, fontWeight: "800", color: color.ink, letterSpacing: -0.4 },
  subtitle: { fontSize: font.lg, fontWeight: "700", color: color.ink, marginTop: 12, marginBottom: 4 },
  help: { fontSize: font.md, color: color.muted, marginBottom: 12, lineHeight: 20 },
  server: { fontSize: font.sm, color: color.muted, marginBottom: 16 },
  link: { color: color.ink, fontWeight: "600", textDecorationLine: "underline" },
  input: {
    minHeight: CONTROL_HEIGHT,
    borderWidth: 1.5,
    borderColor: color.control,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    fontSize: font.base,
    marginBottom: 12,
    color: color.ink,
    backgroundColor: color.paper,
  },
  codeInput: { fontSize: 22, letterSpacing: 6, textAlign: "center" },
  errorRow: { flexDirection: "row", alignItems: "center", marginBottom: 12, gap: 6 },
  errorMark: { width: 8, height: 8, backgroundColor: color.failed },
  error: { flex: 1, color: color.failedText, fontSize: font.sm },
  button: {
    minHeight: CONTROL_HEIGHT,
    backgroundColor: color.ink,
    borderRadius: radius.pill,
    paddingHorizontal: 22,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: { backgroundColor: color.disabledBg },
  buttonText: { color: color.paper, fontWeight: "600", fontSize: font.base },
  buttonTextDisabled: { color: color.disabledFg },
  spinner: { marginRight: 8 },
  quiet: { alignItems: "center", paddingVertical: 12 },
  quietText: { color: color.muted, fontWeight: "600", fontSize: font.md },
});
