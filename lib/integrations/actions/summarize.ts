// Marketr — Phase 14: plain-language action summaries (spec §3).
//
// The approval queue shows WHAT WILL HAPPEN in plain language — never raw
// JSON. Templates per v1 tool slug, generic fallback for anything else.

function s(v: unknown): string {
  if (v === undefined || v === null) return "—";
  if (Array.isArray(v)) return v.map(String).join(", ");
  return String(v);
}

const TEMPLATES: Record<string, (a: Record<string, unknown>) => string> = {
  GMAIL_SEND_EMAIL: (a) =>
    `Send an email to ${s(a.to ?? a.recipients)} with subject “${s(a.subject)}”.`,
  GMAIL_REPLY_TO_THREAD: (a) =>
    `Reply in the email thread ${s(a.threadId ?? a.thread_id)}${a.subject ? ` (“${s(a.subject)}”)` : ""}.`,
  GMAIL_CREATE_DRAFT: (a) =>
    `Create an email draft${a.to ? ` to ${s(a.to)}` : ""}${a.subject ? ` with subject “${s(a.subject)}”` : ""}. Nothing is sent until you send it.`,
  GMAIL_DELETE_MESSAGE: (a) => `Permanently delete the email ${s(a.messageId ?? a.id)}.`,
  GMAIL_TRASH_MESSAGE: (a) => `Move the email ${s(a.messageId ?? a.id)} to trash.`,
  GOOGLE_SHEETS_UPDATE_VALUES: (a) =>
    `Update cells in spreadsheet ${s(a.spreadsheetId ?? a.spreadsheet_id)}${a.range ? ` (range ${s(a.range)})` : ""}.`,
  GOOGLE_SHEETS_APPEND_VALUES: (a) =>
    `Append ${Array.isArray(a.values) ? a.values.length : "new"} row(s) to spreadsheet ${s(a.spreadsheetId ?? a.spreadsheet_id)}.`,
  GOOGLE_SHEETS_CREATE_SPREADSHEET: (a) =>
    `Create a new spreadsheet${a.title ? ` titled “${s(a.title)}”` : ""}.`,
  SLACK_SEND_MESSAGE: (a) =>
    `Send a Slack message to ${s(a.channel ?? a.channelId)}: “${s(a.text).slice(0, 120)}”.`,
  SLACK_POST_MESSAGE: (a) =>
    `Post a Slack message to ${s(a.channel ?? a.channelId)}: “${s(a.text).slice(0, 120)}”.`,
  SLACK_DELETE_MESSAGE: (a) =>
    `Delete the Slack message ${s(a.ts ?? a.messageId)} in ${s(a.channel)}.`,
  HUBSPOT_CREATE_CONTACT: (a) =>
    `Create a HubSpot contact${a.email ? ` (${s(a.email)})` : ""}.`,
  HUBSPOT_UPDATE_CONTACT: (a) =>
    `Update HubSpot contact ${s(a.contactId ?? a.id)}${a.email ? ` (${s(a.email)})` : ""}.`,
  HUBSPOT_CREATE_DEAL: (a) =>
    `Create a HubSpot deal${a.dealname ? ` (“${s(a.dealname)}”)` : ""}.`,
  HUBSPOT_DELETE_CONTACT: (a) => `Delete HubSpot contact ${s(a.contactId ?? a.id)}.`,
  HUBSPOT_ARCHIVE_CONTACT: (a) => `Archive HubSpot contact ${s(a.contactId ?? a.id)}.`,
  NOTION_CREATE_PAGE: (a) =>
    `Create a Notion page${a.title ? ` titled “${s(a.title)}”` : ""} as a private draft.`,
  NOTION_UPDATE_PAGE: (a) => `Update Notion page ${s(a.pageId ?? a.page_id)}.`,
  NOTION_DELETE_PAGE: (a) => `Delete Notion page ${s(a.pageId ?? a.page_id)}.`,
  NOTION_ARCHIVE_PAGE: (a) => `Archive Notion page ${s(a.pageId ?? a.page_id)}.`,
};

/** Build the plain-language summary. Falls back to a generic sentence. */
export function summarizeAction(
  appKey: string,
  toolName: string,
  args: Record<string, unknown>,
): string {
  const upper = toolName.toUpperCase();
  const fn = TEMPLATES[upper];
  if (fn) return fn(args);
  const keys = Object.keys(args);
  const appLabel = appKey.replace(/-/g, " ");
  return `${toolName} on ${appLabel}${keys.length ? ` with ${keys.length} parameter${keys.length === 1 ? "" : "s"} (${keys.slice(0, 3).join(", ")})` : ""}.`;
}
