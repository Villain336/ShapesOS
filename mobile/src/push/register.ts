// ShapesOS mobile — Expo push registration (device side).
//
// After sign-in: ask for notification permission, get this install's Expo
// push token, and register it with the server (POST /api/mobile/push-devices).
// On sign-out: unregister it so the server stops pushing to this device.
//
// getExpoPushTokenAsync needs the EAS project id (app.config.ts →
// extra.eas.projectId, from EAS_PROJECT_ID at build time). Without it, or on
// a simulator, registration is skipped with a reason — never a crash.

import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { registerPushDevice, removePushDevice, type PushClientOptions } from "./push-client";

export type PushRegistration =
  | { status: "registered"; token: string; serverSending: boolean }
  | { status: "skipped"; reason: string };

const TOKEN_KEY = "shapesos.pushToken.v1";

async function secureStore() {
  try {
    return await import("expo-secure-store");
  } catch {
    return null;
  }
}

export async function rememberedPushToken(): Promise<string | null> {
  const s = await secureStore();
  try {
    return s ? await s.getItemAsync(TOKEN_KEY) : null;
  } catch {
    return null;
  }
}

/** Show pushes while the app is open too (banner + list, no badge). */
export function configureForegroundHandling(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

export async function registerForPush(opts: PushClientOptions): Promise<PushRegistration> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return { status: "skipped", reason: "Push needs iOS or Android." };
  if (!Device.isDevice) return { status: "skipped", reason: "Push notifications need a physical device." };

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "ShapesOS",
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return { status: "skipped", reason: "Notifications are turned off for ShapesOS in system settings." };

  const projectId =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
    Constants.easConfig?.projectId;
  if (!projectId) return { status: "skipped", reason: "This build has no EAS project id (set EAS_PROJECT_ID)." };

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  const res = await registerPushDevice(opts, {
    token,
    platform: Platform.OS,
    deviceName: Device.deviceName ?? Device.modelName ?? null,
  });
  const s = await secureStore();
  await s?.setItemAsync(TOKEN_KEY, token).catch(() => {});
  return { status: "registered", token, serverSending: res.pushEnabled };
}

/** Best-effort: forget this device on the server (sign-out). */
export async function unregisterPush(opts: PushClientOptions): Promise<void> {
  const token = await rememberedPushToken();
  if (!token) return;
  try {
    await removePushDevice(opts, token);
  } catch {
    // signed out already / offline — the server prunes dead tokens anyway
  }
  const s = await secureStore();
  await s?.deleteItemAsync(TOKEN_KEY).catch(() => {});
}
