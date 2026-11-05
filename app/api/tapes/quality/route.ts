import { NextResponse } from "next/server";
import { getApiUser } from "@/lib/auth";
import { parseTapeBuffer } from "@/lib/tape";
import { readTapeDraft } from "@/lib/tape-draft";
import { flagSummary, reviewTape } from "@/lib/tape-quality";
import type { TapeFieldKey } from "@/lib/tape-fields";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getApiUser();
  if (!user || (user.role !== "INSTITUTIONAL_SELLER" && user.role !== "ADMIN")) {
    return NextResponse.json({ error: "Institutional access only." }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as { token?: string; mapping?: Partial<Record<TapeFieldKey, string>> } | null;
  const token = body?.token || "";
  if (!/^[0-9a-f-]{36}$/i.test(token)) return NextResponse.json({ error: "Upload the tape again." }, { status: 400 });
  const draft = await readTapeDraft(user.id, token);
  if (!draft) return NextResponse.json({ error: "That tape expired." }, { status: 400 });
  const matrix = parseTapeBuffer(draft.bytes, draft.filename);
  const summary = flagSummary(reviewTape(matrix.rows, body?.mapping || {}));
  return NextResponse.json({
    flags: summary.flags,
    errors: summary.errors,
    warnings: summary.warnings,
    fixes: summary.fixes,
    counts: { errors: summary.errors, warnings: summary.warnings, fixes: summary.fixes },
  });
}
