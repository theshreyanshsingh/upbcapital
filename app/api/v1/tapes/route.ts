import { NextResponse } from "next/server";
import { userForApiKey } from "@/lib/api-keys";
import { ingestTape } from "@/lib/ingest";

export async function POST(request: Request) {
  const user = await userForApiKey(request.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unknown API key." }, { status: 401 });
  if (user.role !== "INSTITUTIONAL_SELLER" && user.role !== "ADMIN") {
    return NextResponse.json({ error: "This key cannot push a tape." }, { status: 403 });
  }
  if (user.role !== "ADMIN" && user.accountStatus !== "APPROVED") {
    return NextResponse.json({ error: "The account is still in review." }, { status: 403 });
  }
  const body = await request.json().catch(() => null) as { title?: string; summary?: string; csv?: string } | null;
  if (!body?.csv || !body.title) return NextResponse.json({ error: "Send title and csv." }, { status: 400 });
  const result = await ingestTape({ sellerId: user.id, title: body.title, summary: body.summary, csv: body.csv });
  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result, { status: 201 });
}
