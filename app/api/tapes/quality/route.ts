import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { parseTapeBuffer } from "@/lib/tape";
import { readTapeDraft } from "@/lib/tape-draft";
import { reviewTape } from "@/lib/tape-quality";
import type { TapeFieldKey } from "@/lib/tape-fields";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || (user.role !== "INSTITUTIONAL_SELLER" && user.role !== "ADMIN")) {
    return NextResponse.json({ error: "Institutional access only." }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as { token?: string; mapping?: Partial<Record<TapeFieldKey, string>> } | null;
  const token = body?.token || "";
  if (!/^[0-9a-f-]{36}$/i.test(token)) return NextResponse.json({ error: "Upload the tape again." }, { status: 400 });
  const draft = await readTapeDraft(user.id, token);
  if (!draft) return NextResponse.json({ error: "That tape expired." }, { status: 400 });
  const matrix = parseTapeBuffer(draft.bytes, draft.filename);
  const flags = reviewTape(matrix.rows, body?.mapping || {});
  return NextResponse.json({
    flags: flags.slice(0, 40),
    errors: flags.filter((flag) => flag.level === "error").length,
    warnings: flags.filter((flag) => flag.level === "warn").length,
    fixes: flags.filter((flag) => flag.level === "fix").length,
  });
}
