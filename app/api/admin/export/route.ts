import { getApiUser } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await getApiUser();
  if (!user || user.role !== "ADMIN") return new Response("The desk only.", { status: 403 });
  const kind = new URL(request.url).searchParams.get("kind") || "listings";
  let rows: Record<string, string | number | null>[] = [];
  if (kind === "users") {
    const users = await prisma.user.findMany({ orderBy: { createdAt: "desc" } });
    rows = users.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      accountStatus: row.accountStatus,
      tier: row.subscriptionTier,
      company: row.companyName,
      referralCode: row.referralCode,
      referralCredits: row.referralCredits,
      totp: row.totpEnabled ? "on" : "off",
      createdAt: row.createdAt.toISOString(),
    }));
  } else if (kind === "inquiries") {
    const inquiries = await prisma.inquiry.findMany({ include: { buyer: true, listing: true }, orderBy: { createdAt: "desc" } });
    rows = inquiries.map((row) => ({
      id: row.id,
      listing: row.listing.title,
      buyer: row.buyer.email,
      type: row.type,
      status: row.status,
      amount: row.amount == null ? "" : Number(row.amount),
      createdAt: row.createdAt.toISOString(),
    }));
  } else if (kind === "notes") {
    const notes = await prisma.note.findMany({ include: { listing: true } });
    rows = notes.map((row) => ({
      id: row.id,
      listing: row.listing.title,
      status: row.listing.status,
      city: row.city,
      state: row.state,
      lien: row.lienPosition,
      payment: row.paymentStatus,
      upb: Number(row.upb),
      asking: Number(row.askingPrice),
      value: Number(row.estimatedValue),
      rate: Number(row.interestRate),
      avm: row.avmValue == null ? "" : Number(row.avmValue),
    }));
  } else {
    const listings = await prisma.listing.findMany({ include: { seller: true, notes: { select: { askingPrice: true } }, _count: { select: { inquiries: true, notes: true } } }, orderBy: { createdAt: "desc" } });
    rows = listings.map((row) => ({
      id: row.id,
      title: row.title,
      kind: row.kind,
      status: row.status,
      seller: row.seller.email,
      views: row.viewCount,
      bidMode: row.bidMode,
      deadline: row.bidDeadline?.toISOString() ?? "",
      loans: row._count.notes,
      inquiries: row._count.inquiries,
      ask: row.notes.reduce((sum, note) => sum + Number(note.askingPrice), 0),
      salePrice: row.salePrice == null ? "" : Number(row.salePrice),
    }));
  }
  const filename = kind === "users" || kind === "inquiries" || kind === "notes" || kind === "listings" ? kind : "listings";
  return new Response(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}.csv"`,
    },
  });
}
