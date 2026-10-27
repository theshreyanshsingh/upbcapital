import { listingIsPublic } from "@/lib/access";
import { getCurrentUser } from "@/lib/auth";
import { foreclosureFor } from "@/lib/foreclosure";
import { buildMemoPdf } from "@/lib/memo-pdf";
import { prisma } from "@/lib/prisma";
import { isPro } from "@/lib/settings";
import { nplCases, performingCase } from "@/lib/underwriting";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const listing = await prisma.listing.findUnique({ where: { id }, include: { notes: true } });
  if (!listing || listing.notes.length === 0) return new Response("Not found.", { status: 404 });
  const owner = listing.sellerId === user.id;
  const desk = user.role === "ADMIN";
  const buyer = user.role === "BUYER" && user.accountStatus === "APPROVED" && isPro(user);
  if (!owner && !desk && !buyer) return new Response("The memo is part of Pro.", { status: 403 });
  if (!owner && !desk && !listingIsPublic(listing.status)) return new Response("Not found.", { status: 404 });

  const bid = Number(new URL(request.url).searchParams.get("bid"));
  if (!Number.isFinite(bid) || bid <= 0) return new Response("Enter a bid.", { status: 400 });
  const notes = listing.notes;
  const upb = notes.reduce((sum, note) => sum + Number(note.upb), 0);
  const value = notes.reduce((sum, note) => sum + Number(note.estimatedValue), 0);
  const monthlyPi = notes.reduce((sum, note) => sum + Number(note.monthlyPi), 0);
  const rate = upb > 0 ? notes.reduce((sum, note) => sum + Number(note.interestRate) * Number(note.upb), 0) / upb : 0;
  const performing = notes.every((note) => note.paymentStatus === "PERFORMING");
  const lead = [...notes].sort((a, b) => Number(b.upb) - Number(a.upb))[0];
  const monthsDelinquent = upb > 0 ? notes.reduce((sum, note) => sum + note.monthsDelinquent * Number(note.upb), 0) / upb : 0;
  const rule = foreclosureFor(lead.state);
  const term = lead.maturityDate
    ? Math.max(1, Math.min(480, Math.round((lead.maturityDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30.44))))
    : 360;
  const cash = performingCase({ bid, upb, annualRate: rate, monthlyPi, termMonths: term });
  const scenarios = nplCases({
    bid,
    upb,
    value,
    monthlyPi,
    monthsDelinquent,
    foreclosureMonths: rule.months,
    foreclosureCost: rule.cost,
    process: rule.assumed ? "Florida judicial (assumed)" : rule.process,
  });
  const avmValues = notes.map((note) => (note.avmValue == null ? null : Number(note.avmValue))).filter((item): item is number => item != null);
  const pdf = await buildMemoPdf({
    title: listing.title,
    city: lead.city,
    state: lead.state,
    bid,
    upb,
    value,
    performing,
    yieldPct: performing ? cash.yieldPct : null,
    irrPct: performing ? cash.irrPct : null,
    cashOnCash: performing ? cash.cashOnCash : null,
    paybackMonths: performing ? cash.paybackMonths : null,
    scenarios: performing ? [] : scenarios,
    avm: avmValues.length ? avmValues.reduce((sum, item) => sum + item, 0) : null,
  });
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="underwriting-memo.pdf"`,
    },
  });
}
