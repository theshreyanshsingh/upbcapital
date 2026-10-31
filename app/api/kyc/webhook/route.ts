import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { ofacHold } from "@/lib/screening";
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
  // A vendor pass does not clear a sanctions match, so that file waits for a person.
  const held = parsed.status === "APPROVED" && (await ofacHold({ userIds: [profile.userId] }));
  const status = held ? "SUBMITTED" : parsed.status;
  await prisma.buyerProfile.update({
    where: { userId: profile.userId },
    data: {
      status,
      vendorRef: parsed.reference || profile.vendorRef,
      reviewedAt: status === "SUBMITTED" ? profile.reviewedAt : new Date(),
    },
  });
  await audit(null, "KYC_WEBHOOK", "user", profile.userId, held ? `Vendor said ${parsed.status}. Held for an OFAC review.` : `Vendor said ${parsed.status}.`);
  return NextResponse.json({ ok: true });
}
