import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { notifyDesk } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { sellerVendorResult } from "@/lib/seller-identity";
import { parseKycWebhook } from "@/lib/vendors";

export const runtime = "nodejs";

function secretMatches(header: string | null, secret: string) {
  const given = Buffer.from(header ?? "");
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function POST(request: Request) {
  const secret = process.env.KYC_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "KYC webhook secret is not set." }, { status: 400 });
  if (!secretMatches(request.headers.get("x-kyc-secret"), secret)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const parsed = parseKycWebhook(body);
  if (!parsed) return NextResponse.json({ error: "Unrecognized payload." }, { status: 400 });
  // Only the file that opened this vendor case, and only while it waits on the desk. An empty reference matches nothing.
  const reference = parsed.reference.trim();
  const profile = reference
    ? await prisma.buyerProfile.findFirst({ where: { vendorRef: reference }, include: { user: { select: { name: true } } } })
    : null;
  // A case no buyer file opened may be a seller's, from the seller file page.
  if (!profile && (await sellerVendorResult(parsed))) return NextResponse.json({ ok: true, matched: true });
  if (!profile || profile.status !== "SUBMITTED" || (parsed.userId && parsed.userId !== profile.userId)) {
    return NextResponse.json({ ok: true, matched: false });
  }
  // A vendor pass is identity only, so the status stays with the desk. The desk's approval checks the entity, the proof
  // of funds, the certification and sanctions, and only that approval opens offers.
  const detail = `Vendor ${profile.vendor || "check"} ${reference.slice(0, 120)} said ${parsed.status}. The file waits on the desk.`;
  const seen = await prisma.auditEvent.findFirst({ where: { action: "KYC_WEBHOOK", entityId: profile.userId, detail } });
  if (seen) return NextResponse.json({ ok: true, matched: true });
  await audit(null, "KYC_WEBHOOK", "user", profile.userId, detail);
  if (parsed.status !== "SUBMITTED") {
    const outcome = parsed.status === "APPROVED" ? "passed" : "did not pass";
    await notifyDesk(`Identity check ${outcome} · ${profile.user.name}`, `The vendor's identity check ${outcome} for ${profile.user.name}. The buyer file still waits on your review.`);
  }
  return NextResponse.json({ ok: true, matched: true });
}
