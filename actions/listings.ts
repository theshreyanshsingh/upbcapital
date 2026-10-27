"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { DocType } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { notify, notifyDesk } from "@/lib/email";
import { noteMatches, type BookFilters } from "@/lib/filters";
import { isPro } from "@/lib/settings";
import { rescoreListing } from "@/lib/matching";
import { screenParty } from "@/lib/ofac";
import { prisma } from "@/lib/prisma";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { deleteTapeDraft, readTapeDraft } from "@/lib/tape-draft";
import { uploadProblem } from "@/lib/uploads";
import { normalizeTapeRows } from "@/lib/tape";
import type { TapeFieldKey } from "@/lib/tape-fields";
import { firstZodError, noteSchema, noteTitle } from "@/lib/validators";

const DOC_VALUES = new Set(["NOTE", "MORTGAGE", "PAY_HISTORY", "BPO", "TITLE", "TAPE", "OTHER"]);

async function saveDocuments(listingId: string, formData: FormData) {
  const files = formData.getAll("documents");
  const types = formData.getAll("documentTypes").map(String);
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!(file instanceof File) || file.size <= 0) continue;
    const bytes = Buffer.from(await file.arrayBuffer());
    if (uploadProblem(file.name, bytes.length, bytes)) continue;
    const ext = extensionOf(file.name);
    if (!ext) continue;
    const storedName = `${crypto.randomUUID()}-${safeBasename(file.name)}`;
    const mime = mimeFor(ext, file.type || "application/octet-stream");
    await putBytes(storedName, bytes, mime);
    const rawType = types[index] || "OTHER";
    const type = (DOC_VALUES.has(rawType) ? rawType : "OTHER") as DocType;
    await prisma.document.create({
      data: {
        listingId,
        type,
        originalName: file.name.slice(0, 180),
        storedName,
        mime,
        size: file.size,
      },
    });
  }
}

function noteData(input: ReturnType<typeof noteSchema.parse>) {
  return {
    streetAddress: input.streetAddress,
    city: input.city,
    state: input.state,
    zip: input.zip,
    propertyType: input.propertyType,
    occupancy: input.occupancy,
    estimatedValue: input.estimatedValue,
    lienPosition: input.lienPosition,
    upb: input.upb,
    interestRate: input.interestRate,
    monthlyPi: input.monthlyPi,
    paymentStatus: input.paymentStatus,
    monthsDelinquent: input.monthsDelinquent,
    lastPaidDate: input.lastPaidDate,
    originationDate: input.originationDate,
    maturityDate: input.maturityDate,
    askingPrice: input.askingPrice,
    foreclosureStatus: input.foreclosureStatus,
    borrowerName: input.borrowerName || "",
    memo: input.narrative || "",
  };
}

function readNoteForm(formData: FormData) {
  return noteSchema.safeParse({
    streetAddress: formData.get("streetAddress"),
    city: formData.get("city"),
    state: formData.get("state"),
    zip: formData.get("zip"),
    propertyType: formData.get("propertyType"),
    occupancy: formData.get("occupancy"),
    estimatedValue: formData.get("estimatedValue"),
    lienPosition: formData.get("lienPosition"),
    upb: formData.get("upb"),
    interestRate: formData.get("interestRate"),
    monthlyPi: formData.get("monthlyPi"),
    paymentStatus: formData.get("paymentStatus"),
    monthsDelinquent: formData.get("monthsDelinquent") || 0,
    lastPaidDate: formData.get("lastPaidDate") || "",
    originationDate: formData.get("originationDate") || "",
    maturityDate: formData.get("maturityDate") || "",
    askingPrice: formData.get("askingPrice"),
    foreclosureStatus: formData.get("foreclosureStatus"),
    borrowerName: formData.get("borrowerName") || "",
    narrative: formData.get("narrative") || "",
  });
}

async function requireNoteSeller() {
  const user = await requireUser();
  if (user.role !== "INDIVIDUAL_SELLER" && user.role !== "INSTITUTIONAL_SELLER") {
    return { user, error: "Use a seller account to list paper." as const };
  }
  if (user.role === "INSTITUTIONAL_SELLER" && user.accountStatus !== "APPROVED") {
    return { user, error: "Your institutional account is still in review." as const };
  }
  return { user, error: null };
}

export async function createNoteListing(formData: FormData) {
  const { user, error } = await requireNoteSeller();
  if (error) return { error };
  const parsed = readNoteForm(formData);
  if (!parsed.success) return { error: firstZodError(parsed.error) };
  const input = parsed.data;
  const sellerFinanced = user.role === "INDIVIDUAL_SELLER" || formData.get("sellerFinanced") === "true";
  const listing = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId: user.id,
      status: "SUBMITTED",
      sellerFinanced,
      title: noteTitle(input),
      summary: input.narrative,
      notes: { create: noteData(input) },
    },
  });
  if (input.borrowerName) {
    const screen = await screenParty(input.borrowerName);
    await prisma.ofacCheck.create({ data: { name: input.borrowerName, result: screen.result, provider: screen.provider } });
    if (screen.result === "REVIEW") {
      await prisma.reviewComment.create({
        data: { listingId: listing.id, authorId: user.id, action: "COMMENT", comment: `OFAC mock matched the borrower. ${screen.detail}` },
      });
    }
  }
  await saveDocuments(listing.id, formData);
  await prisma.reviewComment.create({
    data: { listingId: listing.id, authorId: user.id, action: "COMMENT", comment: "Submitted to the desk." },
  });
  await notifyDesk(
    `Note submitted · ${listing.title}`,
    `${user.name} submitted ${listing.title} at an ask of $${input.askingPrice.toLocaleString("en-US")}.`,
  );
  const leadId = String(formData.get("leadId") || "");
  if (leadId) {
    await prisma.sellerLead.updateMany({
      where: { id: leadId, email: user.email },
      data: { listingId: listing.id, userId: user.id, status: "LISTING" },
    });
  }
  await rescoreListing(listing.id, false);
  revalidatePath("/admin/queue");
  redirect(`/seller/listings/${listing.id}?notice=submitted`);
}

export async function updateOwnNote(listingId: string, formData: FormData) {
  const { user, error } = await requireNoteSeller();
  if (error) return { error };
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { notes: true } });
  if (!listing || listing.sellerId !== user.id || listing.kind !== "SINGLE") return { error: "That listing is not yours to edit." };
  if (listing.status !== "SUBMITTED" && listing.status !== "CHANGES_REQUESTED") {
    return { error: "This listing is with the desk and can no longer be edited here." };
  }
  const parsed = readNoteForm(formData);
  if (!parsed.success) return { error: firstZodError(parsed.error) };
  const input = parsed.data;
  const note = listing.notes[0];
  if (!note) return { error: "The loan record is missing." };
  await prisma.note.update({ where: { id: note.id }, data: noteData(input) });
  await prisma.listing.update({
    where: { id: listing.id },
    data: {
      title: noteTitle(input),
      summary: input.narrative,
      status: "SUBMITTED",
      sellerFinanced: user.role === "INDIVIDUAL_SELLER" || formData.get("sellerFinanced") === "true",
    },
  });
  await saveDocuments(listing.id, formData);
  await prisma.reviewComment.create({
    data: { listingId: listing.id, authorId: user.id, action: "COMMENT", comment: "Seller updated the file and resubmitted." },
  });
  await notifyDesk(`Resubmitted · ${noteTitle(input)}`, `${user.name} updated the listing and sent it back to review.`);
  revalidatePath(`/seller/listings/${listing.id}`);
  redirect(`/seller/listings/${listing.id}?notice=resubmitted`);
}

export async function updateOwnListingMeta(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") || "");
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.sellerId !== user.id) redirect("/seller?error=That listing is not yours.");
  if (listing.status !== "SUBMITTED" && listing.status !== "CHANGES_REQUESTED") {
    redirect(`/seller/listings/${listingId}?error=${encodeURIComponent("This listing can no longer be edited.")}`);
  }
  const title = String(formData.get("title") || "").trim();
  const summary = String(formData.get("summary") || "").trim();
  if (title.length < 3) redirect(`/seller/listings/${listingId}?error=${encodeURIComponent("Give the pool a name.")}`);
  await prisma.listing.update({
    where: { id: listing.id },
    data: { title, summary, status: "SUBMITTED" },
  });
  redirect(`/seller/listings/${listing.id}?notice=resubmitted`);
}

export async function createPoolListing(formData: FormData) {
  const user = await requireUser();
  if (user.role !== "INSTITUTIONAL_SELLER" && user.role !== "ADMIN") {
    return { error: "Tape uploads are for institutional accounts." };
  }
  if (user.role === "INSTITUTIONAL_SELLER" && user.accountStatus !== "APPROVED") {
    return { error: "Your institutional account is still in review." };
  }
  const token = String(formData.get("token") || "");
  if (!/^[0-9a-f-]{36}$/i.test(token)) return { error: "Upload the tape again." };
  const title = String(formData.get("title") || "").trim();
  const summary = String(formData.get("summary") || "").trim();
  const priceMode = String(formData.get("priceMode") || "COLUMN") as "COLUMN" | "PERCENT" | "POOL_TOTAL";
  if (title.length < 3) return { error: "Name the pool." };
  const mapping = JSON.parse(String(formData.get("mapping") || "{}")) as Partial<Record<TapeFieldKey, string>>;
  const draft = await readTapeDraft(user.id, token);
  if (!draft) return { error: "That tape expired. Upload it again." };
  const { parseTapeBuffer } = await import("@/lib/tape");
  const matrix = parseTapeBuffer(draft.bytes, draft.filename);
  const { loans, errors } = normalizeTapeRows({
    rows: matrix.rows,
    mapping,
    priceMode,
    pricePercent: Number(formData.get("pricePercent") || 0),
    poolTotal: Number(formData.get("poolTotal") || 0),
  });
  if (errors.length) {
    return { error: errors.slice(0, 4).map((issue) => (issue.row ? `Row ${issue.row}: ${issue.message}` : issue.message)).join(" ") };
  }
  if (loans.length > 2000) return { error: "Tapes are limited to 2,000 loans in this desk." };

  const listing = await prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId: user.id,
      status: "SUBMITTED",
      title,
      summary,
      notes: { create: loans },
    },
  });
  const storedName = `${crypto.randomUUID()}-${safeBasename(draft.filename)}`;
  const tapeMime = draft.filename.toLowerCase().endsWith(".csv") ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  await putBytes(storedName, draft.bytes, tapeMime);
  await prisma.document.create({
    data: {
      listingId: listing.id,
      type: "TAPE",
      originalName: draft.filename,
      storedName,
      mime: tapeMime,
      size: draft.bytes.length,
    },
  });
  await notifyDesk(
    `Pool submitted · ${title}`,
    `${user.companyName || user.name} submitted ${loans.length} loans in ${title}.`,
  );
  await deleteTapeDraft(token);
  await rescoreListing(listing.id, false);
  revalidatePath("/admin/queue");
  redirect(`/seller/listings/${listing.id}?notice=submitted`);
}

export async function alertMatchingSearches(listingId: string) {
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { notes: true } });
  if (!listing || listing.status !== "APPROVED") return;
  const searches = await prisma.savedSearch.findMany({ where: { alertEnabled: true }, include: { user: true } });
  for (const search of searches) {
    if (!isPro(search.user) || search.user.accountStatus !== "APPROVED") continue;
    const filters = search.filters as BookFilters;
    if (filters.kind && filters.kind !== listing.kind) continue;
    const hit = listing.notes.some((note) =>
      noteMatches(
        {
          city: note.city,
          state: note.state,
          paymentStatus: note.paymentStatus,
          lienPosition: note.lienPosition,
          propertyType: note.propertyType,
          upb: Number(note.upb),
          askingPrice: Number(note.askingPrice),
        },
        filters,
      ),
    );
    if (!hit) continue;
    await notify(
      search.user.email,
      `New paper matches “${search.name}”`,
      `${listing.title} just went live and matches your saved search. Open the book to underwrite it.`,
    );
  }
}
