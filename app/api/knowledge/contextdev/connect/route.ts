// Marketr — Wave 2 context.dev slice 1: connect API.
// POST /api/knowledge/contextdev/connect — validate the tenant's Context.dev
// API key (1-credit scrape) and store it in the vault. Never echoes the key.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import {
  storeContextDevKey,
  validateContextDevKey,
  ContextDevKeyError,
} from "@/lib/knowledge/contextdev/keys";
import { ContextDevError } from "@/lib/knowledge/contextdev/client";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const apiKey = (body.apiKey ?? "").trim();
  if (!apiKey) {
    return NextResponse.json({ error: "API key must not be empty", code: "EMPTY_KEY" }, { status: 400 });
  }

  try {
    const valid = await validateContextDevKey(apiKey);
    if (!valid) {
      return NextResponse.json(
        { error: "Context.dev rejected the API key", code: "INVALID_KEY" },
        { status: 401 },
      );
    }
  } catch (err) {
    if (err instanceof ContextDevError && err.code === "RATE_LIMITED") {
      return NextResponse.json(
        { error: "Context.dev rate limit hit — try again shortly", code: "RATE_LIMITED" },
        { status: 429 },
      );
    }
    return NextResponse.json(
      { error: "Could not reach Context.dev to validate the key", code: "VALIDATION_UNREACHABLE" },
      { status: 502 },
    );
  }

  try {
    const { connectionId } = await storeContextDevKey(user.id, workspace.id, apiKey);
    return NextResponse.json({ ok: true, connectionId });
  } catch (err) {
    if (err instanceof ContextDevKeyError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    throw err;
  }
}
