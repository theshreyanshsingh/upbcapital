"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { DocType } from "@prisma/client";
import { readInBackground } from "@/lib/ai-reading";
import { actionGate } from "@/lib/action-gates";
import { requireUser } from "@/lib/auth";
import { settleByEdit } from "@/lib/discrepancies";
import { flagDuplicates } from "@/lib/duplicates";
import { notifyDesk } from "@/lib/email";
import { addTranche, tapeProgram } from "@/lib/flow-programs";
import { typedNumber } from "@/lib/money";
import { rescoreListing } from "@/lib/matching";
import { addPoolFiles } from "@/lib/room-files";
import { screenInBackground, screenListing } from "@/lib/screening";
import { prisma } from "@/lib/prisma";
import { seatGate } from "@/lib/seats";
import { DESK_DENIED, deskDenied } from "@/lib/staff";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { deleteTapeDraft, readTapeDraft } from "@/lib/tape-draft";
import { uploadProblem } from "@/lib/uploads";
import { normalizeTapeRows } from "@/lib/tape";
import { SERVICING_KEYS, type TapeFieldKey } from "@/lib/tape-fields";
import { firstZodError, noteSchema, noteTitle, type NoteInput } from "@/lib/validators";

function skippedNotice(skipped: string[]) {
  if (!skipped.length) return "";
  const names = skipped.slice(0, 3).map((name) => name.slice(0, 40)).join(", ") + (skipped.length > 3 ? ", and more" : "");
  const lead = skipped.length === 1 ? "One file wasn't added" : `${skipped.length} files weren't added`;
  return `&error=${encodeURIComponent(`${lead} (${names}). Check its type and size, then upload it again.`)}`;
}

const DOC_VALUES = new Set(["NOTE", "MORTGAGE", "PAY_HISTORY", "BPO", "TITLE", "TAPE", "OTHER"]);

// Returns the names of files it couldn't take, so the seller hears about them instead of assuming they're in.
async function saveDocuments(listingId: string, formData: FormData) {
  const skipped: string[] = [];
  const files = formData.getAll("documents");
  const types = formData.getAll("documentTypes").map(String);
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!(file instanceof File) || file.size <= 0) continue;
    const bytes = Buffer.from(await file.arrayBuffer());
    const ext = extensionOf(file.name);
    if (uploadProblem(file.name, bytes.length, bytes) || !ext) {
      skipped.push(file.name);
      continue;
    }
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
  // The desk's reader reads the new files in the background, after the response has gone back.
  readInBackground(listingId);
  return skipped;
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

// A first filing leaves blank servicing answers off the record. An edit that loaded the stored record clears what the
// seller blanked; one that didn't (an older edit page) only writes what was typed, so nothing stored is lost.
function servicingData(input: NoteInput, clearBlanks: boolean) {
  const fields = {
    loanNumber: input.loanNumber,
    servicerName: input.servicerName,
    payString: input.payString,
    nextDueDate: input.nextDueDate,
    modified: input.modified,
    modificationDate: input.modificationDate,
    lossMitigation: input.lossMitigation,
    bankruptcyChapter: input.bankruptcyChapter,
    bankruptcyFiledAt: input.bankruptcyFiledAt,
    foreclosureFiledAt: input.foreclosureFiledAt,
    valueType: input.valueType,
    valueAsOf: input.valueAsOf,
    loanPurpose: input.loanPurpose,
    hoaLien: input.hoaLien,
    taxDelinquent: input.taxDelinquent,
    armIndex: input.armIndex,
    armMargin: input.armMargin,
    armNextReset: input.armNextReset,
    creditScore: input.creditScore,
    creditScoreType: input.creditScoreType,
    creditScoreDate: input.creditScoreDate,
    mersMin: input.mersMin,
    eNoteId: input.eNoteId,
    originatingPlatform: input.originatingPlatform,
    lossMitStage: input.lossMitStage,
    inheritedCovenants: input.inheritedCovenants,
    originatorLicense: input.originatorLicense,
    originalBalance: input.originalBalance,
    escrowBalance: input.escrowBalance,
    arrearsAmount: input.arrearsAmount,
    payoffAmount: input.payoffAmount,
    payoffAsOf: input.payoffAsOf,
    balloonDate: input.balloonDate,
    paymentType: input.paymentType,
    seniorLienBalance: input.seniorLienBalance,
    scraFlag: input.scraFlag,
    borrowerDeceased: input.borrowerDeceased,
    litigationFlag: input.litigationFlag,
    litigationNote: input.litigationNote,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => clearBlanks || value != null)) as Partial<typeof fields>;
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
    ...Object.fromEntries(SERVICING_KEYS.map((key) => [key, formData.get(key) || ""])),
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
  // Filing or resubmitting puts the listing to the desk for the firm (lib/action-gates.ts).
  const gated = await actionGate(user, "list");
  if (gated) return { user, error: gated };
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
      notes: { create: { ...noteData(input), ...servicingData(input, false) } },
    },
  });
  screenInBackground(() => screenListing(listing.id, user.id));
  const skipped = await saveDocuments(listing.id, formData);
  await prisma.reviewComment.create({
    data: { listingId: listing.id, authorId: user.id, action: "COMMENT", comment: "Submitted to the desk." },
  });
  await notifyDesk(
    `Note submitted · ${listing.title}`,
    `${user.name} submitted ${listing.title} at an ask of $${input.askingPrice.toLocaleString("en-US")}.`,
  );
  await flagDuplicates(listing.id, user.id);
  const leadId = String(formData.get("leadId") || "");
  if (leadId) {
    await prisma.sellerLead.updateMany({
      where: { id: leadId, email: user.email },
      data: { listingId: listing.id, userId: user.id, status: "LISTING" },
    });
  }
  await rescoreListing(listing.id, false);
  revalidatePath("/admin/queue");
  redirect(`/seller/listings/${listing.id}?notice=submitted${skippedNotice(skipped)}`);
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
  const data = { ...noteData(input), ...servicingData(input, formData.get("servicingLoaded") === "true") };
  // A new address or value makes the stored pin and valuation wrong, so they're cleared and read again.
  const moved =
    note.streetAddress !== data.streetAddress || note.city !== data.city || note.state !== data.state || note.zip !== data.zip ||
    Number(note.estimatedValue) !== Number(data.estimatedValue);
  // The duplicate check runs again only when what identifies the loan changed, so a resubmit doesn't repeat the flag.
  const reidentified =
    moved ||
    Number(note.upb) !== Number(data.upb) ||
    (data.loanNumber !== undefined && data.loanNumber !== note.loanNumber) ||
    (data.servicerName !== undefined && data.servicerName !== note.servicerName) ||
    (data.mersMin !== undefined && data.mersMin !== note.mersMin) ||
    data.borrowerName !== note.borrowerName;
  await prisma.note.update({
    where: { id: note.id },
    data: moved ? { ...data, latitude: null, longitude: null, avmValue: null, avmProvider: "", avmAsOf: null } : data,
  });
  // An edit that brings a field to the document's value answers the desk's question on it.
  await settleByEdit(user.id, note.id);
  await prisma.listing.update({
    where: { id: listing.id },
    data: {
      title: noteTitle(input),
      summary: input.narrative,
      status: "SUBMITTED",
      sellerFinanced: user.role === "INDIVIDUAL_SELLER" || formData.get("sellerFinanced") === "true",
    },
  });
  const skipped = await saveDocuments(listing.id, formData);
  await prisma.reviewComment.create({
    data: { listingId: listing.id, authorId: user.id, action: "COMMENT", comment: "Seller updated the file and resubmitted." },
  });
  await notifyDesk(`Resubmitted · ${noteTitle(input)}`, `${user.name} updated the listing and sent it back to review.`);
  if (reidentified) await flagDuplicates(listing.id, user.id);
  revalidatePath(`/seller/listings/${listing.id}`);
  redirect(`/seller/listings/${listing.id}?notice=resubmitted${skippedNotice(skipped)}`);
}

export async function updateOwnListingMeta(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") || "");
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  if (!listing || listing.sellerId !== user.id) redirect("/seller?error=That listing is not yours.");
  const gated = await actionGate(user, "list");
  if (gated) redirect(`/seller/listings/${listingId}?error=${encodeURIComponent(gated)}`);
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

// A pool's seller or filing broker adds files after filing, in review and while live, to the whole pool or to one
// loan. Unlike an edit, this doesn't send the listing back to review: the desk is told, and so are watchers once live.
export async function addPoolDocuments(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") || "");
  const page = formData.get("from") === "broker" ? `/broker/deals/${listingId}` : `/seller/listings/${listingId}`;
  const files = [];
  for (const file of formData.getAll("documents")) {
    if (file instanceof File && file.size > 0) files.push({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()), mime: file.type, type: String(formData.get("documentType") || "OTHER") });
  }
  if (!files.length) redirect(`${page}?error=${encodeURIComponent("Choose a file to add.")}#room-files`);
  const gated = await seatGate(user, "list");
  if (gated) redirect(`${page}?error=${encodeURIComponent(gated)}#room-files`);
  const result = await addPoolFiles(user, { listingId, noteId: String(formData.get("noteId") || "") || null, files });
  if (result.error) redirect(`${page}?error=${encodeURIComponent(result.error)}#room-files`);
  for (const path of [page, `/marketplace/${listingId}`, `/admin/listings/${listingId}`]) revalidatePath(path);
  // A mandate goes to the desk alone, so it isn't counted as in the data room.
  const said = formData.get("documentType") === "MANDATE" && page.startsWith("/broker/") ?"The mandate is with the desk. Buyers never see it." : `${result.added} file${result.added === 1 ? " is" : "s are"} in the data room.`;
  const added = result.added ? `notice=${encodeURIComponent(said)}` : "";
  redirect(`${page}?${added}${skippedNotice(result.skipped)}#room-files`);
}

export async function createPoolListing(formData: FormData) {
  const user = await requireUser();
  if (user.role !== "INSTITUTIONAL_SELLER" && user.role !== "ADMIN") {
    return { error: "Tape uploads are for institutional accounts." };
  }
  // The desk lists a tape of its own as the seller, so only a role that runs sales does.
  if (deskDenied(user, "sales")) return { error: DESK_DENIED };
  if (user.role === "INSTITUTIONAL_SELLER" && user.accountStatus !== "APPROVED") {
    return { error: "Your institutional account is still in review." };
  }
  const gated = await actionGate(user, "list");
  if (gated) return { error: gated };
  const token = String(formData.get("token") || "");
  if (!/^[0-9a-f-]{36}$/i.test(token)) return { error: "Upload the tape again." };
  const title = String(formData.get("title") || "").trim();
  const summary = String(formData.get("summary") || "").trim();
  const priceMode = String(formData.get("priceMode") || "COLUMN") as "COLUMN" | "PERCENT" | "POOL_TOTAL";
  if (title.length < 3) return { error: "Name the pool." };
  // A tape uploaded into a forward-flow programme joins it as its next tranche (lib/flow-programs.ts).
  const flowProgramId = String(formData.get("flowProgramId") || "");
  if (flowProgramId && !(await tapeProgram(user.id, flowProgramId))) return { error: "That programme isn't taking tranches." };
  let mapping: Partial<Record<TapeFieldKey, string>>;
  try {
    const parsed: unknown = JSON.parse(String(formData.get("mapping") || "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("mapping");
    mapping = Object.fromEntries(Object.entries(parsed).filter(([, header]) => typeof header === "string")) as Partial<Record<TapeFieldKey, string>>;
  } catch {
    return { error: "Map the tape's columns again." };
  }
  const draft = await readTapeDraft(user.id, token);
  if (!draft) return { error: "That tape expired. Upload it again." };
  const { parseTapeBuffer } = await import("@/lib/tape");
  const matrix = parseTapeBuffer(draft.bytes, draft.filename);
  const { loans, errors } = normalizeTapeRows({
    rows: matrix.rows,
    mapping,
    priceMode,
    pricePercent: typedNumber(formData.get("pricePercent")),
    poolTotal: typedNumber(formData.get("poolTotal")),
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
  const tapeMime = mimeFor(extensionOf(draft.filename) ?? "", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
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
  await flagDuplicates(listing.id, user.id);
  screenInBackground(() => screenListing(listing.id, user.id));
  // Tagged before it is scored, so only the programme's committed buyers match it until the release.
  const tranche = flowProgramId ? await addTranche(user, { programId: flowProgramId, listingId: listing.id }) : null;
  await rescoreListing(listing.id, false);
  revalidatePath("/admin/queue");
  redirect(`/seller/listings/${listing.id}?notice=submitted${tranche && !tranche.ok ? `&error=${encodeURIComponent(`The pool is filed but didn't join the programme: ${tranche.error}`)}` : ""}`);
}

