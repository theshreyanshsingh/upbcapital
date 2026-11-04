import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runJobs } from "@/lib/jobs";

export const runtime = "nodejs";

function authorized(header: string | null, secret: string) {
  const given = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !authorized(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runJobs();
  // The run record is written either way; a failed job still shows as a failed cron call.
  return NextResponse.json(result, { status: result.failed.length ? 500 : 200 });
}

export const POST = GET;
