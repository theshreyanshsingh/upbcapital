"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canSubmitBid, sealedFromSeller } from "@/lib/auction";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { notify, notifyDesk } from "@/lib/email";
import { buildNdaPdf, pngFromDataUrl } from "@/lib/nda-pdf";
import { canOpenListing, openableListingIds } from "@/lib/access";
import { getSettings, isPro } from "@/lib/settings";
import { prisma } from "@/lib/prisma";
import { requestMeta } from "@/lib/request-meta";
import { putBytes } from "@/lib/storage";
import { ensureInquiryThread } from "@/lib/threads";
import { sendForSignature } from "@/lib/vendors";
import { canSubmitOffer } from "@/lib/verification";
import type { ListingStatus } from "@prisma/client";
import { parseFilters } from "@/lib/filters";
import { unset } from "@/lib/db-filters";
import { withdrawBid } from "@/lib/awards";
import { readGoodUntil } from "@/lib/offers";

async function requireBuyer() {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  if (user.accountStatus !== "APPROVED") redirect("/buyer/pending");
  return user;
}

// The listing page refuses early-access listings and those outside the free slice. The actions behind it hold
// the same line, since their IDs are in the page bundle.
async function canOpen(user: Awaited<ReturnType<typeof requireBuyer>>, listing: { id: string; status: ListingStatus; approvedAt: Date | null; sellerId: string; brokerId: string | null }) {
  const settings = await getSettings();
  const live = isPro(user)
    ? []
    : await prisma.listing.findMany({ where: { status: { in: ["APPROVED", "PENDING"] } }, select: { id: true, status: true, approvedAt: true } });
  return canOpenListing({
    viewer: user,
    status: listing.status,
    approvedAt: listing.approvedAt,
    earlyAccessHours: settings.earlyAccessHours,
    openableIds: openableListingIds(live, settings.earlyAccessHours, settings.freeBrowseLimit),
    listingId: listing.id,
    sellerId: listing.sellerId,
    brokerId: listing.brokerId,
  }).ok;
}

export async function toggleFavorite(formData: FormData) {
  const user = await requireBuyer();
  const listingId = String(formData.get("listingId") || "");
  const existing = await prisma.favorite.findUnique({ where: { userId_listingId: { userId: user.id, listingId } } });
  if (existing) {
    await prisma.favorite.delete({ where: { id: existing.id } });
  } else {
    await prisma.favorite.create({ data: { userId: user.id, listingId } });
  }
  revalidatePath("/marketplace");
  revalidatePath(`/marketplace/${listingId}`);
  revalidatePath("/buyer/favorites");
}

export async function signNda(formData: FormData) {
  const user = await requireBuyer();
  const listingId = String(formData.get("listingId") || "");
  const back = `/marketplace/${listingId}`;
  if (String(formData.get("agreed") || "") !== "yes") {
    redirect(`${back}?error=${encodeURIComponent("Sign the confidentiality terms first.")}`);
  }
  const method = String(formData.get("method") || "");
  const signerName = String(formData.get("signerName") || "").trim();
  if (signerName.length < 2) redirect(`${back}?error=${encodeURIComponent("Type the name you are signing with.")}`);
  const drawn = method === "DRAWN" ? pngFromDataUrl(String(formData.get("signatureData") || "")) : null;
  if (method === "DRAWN" && !drawn) redirect(`${back}?error=${encodeURIComponent("Draw your signature, or switch to a typed signature.")}`);
  if (method !== "TYPED" && method !== "DRAWN") redirect(`${back}?error=Choose how you are signing.`);
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { seller: true } });
  if (!listing) redirect("/marketplace");
  // Only a live listing takes NDAs. Anything else would tell a buyer, and email the seller, about a file
  // the desk hasn't released, or reopen one that has gone to contract.
  if (listing.status !== "APPROVED") redirect(`${back}?error=${encodeURIComponent("This listing isn't open for diligence.")}`);
  if (!(await canOpen(user, listing))) redirect(`${back}?error=${encodeURIComponent("This listing isn't open on your membership yet.")}`);
  const meta = await requestMeta();
  const signedAt = new Date();
  const signatureKey = drawn ? `signatures/${user.id}/${listingId}.png` : "";
  if (drawn) await putBytes(signatureKey, drawn, "image/png");
  const pdf = await buildNdaPdf({
    listingTitle: listing.title,
    listingId,
    signerName,
    signerEmail: user.email,
    method,
    signedAt,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    signaturePng: drawn,
  });
  const pdfKey = `ndas/${user.id}/${listingId}.pdf`;
  await putBytes(pdfKey, pdf, "application/pdf");
  const signed = await sendForSignature({
    title: `Confidentiality · ${listing.title}`,
    signerName,
    signerEmail: user.email,
    pdf,
    kind: "nda",
  });
  const document = await prisma.document.create({
    data: {
      listingId,
      type: "NDA",
      originalName: `NDA-${signerName.replace(/[^\w.-]+/g, "_").slice(0, 40)}.pdf`,
      storedName: pdfKey,
      mime: "application/pdf",
      size: pdf.length,
    },
  });
  await prisma.ndaAcknowledgment.upsert({
    where: { userId_listingId: { userId: user.id, listingId } },
    update: {
      acknowledgedAt: signedAt,
      signerName,
      method,
      signatureKey,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      pdfKey,
      documentId: document.id,
      signatureProvider: signed.provider,
      signatureRef: signed.id,
    },
    create: {
      userId: user.id,
      listingId,
      acknowledgedAt: signedAt,
      signerName,
      method,
      signatureKey,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      pdfKey,
      documentId: document.id,
      signatureProvider: signed.provider,
      signatureRef: signed.id,
    },
  });
  await audit(user.id, "NDA", "listing", listingId, signerName);
  await notify(listing.seller.email, `NDA signed · ${listing.title}`, `${signerName} signed confidentiality on ${listing.title}. The PDF is in the data room.`);
  await notify(user.email, `Your signed NDA · ${listing.title}`, `Signed ${signedAt.toISOString()} from ${meta.ipAddress}. A copy is in the data room.`);
  revalidatePath(back);
  redirect(`${back}?notice=nda`);
}

export async function submitInquiry(formData: FormData) {
  const user = await requireBuyer();
  const listingId = String(formData.get("listingId") || "");
  const type = String(formData.get("type") || "INFO_REQUEST");
  const message = String(formData.get("message") || "").trim();
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { seller: true } });
  if (!listing || listing.status !== "APPROVED") {
    redirect(`/marketplace/${listingId}?error=This listing is not taking new inquiries.`);
  }
  if (!(await canOpen(user, listing))) {
    redirect(`/marketplace/${listingId}?error=${encodeURIComponent("This listing isn't open on your membership yet.")}`);
  }
  if (type === "DATA_ROOM" && !isPro(user)) {
    redirect("/buyer/subscription?reason=dataroom");
  }
  const noteId = String(formData.get("noteId") || "");
  let amount: number | null = null;
  let expiresAt: Date | null = null;
  if (type === "OFFER") {
    const profile = await prisma.buyerProfile.findUnique({ where: { userId: user.id } });
    const gate = canSubmitOffer({ role: user.role, accountStatus: user.accountStatus, verificationStatus: profile?.status ?? null });
    if (!gate.ok) redirect(`/buyer/verification?error=${encodeURIComponent("The desk has to approve your buyer file before you can offer.")}`);
    amount = Number(String(formData.get("amount") || "").replace(/[$,]/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) {
      redirect(`/marketplace/${listingId}?error=Enter an offer amount.`);
    }
    if (noteId) {
      const note = await prisma.note.findFirst({ where: { id: noteId, listingId } });
      if (!note || note.tradeStatus !== "AVAILABLE") {
        redirect(`/marketplace/${listingId}?error=${encodeURIComponent("That loan is not open for a bid.")}`);
      }
    } else if (listing.kind === "POOL" && (await prisma.note.count({ where: { listingId, tradeStatus: { not: "AVAILABLE" } } })) > 0) {
      // A whole-pool bid on a pool with traded loans could never be awarded.
      redirect(`/marketplace/${listingId}?error=${encodeURIComponent("Some loans in this pool have traded, so it can't be bid whole. Bid the loans still for sale.")}`);
    }
    const goodUntil = readGoodUntil(String(formData.get("goodUntil") || ""), listing);
    if (goodUntil.error) redirect(`/marketplace/${listingId}?error=${encodeURIComponent(goodUntil.error)}`);
    expiresAt = goodUntil.expiresAt;
    const existing = await prisma.inquiry.findFirst({
      // A whole-listing offer may have no noteId field at all, which `noteId: null` alone would miss.
      // Best and final is one bid per buyer, so one they withdrew still counts; otherwise withdrawing would be a way
      // to change the price.
      where: {
        listingId,
        buyerId: user.id,
        type: "OFFER",
        ...(noteId ? { noteId } : unset("noteId")),
        status: { in: listing.bidMode === "BEST_AND_FINAL" ? ["OPEN", "REVIEWED", "ACCEPTED", "WITHDRAWN", "EXPIRED"] : ["OPEN", "REVIEWED", "ACCEPTED"] },
      },
    });
    const gateBid = canSubmitBid({ bidMode: listing.bidMode, deadline: listing.bidDeadline, alreadyBid: Boolean(existing) });
    if (!gateBid.ok) {
      const reason = gateBid.reason === "deadline"
        ? "The bid deadline has passed."
        : "Best and final allows one bid on this listing.";
      redirect(`/marketplace/${listingId}?error=${encodeURIComponent(reason)}`);
    }
  }
  const inquiry = await prisma.inquiry.create({
    data: {
      listingId,
      buyerId: user.id,
      noteId: type === "OFFER" && noteId ? noteId : null,
      type: type === "OFFER" ? "OFFER" : type === "DATA_ROOM" ? "DATA_ROOM" : "INFO_REQUEST",
      amount,
      message,
      ...(expiresAt ? { expiresAt } : {}),
    },
  });
  if (type === "OFFER" && amount != null) {
    await prisma.offerMessage.create({
      data: { inquiryId: inquiry.id, authorId: user.id, kind: "OFFER", amount, body: message || "Opening bid." },
    });
  }
  await ensureInquiryThread(inquiry.id);
  const label = type === "OFFER" ? `Offer of $${Math.round(amount || 0).toLocaleString("en-US")}` : type === "DATA_ROOM" ? "Data room request" : "Information request";
  const until = expiresAt ? ` Good until ${expiresAt.toISOString().slice(0, 10)}.` : "";
  const sealed = type === "OFFER" && sealedFromSeller(listing);
  if (sealed) {
    await notify(listing.seller.email, `Sealed bid · ${listing.title}`, `${user.name} (${user.email}) placed a sealed bid. The amount opens at the deadline.`);
  } else {
    await notify(listing.seller.email, `${label} · ${listing.title}`, `${user.name} (${user.email}) wrote: ${message || "No message."}`);
  }
  await notifyDesk(`${label} · ${listing.title}`, `From ${user.name} (${user.email}).${until} ${message || ""}`);
  if (type === "OFFER") {
    const { emitWebhook } = await import("@/lib/webhooks");
    await emitWebhook(listing.sellerId, "offer.created", {
      inquiryId: inquiry.id,
      listingId: listing.id,
      amount: sealed ? null : amount,
      sealed,
      status: inquiry.status,
    });
  }
  revalidatePath("/admin/offers");
  redirect(`/marketplace/${listingId}?notice=inquiry`);
}

// The buyer takes back a bid the desk hasn't accepted. A group's bid comes back through the group page instead.
export async function withdrawInquiry(formData: FormData) {
  const user = await requireBuyer();
  const inquiryId = String(formData.get("inquiryId") || "");
  const result = await withdrawBid(inquiryId, user.id);
  if (result.error !== null) {
    redirect(result.groupId ? `/groups/${result.groupId}?error=${encodeURIComponent(result.error)}` : `/buyer/offers?error=${encodeURIComponent(result.error)}`);
  }
  revalidatePath("/buyer/offers");
  revalidatePath("/admin/offers");
  redirect(`/buyer/offers?notice=${encodeURIComponent("Your bid is withdrawn, and the desk was told.")}`);
}

export async function saveSearch(formData: FormData) {
  const user = await requireBuyer();
  if (!isPro(user)) redirect("/buyer/subscription?reason=alerts");
  const name = String(formData.get("name") || "").trim();
  if (name.length < 2) redirect("/marketplace?error=Name the search before saving it.");
  // The filters come back from the page as JSON. Anything else is read as no filter rather than a crash.
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(formData.get("filters") || "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    redirect("/marketplace?error=Set the filters again, then save.");
  }
  const filters = parseFilters(Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value == null ? undefined : String(value)])));
  await prisma.savedSearch.create({ data: { userId: user.id, name, filters } });
  redirect("/buyer/alerts?notice=saved");
}

export async function toggleSearchAlert(formData: FormData) {
  const user = await requireBuyer();
  const id = String(formData.get("id") || "");
  const search = await prisma.savedSearch.findUnique({ where: { id } });
  if (!search || search.userId !== user.id) return;
  await prisma.savedSearch.update({ where: { id }, data: { alertEnabled: !search.alertEnabled } });
  revalidatePath("/buyer/alerts");
}

export async function deleteSearch(formData: FormData) {
  const user = await requireBuyer();
  const id = String(formData.get("id") || "");
  await prisma.savedSearch.deleteMany({ where: { id, userId: user.id } });
  revalidatePath("/buyer/alerts");
}
