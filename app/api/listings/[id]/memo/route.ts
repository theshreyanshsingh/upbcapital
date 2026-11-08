import { listingIsPublic } from "@/lib/access";
import { audit } from "@/lib/audit";
import { getApiUser } from "@/lib/auth";
import { isReleaseBuild } from "@/lib/deploy";
import { showableAvm } from "@/lib/enrichment";
import { timelineLine } from "@/lib/foreclosure";
import { buildMemoPdf } from "@/lib/memo-pdf";
import { prisma } from "@/lib/prisma";
import { canSeeListing } from "@/lib/private-listings";
import { isPro } from "@/lib/settings";
import { performingCase, priceForYield, yieldAtPrice, type PricingNote } from "@/lib/underwriting";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const listing = await prisma.listing.findUnique({ where: { id }, include: { notes: true } });
  if (!listing || listing.notes.length === 0) return new Response("Not found.", { status: 404 });
  const owner = listing.sellerId === user.id;
  const desk = user.role === "ADMIN";
  const buyer = user.role === "BUYER" && user.accountStatus === "APPROVED" && isPro(user);
  if (!owner && !desk && !buyer) return new Response("The memo is part of Pro.", { status: 403 });
  if (!owner && !desk && !listingIsPublic(listing.status)) return new Response("Not found.", { status: 404 });
  // A private listing, or one whose seller excludes this buyer, is not found (lib/private-listings.ts).
  if (!owner && !desk && !(await canSeeListing(user, listing))) return new Response("Not found.", { status: 404 });

  const search = new URL(request.url).searchParams;
  const bid = Number(search.get("bid"));
  if (!Number.isFinite(bid) || bid <= 0) return new Response("Enter a bid.", { status: 400 });
  // Present when the buyer solved for a price: the memo then states the target the bid came from.
  const target = search.has("target") ? Number(search.get("target")) : null;
  await audit(user.id, "MEMO_DOWNLOAD", "listing", listing.id, `Underwriting memo at $${Math.round(bid).toLocaleString("en-US")}`);
  const notes = listing.notes;
  const upb = notes.reduce((sum, note) => sum + Number(note.upb), 0);
  const value = notes.reduce((sum, note) => sum + Number(note.estimatedValue), 0);
  const monthlyPi = notes.reduce((sum, note) => sum + Number(note.monthlyPi), 0);
  const rate = upb > 0 ? notes.reduce((sum, note) => sum + Number(note.interestRate) * Number(note.upb), 0) / upb : 0;
  const performing = notes.every((note) => note.paymentStatus === "PERFORMING");
  const lead = [...notes].sort((a, b) => Number(b.upb) - Number(a.upb))[0];
  const monthsDelinquent = upb > 0 ? notes.reduce((sum, note) => sum + note.monthsDelinquent * Number(note.upb), 0) / upb : 0;
  const term = lead.maturityDate
    ? Math.max(1, Math.min(480, Math.round((lead.maturityDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30.44))))
    : 360;
  const cash = performingCase({ bid, upb, annualRate: rate, monthlyPi, termMonths: term });
  // The pool as one loan, as the analyzer models it: the largest loan sets the state, occupancy and lien.
  const note: PricingNote = {
    upb,
    interestRate: rate,
    monthlyPi,
    termMonths: term,
    estimatedValue: value,
    state: lead.state,
    paymentStatus: performing ? "PERFORMING" : "NON_PERFORMING",
    occupancy: lead.occupancy,
    lienPosition: lead.lienPosition,
    monthsDelinquent,
    foreclosureFiledAt: lead.foreclosureFiledAt ?? null,
    // A single junior lien's senior balance from the tape. A pool modelled as one loan keeps the assumption.
    seniorBalance: notes.length === 1 ? lead.seniorLienBalance ?? null : null,
  };
  const atBid = yieldAtPrice(note, bid);
  const solved = target != null && Number.isFinite(target) && target > 0 && target < 100 ? priceForYield(note, target) : null;
  // Stand-in values stay out of a release memo, and a pool's sum counts only when every loan has a value, so it's
  // never set against the whole pool's price.
  const avmValues = notes
    .map((note) => showableAvm({ avmValue: note.avmValue == null ? null : Number(note.avmValue), avmProvider: note.avmProvider }))
    .filter((item): item is number => item != null);
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
    scenarios: performing ? [] : atBid.cases,
    avm: avmValues.length && avmValues.length === notes.length ? avmValues.reduce((sum, item) => sum + item, 0) : null,
    expectedIrr: atBid.irrPct,
    irrRange: atBid.range ? { low: atBid.range.p10, mid: atBid.range.p50, high: atBid.range.p90 } : null,
    paths: performing ? atBid.scenarios.map((row) => ({ label: row.label, weight: row.weight, irrPct: row.irrPct })) : [],
    prepaymentLabel: atBid.prepayment?.label ?? null,
    timeline: performing || !atBid.timeline ? null : timelineLine(atBid.timeline),
    law: performing || !atBid.timeline ? null : atBid.timeline.law,
    weightsBasis: atBid.weightsBasis,
    solved: solved && solved.bid != null ? { target: solved.targetYield, bid: solved.bid, pctOfUpb: solved.pctOfUpb, pctOfValue: solved.pctOfValue } : null,
    demo: !isReleaseBuild(process.env),
  });
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="underwriting-memo.pdf"`,
    },
  });
}
