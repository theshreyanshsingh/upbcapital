import { NextResponse } from "next/server";
import { getApiUser } from "@/lib/auth";
import { extensionOf } from "@/lib/storage";
import { parseTapeBuffer, suggestMapping } from "@/lib/tape";
import { saveTapeDraft } from "@/lib/tape-draft";
import { reviewTape } from "@/lib/tape-quality";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await getApiUser();
  if (!user || (user.role !== "INSTITUTIONAL_SELLER" && user.role !== "ADMIN")) {
    return NextResponse.json({ error: "Institutional access only." }, { status: 403 });
  }
  if (user.role === "INSTITUTIONAL_SELLER" && user.accountStatus !== "APPROVED") {
    return NextResponse.json({ error: "Your institutional account is still in review." }, { status: 403 });
  }
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Attach a CSV or XLSX tape." }, { status: 400 });
  if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: "Keep the tape under 20 MB." }, { status: 400 });
  const ext = extensionOf(file.name);
  if (ext !== "csv" && ext !== "xlsx" && ext !== "xls") {
    return NextResponse.json({ error: "Use a CSV or Excel file." }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  let matrix;
  try {
    matrix = parseTapeBuffer(buffer, file.name);
  } catch {
    return NextResponse.json({ error: "That file could not be read." }, { status: 400 });
  }
  if (!matrix.headers.length) return NextResponse.json({ error: "The tape has no header row." }, { status: 400 });
  const token = crypto.randomUUID();
  await saveTapeDraft({ token, userId: user.id, filename: file.name, bytes: buffer });
  return NextResponse.json({
    token,
    filename: file.name,
    headers: matrix.headers,
    rowCount: matrix.rows.length,
    preview: matrix.rows.slice(0, 6),
    suggestions: suggestMapping(matrix.headers),
    flags: reviewTape(matrix.rows, suggestMapping(matrix.headers)).slice(0, 40),
  });
}
