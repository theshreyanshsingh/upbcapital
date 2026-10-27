import { NextResponse } from "next/server";
import { runJobs } from "@/lib/jobs";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runJobs();
  return NextResponse.json(result);
}

export const POST = GET;
