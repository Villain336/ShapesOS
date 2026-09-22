// Marketr — M21 Buffer adapter.
//
// LIVE PATH (proven in-repo, M20): delegates to lib/social/buffer.ts
// (createBufferPort — Buffer v1 REST API). A decrypted credential carrying
// an access token (oauth2 access_token, or api_key apiKey as BYO token)
// triggers real calls. Mock is the default when no token is connected.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, mockOk, liveOk, fail } from "../types";
import { createBufferPort } from "@/lib/social/buffer";

function accessToken(credential: DecryptedCredential | null): string | null {
  if (!credential) return null;
  if (credential.kind === "oauth2") {
    const t = credential.payload.access_token;
    return typeof t === "string" && t ? t : null;
  }
  if (credential.kind === "api_key") {
    const k = credential.payload.apiKey;
    return typeof k === "string" && k ? k : null;
  }
  return null;
}

const MOCK_PROFILES = [
  { id: "mock-prof-1", service: "twitter", formattedUsername: "@harbordental (MOCK)", mock: true },
  { id: "mock-prof-2", service: "instagram", formattedUsername: "@harbordental (MOCK)", mock: true },
  { id: "mock-prof-3", service: "facebook", formattedUsername: "Harbor Dental Studio (MOCK)", mock: true },
];

export class BufferAdapter implements ConnectorAdapter {
  readonly key = "buffer";
  readonly displayName = "Buffer";
  readonly authType = "oauth2" as const;
  readonly configSchema = { type: "object", properties: {} };

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "list_profiles",
        description: "List connected social profiles (channels) in the Buffer account.",
        mutating: false,
        argsSchema: { type: "object", properties: {} },
      },
      {
        name: "create_post",
        description: "Publish a post immediately to one Buffer profile.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            profileId: strProp("Buffer profile id (from list_profiles)."),
            text: strProp("Post text."),
            link: strProp("Optional link attachment."),
            photo: strProp("Optional public image URL."),
          },
          required: ["profileId", "text"],
        },
      },
      {
        name: "schedule_post",
        description: "Schedule a post for a future time (ISO 8601) on one Buffer profile.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            profileId: strProp("Buffer profile id (from list_profiles)."),
            text: strProp("Post text."),
            scheduledAt: strProp("ISO 8601 timestamp."),
            link: strProp("Optional link attachment."),
            photo: strProp("Optional public image URL."),
          },
          required: ["profileId", "text", "scheduledAt"],
        },
      },
      {
        name: "get_post",
        description: "Fetch a post's status (pending / sent).",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { updateId: strProp("Buffer update id.") },
          required: ["updateId"],
        },
      },
      {
        name: "delete_post",
        description: "Delete (cancel) a pending scheduled post.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: { updateId: strProp("Buffer update id.") },
          required: ["updateId"],
        },
      },
    ];
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    _ctx: InvokeContext,
  ): Promise<InvokeResult> {
    const token = accessToken(credential);
    if (!token) return this.invokeMock(tool, args);
    try {
      const port = createBufferPort(token);
      switch (tool) {
        case "list_profiles":
          return liveOk(await port.listProfiles());
        case "create_post":
          return liveOk(
            await port.createUpdate(String(args.profileId), {
              text: String(args.text),
              now: true,
              ...(args.link ? { link: String(args.link) } : {}),
              ...(args.photo ? { photo: String(args.photo) } : {}),
            }),
          );
        case "schedule_post":
          return liveOk(
            await port.createUpdate(String(args.profileId), {
              text: String(args.text),
              scheduledAt: String(args.scheduledAt),
              ...(args.link ? { link: String(args.link) } : {}),
              ...(args.photo ? { photo: String(args.photo) } : {}),
            }),
          );
        case "get_post":
          return liveOk(await port.getUpdate(String(args.updateId)));
        case "delete_post":
          await port.deleteUpdate(String(args.updateId));
          return liveOk({ ok: true, updateId: args.updateId });
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  private invokeMock(tool: string, args: Record<string, unknown>): InvokeResult {
    switch (tool) {
      case "list_profiles":
        return mockOk(MOCK_PROFILES);
      case "create_post":
        return mockOk({
          id: "mock-update-1",
          profileId: args.profileId,
          status: "sent",
          text: `${String(args.text)} (MOCK)`,
          mock: true,
        });
      case "schedule_post":
        return mockOk({
          id: "mock-update-2",
          profileId: args.profileId,
          status: "pending",
          scheduledAt: args.scheduledAt,
          text: `${String(args.text)} (MOCK)`,
          mock: true,
        });
      case "get_post":
        return mockOk({ id: args.updateId, profileId: "mock-prof-1", status: "sent", mock: true });
      case "delete_post":
        return mockOk({ ok: true, updateId: args.updateId, mock: true });
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
