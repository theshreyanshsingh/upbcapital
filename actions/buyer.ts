"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canSubmitBid, sealedFromSeller } from "@/lib/auction";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { notify, notifyDesk } from "@/lib/email";
import { buildNdaPdf, pngFromDataUrl } from "@/lib/nda-pdf";
import { isPro } from "@/lib/settings";
import { prisma } from "@/lib/prisma";
import { requestMeta } from "@/lib/request-meta";
import { putBytes } from "@/lib/storage";
import { ensureInquiryThread } from "@/lib/threads";
import { sendForSignature } from "@/lib/vendors";
import { canSubmitOffer } from "@/lib/verification";
import type { BookFilters } from "@/lib/filters";

async function requireBuyer() {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  if (user.accountStatus !== "APPROVED") redirect("/buyer/pending");
  return user;
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
  if (type === "DATA_ROOM" && !isPro(user)) {
    redirect("/buyer/subscription?reason=dataroom");
  }
  const noteId = String(formData.get("noteId") || "");
  let amount: number | null = null;
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
    }
    const existing = await prisma.inquiry.findFirst({
      where: { listingId, buyerId: user.id, type: "OFFER", noteId: noteId || null, status: { in: ["OPEN", "REVIEWED", "ACCEPTED"] } },
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
    },
  });
  if (type === "OFFER" && amount != null) {
    await prisma.offerMessage.create({
      data: { inquiryId: inquiry.id, authorId: user.id, kind: "OFFER", amount, body: message || "Opening bid." },
    });
  }
  await ensureInquiryThread(inquiry.id);
  const label = type === "OFFER" ? `Offer of $${Math.round(amount || 0).toLocaleString("en-US")}` : type === "DATA_ROOM" ? "Data room request" : "Information request";
  const sealed = type === "OFFER" && sealedFromSeller(listing);
  if (sealed) {
    await notify(listing.seller.email, `Sealed bid · ${listing.title}`, `${user.name} (${user.email}) placed a sealed bid. The amount opens at the deadline.`);
  } else {
    await notify(listing.seller.email, `${label} · ${listing.title}`, `${user.name} (${user.email}) wrote: ${message || "No message."}`);
  }
  await notifyDesk(`${label} · ${listing.title}`, `From ${user.name} (${user.email}). ${message || ""}`);
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

export async function saveSearch(formData: FormData) {
  const user = await requireBuyer();
  if (!isPro(user)) redirect("/buyer/subscription?reason=alerts");
  const name = String(formData.get("name") || "").trim();
  if (name.length < 2) redirect("/marketplace?error=Name the search before saving it.");
  const filters = JSON.parse(String(formData.get("filters") || "{}")) as BookFilters;
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
