import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseKycWebhook } from "@/lib/vendors";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.KYC_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "KYC webhook secret is not set." }, { status: 400 });
  if (request.headers.get("x-kyc-secret") !== secret) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const parsed = parseKycWebhook(body);
  if (!parsed) return NextResponse.json({ error: "Unrecognized payload." }, { status: 400 });
  const profile = parsed.userId
    ? await prisma.buyerProfile.findUnique({ where: { userId: parsed.userId } })
    : await prisma.buyerProfile.findFirst({ where: { vendorRef: parsed.reference } });
  if (!profile) return NextResponse.json({ ok: true, matched: false });
  await prisma.buyerProfile.update({
    where: { userId: profile.userId },
    data: {
      status: parsed.status,
      vendorRef: parsed.reference || profile.vendorRef,
      reviewedAt: parsed.status === "SUBMITTED" ? profile.reviewedAt : new Date(),
    },
  });
  return NextResponse.json({ ok: true });
}
