"use server";

import { redirect } from "next/navigation";
import { isPrivateDocument } from "@/lib/acl";
import { requireRole, requireUser } from "@/lib/auth";
import { modelParticipation } from "@/lib/participation";
import { rescoreListing } from "@/lib/matching";
import { prisma } from "@/lib/prisma";
import { screenParty } from "@/lib/ofac";

async function caseFor(holdingId: string) {
  const holding = await prisma.deskHolding.findUnique({ where: { id: holdingId }, include: { listing: { include: { notes: true } } } });
  if (!holding) redirect("/admin/book?error=That note is not on the desk book.");
  const existing = await prisma.lossCase.findUnique({ where: { holdingId } });
  if (existing) return { holding, file: existing };
  const file = await prisma.lossCase.create({ data: { holdingId } });
  return { holding, file };
}

export async function saveLossStatus(formData: FormData) {
  await requireRole(["ADMIN"]);
  const holdingId = String(formData.get("holdingId") || "");
  const status = String(formData.get("status") || "");
  const summary = String(formData.get("summary") || "").trim().slice(0, 2000);
  if (!["OUTREACH", "REINSTATEMENT", "FORBEARANCE", "MODIFICATION", "FORECLOSURE", "REO", "RESOLVED"].includes(status)) {
    redirect(`/admin/book/${holdingId}?error=Unknown file status.`);
  }
  const { file } = await caseFor(holdingId);
  await prisma.lossCase.update({ where: { id: file.id }, data: { status: status as "OUTREACH", summary } });
  redirect(`/admin/book/${holdingId}?notice=loss`);
}

export async function logOutreach(formData: FormData) {
  await requireRole(["ADMIN"]);
  const holdingId = String(formData.get("holdingId") || "");
  const note = String(formData.get("note") || "").trim();
  const when = String(formData.get("contactedAt") || "");
  const channel = String(formData.get("channel") || "phone");
  if (note.length < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(when)) redirect(`/admin/book/${holdingId}?error=Date and a note are required.`);
  const { file, holding } = await caseFor(holdingId);
  const borrower = holding.listing.notes[0]?.borrowerName || "";
  if (borrower) {
    const screen = await screenParty(borrower);
    await prisma.ofacCheck.create({ data: { name: borrower, result: screen.result, provider: screen.provider } });
    if (screen.result === "REVIEW") redirect(`/admin/book/${holdingId}?error=OFAC mock matched the borrower. Clear it before logging outreach.`);
  }
  await prisma.lossOutreach.create({
    data: { caseId: file.id, note, channel, contactedAt: new Date(`${when}T00:00:00Z`) },
  });
  redirect(`/admin/book/${holdingId}?notice=loss`);
}

export async function savePlan(formData: FormData) {
  await requireRole(["ADMIN"]);
  const holdingId = String(formData.get("holdingId") || "");
  const kind = String(formData.get("kind") || "");
  const amount = Number(String(formData.get("amount") || "").replace(/[$,\s]/g, ""));
  const months = Number(formData.get("months") || 0);
  const rate = Number(formData.get("rate") || 0);
  const start = String(formData.get("startOn") || "");
  const note = String(formData.get("note") || "").trim().slice(0, 500);
  if (!["REINSTATEMENT", "FORBEARANCE", "MODIFICATION"].includes(kind) || !(amount >= 0)) {
    redirect(`/admin/book/${holdingId}?error=Choose a plan and an amount.`);
  }
  const { file } = await caseFor(holdingId);
  await prisma.lossPlan.create({
    data: {
      caseId: file.id,
      kind: kind as "REINSTATEMENT",
      amount,
      months: Number.isFinite(months) ? Math.round(months) : 0,
      rate: Number.isFinite(rate) ? rate : 0,
      startOn: /^\d{4}-\d{2}-\d{2}$/.test(start) ? new Date(`${start}T00:00:00Z`) : null,
      note,
    },
  });
  redirect(`/admin/book/${holdingId}?notice=loss`);
}

export async function saveMilestone(formData: FormData) {
  await requireRole(["ADMIN"]);
  const holdingId = String(formData.get("holdingId") || "");
  const label = String(formData.get("label") || "").trim();
  const attorney = String(formData.get("attorney") || "").trim();
  const court = String(formData.get("courtDate") || "");
  const filed = String(formData.get("filedOn") || "");
  const note = String(formData.get("note") || "").trim().slice(0, 500);
  if (label.length < 2) redirect(`/admin/book/${holdingId}?error=Name the milestone.`);
  const { file } = await caseFor(holdingId);
  await prisma.foreclosureMilestone.create({
    data: {
      caseId: file.id,
      label,
      attorney,
      note,
      courtDate: /^\d{4}-\d{2}-\d{2}$/.test(court) ? new Date(`${court}T00:00:00Z`) : null,
      filedOn: /^\d{4}-\d{2}-\d{2}$/.test(filed) ? new Date(`${filed}T00:00:00Z`) : null,
    },
  });
  redirect(`/admin/book/${holdingId}?notice=loss`);
}

export async function addLossTask(formData: FormData) {
  await requireRole(["ADMIN"]);
  const holdingId = String(formData.get("holdingId") || "");
  const title = String(formData.get("title") || "").trim();
  const due = String(formData.get("dueOn") || "");
  if (title.length < 2 || !/^\d{4}-\d{2}-\d{2}$/.test(due)) redirect(`/admin/book/${holdingId}?error=A task needs a title and a due date.`);
  const { file } = await caseFor(holdingId);
  await prisma.lossTask.create({ data: { caseId: file.id, title, dueOn: new Date(`${due}T00:00:00Z`) } });
  redirect(`/admin/book/${holdingId}?notice=loss`);
}

export async function completeLossTask(formData: FormData) {
  await requireRole(["ADMIN"]);
  const holdingId = String(formData.get("holdingId") || "");
  const id = String(formData.get("id") || "");
  await prisma.lossTask.updateMany({ where: { id, case: { holdingId } }, data: { doneAt: new Date() } });
  redirect(`/admin/book/${holdingId}?notice=loss`);
}

export async function handoffReo(formData: FormData) {
  await requireRole(["ADMIN"]);
  const holdingId = String(formData.get("holdingId") || "");
  const address = String(formData.get("address") || "").trim();
  const rehab = Number(String(formData.get("rehabBudget") || "").replace(/[$,\s]/g, ""));
  const exitPath = String(formData.get("exitPath") || "");
  const exitValue = Number(String(formData.get("exitValue") || "").replace(/[$,\s]/g, ""));
  const monthlyRent = Number(String(formData.get("monthlyRent") || "0").replace(/[$,\s]/g, ""));
  const note = String(formData.get("note") || "").trim().slice(0, 1000);
  if (address.length < 4 || !(rehab >= 0) || !["RESALE", "RENTAL"].includes(exitPath)) {
    redirect(`/admin/book/${holdingId}?error=Address, a rehab budget, and an exit are required.`);
  }
  const { file } = await caseFor(holdingId);
  await prisma.reoProperty.upsert({
    where: { caseId: file.id },
    create: { caseId: file.id, address, rehabBudget: rehab, exitPath: exitPath as "RESALE", exitValue: Number.isFinite(exitValue) ? exitValue : 0, monthlyRent: Number.isFinite(monthlyRent) ? monthlyRent : 0, note },
    update: { address, rehabBudget: rehab, exitPath: exitPath as "RESALE", exitValue: Number.isFinite(exitValue) ? exitValue : 0, monthlyRent: Number.isFinite(monthlyRent) ? monthlyRent : 0, note },
  });
  await prisma.lossCase.update({ where: { id: file.id }, data: { status: "REO" } });
  redirect(`/admin/book/${holdingId}?notice=reo`);
}

async function relistFrom(input: {
  sellerId: string;
  title: string;
  summary: string;
  notes: {
    streetAddress: string;
    city: string;
    state: string;
    zip: string;
    propertyType: string;
    occupancy: string;
    estimatedValue: number;
    lienPosition: string;
    upb: number;
    interestRate: number;
    monthlyPi: number;
    paymentStatus: string;
    monthsDelinquent: number;
    askingPrice: number;
    foreclosureStatus: string;
    borrowerName: string;
    memo: string;
  }[];
  documents: { type: string; originalName: string; storedName: string; mime: string; size: number }[];
  live: boolean;
}) {
  const listing = await prisma.listing.create({
    data: {
      kind: input.notes.length > 1 ? "POOL" : "SINGLE",
      sellerId: input.sellerId,
      status: input.live ? "APPROVED" : "SUBMITTED",
      approvedAt: input.live ? new Date() : null,
      title: input.title,
      summary: input.summary,
      notes: { create: input.notes as never },
      documents: { create: input.documents as never },
    },
  });
  await rescoreListing(listing.id, input.live);
  return listing;
}

export async function relistDeskNote(formData: FormData) {
  const user = await requireRole(["ADMIN"]);
  const holdingId = String(formData.get("holdingId") || "");
  const price = Number(String(formData.get("askingPrice") || "").replace(/[$,\s]/g, ""));
  const holding = await prisma.deskHolding.findUnique({
    where: { id: holdingId },
    include: { listing: { include: { notes: true, documents: true } }, payments: true },
  });
  if (!holding) redirect("/admin/book?error=That note is not on the desk book.");
  if (!(price > 0)) redirect(`/admin/book/${holdingId}?error=Enter an asking price.`);
  const notes = holding.noteId ? holding.listing.notes.filter((note) => note.id === holding.noteId) : holding.listing.notes;
  const history = holding.payments.map((payment) => `${payment.paidOn.toISOString().slice(0, 10)} ${Number(payment.amount)} ${payment.memo}`).join("; ");
  const listing = await relistFrom({
    sellerId: user.id,
    title: `Resale · ${holding.title}`,
    summary: `${holding.listing.summary}\n\nRelisted from the desk book. Cost basis ${Number(holding.costBasis)}. Receipts: ${history || "none logged."}`,
    live: true,
    notes: notes.map((note) => ({
      streetAddress: note.streetAddress,
      city: note.city,
      state: note.state,
      zip: note.zip,
      propertyType: note.propertyType,
      occupancy: note.occupancy,
      estimatedValue: Number(note.estimatedValue),
      lienPosition: note.lienPosition,
      upb: Number(note.upb),
      interestRate: Number(note.interestRate),
      monthlyPi: Number(note.monthlyPi),
      paymentStatus: note.paymentStatus,
      monthsDelinquent: note.monthsDelinquent,
      askingPrice: price / notes.length,
      foreclosureStatus: note.foreclosureStatus,
      borrowerName: note.borrowerName,
      memo: note.memo,
    })),
    documents: holding.listing.documents.filter((doc) => !isPrivateDocument(doc, holding.listing)).map((doc) => ({
      type: doc.type,
      originalName: doc.originalName,
      storedName: doc.storedName,
      mime: doc.mime,
      size: doc.size,
    })),
  });
  redirect(`/admin/listings/${listing.id}?notice=relist`);
}

export async function relistBuyerNote(formData: FormData) {
  const user = await requireUser();
  const holdingId = String(formData.get("holdingId") || "");
  const price = Number(String(formData.get("askingPrice") || "").replace(/[$,\s]/g, ""));
  const holding = await prisma.buyerHolding.findUnique({ where: { id: holdingId }, include: { payments: true } });
  if (!holding || holding.userId !== user.id) redirect("/buyer/portfolio?error=That note is not on your book.");
  if (!(price > 0)) redirect("/buyer/portfolio?error=Enter an asking price.");
  const source = holding.listingId
    ? await prisma.listing.findUnique({ where: { id: holding.listingId }, include: { notes: true, documents: true } })
    : null;
  const notes = source?.notes ?? [];
  if (!notes.length) redirect("/buyer/portfolio?error=This holding has no loan file to copy. Add the property facts on a new listing.");
  const history = holding.payments.map((payment) => `${payment.paidOn.toISOString().slice(0, 10)} ${Number(payment.amount)}`).join("; ");
  const yieldText = holding.underwrittenYield == null ? "" : ` Underwritten yield ${Number(holding.underwrittenYield).toFixed(1)}%.`;
  const share = holding.sharePercent == null ? 1 : Number(holding.sharePercent) / 100;
  const fractional = share > 0 && share < 0.999;
  const listing = await relistFrom({
    sellerId: user.id,
    title: fractional ? `Position · ${Number(holding.sharePercent).toFixed(1)}% · ${holding.title}` : `Resale · ${holding.title}`,
    summary: fractional
      ? `A ${Number(holding.sharePercent).toFixed(1)}% participation relisted by the holder. Cost ${Number(holding.costBasis)}.${yieldText} Receipts: ${history || "none logged."}`
      : `Relisted by the holder. Cost ${Number(holding.costBasis)}.${yieldText} Receipts: ${history || "none logged."}`,
    live: false,
    notes: notes.map((note) => ({
      streetAddress: note.streetAddress,
      city: note.city,
      state: note.state,
      zip: note.zip,
      propertyType: note.propertyType,
      occupancy: note.occupancy,
      estimatedValue: Number(note.estimatedValue) * (fractional ? share : 1),
      lienPosition: note.lienPosition,
      upb: Number(note.upb) * (fractional ? share : 1),
      interestRate: Number(note.interestRate),
      monthlyPi: Number(note.monthlyPi) * (fractional ? share : 1),
      paymentStatus: note.paymentStatus,
      monthsDelinquent: note.monthsDelinquent,
      askingPrice: price / notes.length,
      foreclosureStatus: note.foreclosureStatus,
      borrowerName: note.borrowerName,
      memo: fractional ? `${Number(holding.sharePercent).toFixed(1)}% participation.` : note.memo,
    })),
    documents: (source ? source.documents.filter((doc) => !isPrivateDocument(doc, source)) : []).map((doc) => ({
      type: doc.type,
      originalName: doc.originalName,
      storedName: doc.storedName,
      mime: doc.mime,
      size: doc.size,
    })),
  });
  redirect(`/buyer/portfolio?notice=relist&listed=${listing.id}`);
}

export async function quoteSlice(formData: FormData) {
  const user = await requireUser();
  const holdingId = String(formData.get("holdingId") || "");
  const side = String(formData.get("side") || "desk");
  const percent = Number(formData.get("percent") || 100);
  const payments = String(formData.get("paymentCount") || "");
  const price = Number(String(formData.get("price") || "").replace(/[$,\s]/g, ""));
  const back = side === "buyer" ? "/buyer/portfolio" : `/admin/book/${holdingId}`;
  if (side === "desk") await requireRole(["ADMIN"]);
  const desk = side === "desk" ? await prisma.deskHolding.findUnique({ where: { id: holdingId }, include: { listing: { include: { notes: true } } } }) : null;
  const buyer = side === "buyer" ? await prisma.buyerHolding.findUnique({ where: { id: holdingId } }) : null;
  if (side === "buyer" && (!buyer || buyer.userId !== user.id)) redirect("/buyer/portfolio?error=That note is not yours.");
  if (side === "desk" && !desk) redirect("/admin/book?error=That note is not on the desk book.");
  const notes = desk?.listing.notes ?? [];
  const upb = desk ? (desk.noteId ? notes.filter((note) => note.id === desk.noteId) : notes).reduce((sum, note) => sum + Number(note.upb), 0) : Number(buyer?.upb || 0);
  const stated = Number(String(formData.get("monthly") || "").replace(/[$,\s]/g, ""));
  const fromNotes = desk ? notes.reduce((sum, note) => sum + Number(note.monthlyPi), 0) : 0;
  const monthly = fromNotes || (Number.isFinite(stated) ? stated : 0);
  if (!(monthly > 0)) redirect(`${back}?error=A monthly payment is required before the split can be modeled.`);
  const rate = upb > 0 && desk ? notes.reduce((sum, note) => sum + Number(note.interestRate) * Number(note.upb), 0) / upb : 6;
  const basis = Number(desk?.costBasis || buyer?.costBasis || 0);
  const model = modelParticipation({
    basis,
    upb,
    annualRate: rate,
    monthlyPi: monthly,
    termMonths: 360,
    percent,
    paymentCount: payments ? Number(payments) : null,
    slicePrice: price,
  });
  if (!model) redirect(`${back}?error=The split needs a price below the basis, and a percent or a payment count inside the term.`);
  const row = await prisma.participation.create({
    data: {
      deskHoldingId: desk?.id,
      buyerHoldingId: buyer?.id,
      percent,
      paymentCount: payments ? Number(payments) : null,
      price,
      status: "DRAFT",
    },
  });
  const params = new URLSearchParams({
    notice: "slice",
    slice: row.id,
    buyerIrr: model.buyerIrr == null ? "" : model.buyerIrr.toFixed(1),
    sellerIrr: model.sellerIrr == null ? "" : model.sellerIrr.toFixed(1),
  });
  redirect(`${back}?${params.toString()}`);
}

export async function listSlice(formData: FormData) {
  const user = await requireRole(["ADMIN"]);
  const id = String(formData.get("id") || "");
  const slice = await prisma.participation.findUnique({
    where: { id },
    include: { deskHolding: { include: { listing: { include: { notes: true, documents: true } } } } },
  });
  if (!slice?.deskHolding) redirect("/admin/book?error=Only a desk slice can be listed from here.");
  const holding = slice.deskHolding;
  const share = Number(slice.percent) / 100;
  const notes = holding.noteId ? holding.listing.notes.filter((note) => note.id === holding.noteId) : holding.listing.notes;
  const listing = await relistFrom({
    sellerId: user.id,
    title: slice.paymentCount ? `Participation · ${slice.paymentCount} payments · ${holding.title}` : `Participation · ${Number(slice.percent)}% · ${holding.title}`,
    summary: `A slice of ${holding.title}. ${slice.paymentCount ? `The first ${slice.paymentCount} payments.` : `${Number(slice.percent)}% of principal and payment.`} The remainder stays with the holder.`,
    live: true,
    notes: notes.map((note) => ({
      streetAddress: note.streetAddress,
      city: note.city,
      state: note.state,
      zip: note.zip,
      propertyType: note.propertyType,
      occupancy: note.occupancy,
      estimatedValue: Number(note.estimatedValue) * (slice.paymentCount ? 1 : share),
      lienPosition: note.lienPosition,
      upb: Number(note.upb) * (slice.paymentCount ? 1 : share),
      interestRate: Number(note.interestRate),
      monthlyPi: Number(note.monthlyPi) * (slice.paymentCount ? 1 : share),
      paymentStatus: note.paymentStatus,
      monthsDelinquent: note.monthsDelinquent,
      askingPrice: Number(slice.price) / notes.length,
      foreclosureStatus: note.foreclosureStatus,
      borrowerName: note.borrowerName,
      memo: slice.paymentCount ? `Payment stream of ${slice.paymentCount} months.` : `${Number(slice.percent)}% participation.`,
    })),
    documents: holding.listing.documents.filter((doc) => !isPrivateDocument(doc, holding.listing)).map((doc) => ({
      type: doc.type,
      originalName: doc.originalName,
      storedName: doc.storedName,
      mime: doc.mime,
      size: doc.size,
    })),
  });
  await prisma.participation.update({ where: { id }, data: { status: "LISTED", listingId: listing.id } });
  redirect(`/admin/listings/${listing.id}?notice=relist`);
}
