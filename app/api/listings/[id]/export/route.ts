import * as XLSX from "xlsx";
import { listingIsPublic } from "@/lib/access";
import { getCurrentUser } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import { prisma } from "@/lib/prisma";
import { isPro } from "@/lib/settings";
import { couponBucket, ltvBucket, stratify, upbBucket } from "@/lib/strata";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const listing = await prisma.listing.findUnique({
    where: { id },
    include: { notes: true, ndas: { where: { userId: user.id } } },
  });
  if (!listing) return new Response("Not found.", { status: 404 });
  const owner = listing.sellerId === user.id;
  const desk = user.role === "ADMIN";
  const buyer = user.role === "BUYER" && user.accountStatus === "APPROVED" && isPro(user);
  if (!owner && !desk && !buyer) return new Response("The tape export is part of Pro.", { status: 403 });
  if (!owner && !desk && !listingIsPublic(listing.status)) return new Response("Not found.", { status: 404 });
  const unlocked = owner || desk || listing.ndas.length > 0;
  const format = new URL(request.url).searchParams.get("format") === "xlsx" ? "xlsx" : "csv";
  const loans = listing.notes.map((note) => {
    const upb = Number(note.upb);
    const value = Number(note.estimatedValue);
    return {
      street: unlocked ? note.streetAddress : "",
      city: note.city,
      state: note.state,
      lien: note.lienPosition,
      status: note.paymentStatus,
      upb,
      value,
      rate: Number(note.interestRate),
      asking: Number(note.askingPrice),
      monthsDelinquent: note.monthsDelinquent,
      upbBucket: upbBucket(upb),
      ltvBucket: ltvBucket(upb, value),
      couponBucket: couponBucket(Number(note.interestRate)),
      avm: note.avmValue == null ? "" : Number(note.avmValue),
    };
  });
  const strata = stratify(loans.map((loan) => ({
    state: loan.state,
    lien: loan.lien,
    status: loan.status,
    upb: loan.upb,
    value: loan.value,
    rate: loan.rate,
    monthsDelinquent: loan.monthsDelinquent,
  })));
  const summary = [
    { metric: "count", value: strata.count },
    { metric: "upb", value: Math.round(strata.totalUpb) },
    { metric: "wac", value: Number(strata.wac.toFixed(3)) },
    { metric: "waltv", value: Number(strata.waltv.toFixed(3)) },
    { metric: "weightedMonthsDelinquent", value: Number(strata.weightedDelinquency.toFixed(3)) },
  ];
  const filename = `tape-${listing.id.slice(-6)}.${format}`;
  if (format === "csv") {
    const body = `${toCsv(summary.map((row) => ({ metric: row.metric, value: row.value })))}\n\n${toCsv(loans)}`;
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(loans), "Loans");
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(summary), "Weighted");
  const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
