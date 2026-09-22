// Marketr — M21 Resend adapter.
//
// LIVE PATH (proven in-repo, M19): delegates to lib/newsletter/resend.ts
// (createResendPort — the Resend SDK). A decrypted api_key credential
// triggers real calls. Mock is the default when no key is connected.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, mockOk, liveOk, fail } from "../types";
import { createResendPort } from "@/lib/newsletter/resend";

function apiKey(credential: DecryptedCredential | null): string | null {
  if (!credential || credential.kind !== "api_key") return null;
  const k = credential.payload.apiKey;
  return typeof k === "string" && k ? k : null;
}

export class ResendAdapter implements ConnectorAdapter {
  readonly key = "resend";
  readonly displayName = "Resend";
  readonly authType = "api_key" as const;
  readonly configSchema = {
    type: "object",
    properties: {
      defaultFrom: {
        type: "string",
        description: "Default From address for test sends, e.g. hello@example.com.",
      },
    },
  };

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "send_test_email",
        description: "Send a single test email (Resend emails.send).",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            from: strProp("From address."),
            to: strProp("Recipient email."),
            subject: strProp("Subject."),
            html: strProp("HTML body."),
          },
          required: ["from", "to", "subject", "html"],
        },
      },
      {
        name: "get_domain",
        description: "Check a Resend sending domain's verification status and DNS records.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { domainId: strProp("Resend domain id.") },
          required: ["domainId"],
        },
      },
    ];
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    const key = apiKey(credential);
    if (!key) return this.invokeMock(tool, args, ctx);
    try {
      const port = createResendPort(key);
      switch (tool) {
        case "send_test_email":
          return liveOk(
            await port.sendEmail({
              from: String(args.from),
              to: String(args.to),
              subject: String(args.subject),
              html: String(args.html),
            }),
          );
        case "get_domain":
          return liveOk(await port.getDomain(String(args.domainId)));
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  private invokeMock(
    tool: string,
    args: Record<string, unknown>,
    ctx: InvokeContext,
  ): InvokeResult {
    switch (tool) {
      case "send_test_email": {
        const from =
          (args.from as string | undefined) ??
          (ctx.projectConfig?.defaultFrom as string | undefined) ??
          "hello@demo-site.local";
        return mockOk({
          id: "mock_email_1",
          from,
          to: args.to,
          subject: `${String(args.subject)} (MOCK)`,
          mock: true,
        });
      }
      case "get_domain":
        return mockOk({
          id: args.domainId,
          status: "pending",
          records: [
            { name: "send.demo-site.local", type: "MX", value: "feedback-smtp.resend.com", purpose: "receiving", mock: true },
            { name: "resend._domainkey", type: "TXT", value: "p=MOCKDKIMKEY", purpose: "dkim", mock: true },
          ],
          mock: true,
        });
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
