import { NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-limit";
import { ingestTape } from "@/lib/ingest";
import { DESK_DENIED, deskCan } from "@/lib/staff";

export async function POST(request: Request) {
  const caller = await apiCaller(request);
  if (caller.response) return caller.response;
  const user = caller.user;
  if (user.role !== "INSTITUTIONAL_SELLER" && user.role !== "ADMIN") {
    return NextResponse.json({ error: "This key cannot push a tape." }, { status: 403 });
  }
  if (user.role === "ADMIN" && !deskCan(user, "sales")) return NextResponse.json({ error: DESK_DENIED }, { status: 403 });
  if (user.role !== "ADMIN" && user.accountStatus !== "APPROVED") {
    return NextResponse.json({ error: "The account is still in review." }, { status: 403 });
  }
  const body = await request.json().catch(() => null) as { title?: unknown; summary?: unknown; csv?: unknown } | null;
  if (!body?.csv || !body.title) return NextResponse.json({ error: "Send title and csv." }, { status: 400 });
  const result = await ingestTape({ sellerId: user.id, title: body.title, summary: body.summary, csv: body.csv });
  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result, { status: 201 });
}
