"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { notify } from "@/lib/email";
import { acknowledgeRoad, announceInquiry, buyerCanOpen, checkOffer, inquiryBlock, logEligibility, writeInquiry, type OfferCheck } from "@/lib/inquiry";
import { launchBlock } from "@/lib/launch-rules";
import { loanPricesFromForm, type LoanPrices } from "@/lib/loan-prices";
import { buildNdaPdf, pngFromDataUrl } from "@/lib/nda-pdf";
import { isPro } from "@/lib/settings";
import { prisma } from "@/lib/prisma";
import { requestMeta } from "@/lib/request-meta";
import { announceNda, ndaOnSign } from "@/lib/room-access";
import { putBytes } from "@/lib/storage";
import { sendForSignature } from "@/lib/vendors";
import { parseFilters } from "@/lib/filters";
import { cadenceOf, readCadence } from "@/lib/search-alerts";
import { withdrawBid } from "@/lib/awards";

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
  // Only a live listing takes NDAs. Anything else would tell a buyer, and email the seller, about a file
  // the desk hasn't released, or reopen one that has gone to contract.
  if (listing.status !== "APPROVED") redirect(`${back}?error=${encodeURIComponent("This listing isn't open for diligence.")}`);
  const coming = launchBlock(listing, "nda");
  if (coming) redirect(`${back}?error=${encodeURIComponent(coming)}`);
  if (!(await buyerCanOpen(user, listing))) redirect(`${back}?error=${encodeURIComponent("This listing isn't open on your membership yet.")}`);
  // A seller who approves each bidder holds a first signature until they decide. Signing again can't reset that.
  const access = ndaOnSign(listing, await prisma.ndaAcknowledgment.findUnique({ where: { userId_listingId: { userId: user.id, listingId } }, select: { accessStatus: true } }));
  if (access.block) redirect(`${back}?error=${encodeURIComponent(access.block)}`);
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
      ...(access.create ? { accessStatus: access.create } : {}),
    },
  });
  const pending = access.create === "PENDING";
  await audit(user.id, "NDA", "listing", listingId, signerName);
  // The seller hears which bidder letter signed, not who; the desk's log keeps the name.
  await announceNda(listing, user.id, pending);
  await notify(
    user.email,
    `Your signed NDA · ${listing.title}`,
    `Signed ${signedAt.toISOString()} from ${meta.ipAddress}. A copy is in the data room.${pending ? " The seller approves each bidder on this listing, so the room opens once they do. You'll hear when they decide." : ""}`,
  );
  revalidatePath(back);
  redirect(pending ? `${back}?notice=${encodeURIComponent("The agreement is signed. The seller approves each bidder here, so the room opens once they do.")}` : `${back}?notice=nda`);
}

export async function submitInquiry(formData: FormData) {
  const user = await requireBuyer();
  const listingId = String(formData.get("listingId") || "");
  const type = String(formData.get("type") || "INFO_REQUEST");
  const message = String(formData.get("message") || "").trim();
  const back = `/marketplace/${listingId}`;
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { seller: true } });
  const noteId = String(formData.get("noteId") || "");
  let amount: number | null = null;
  let expiresAt: Date | null = null;
  let passed: Extract<OfferCheck, { error: null }> | null = null;
  let loanPrices: LoanPrices | null = null;
  let allowPartial = false;
  if (type === "OFFER") {
    // The same checks a confirmed standing bid runs, in lib/inquiry.ts.
    amount = Number(String(formData.get("amount") || "").replace(/[$,]/g, ""));
    // A whole-pool bid may price each loan. The check holds the prices to the bid.
    const priced = loanPricesFromForm(formData);
    if (priced.error) redirect(`${back}?error=${encodeURIComponent(priced.error)}#offer`);
    loanPrices = priced.prices;
    allowPartial = priced.allowPartial;
    const check = await checkOffer({ user, listing, noteId, amount, goodUntil: String(formData.get("goodUntil") || ""), loanPrices, allowPartial });
    if (check.error !== null) redirect(check.verification ? `/buyer/verification?error=${encodeURIComponent(check.error)}` : `${back}?error=${encodeURIComponent(check.error)}`);
    expiresAt = check.expiresAt;
    passed = check;
  } else {
    const blocked = await inquiryBlock(user, listing);
    if (blocked) redirect(`${back}?error=${encodeURIComponent(blocked)}`);
    if (type === "DATA_ROOM" && !isPro(user)) redirect("/buyer/subscription?reason=dataroom");
  }
  if (!listing) redirect(back);
  const input = { user, listing, type, noteId, amount, message, expiresAt, loanPrices, allowPartial };
  const inquiry = await writeInquiry(input);
  await announceInquiry(inquiry, input);
  if (passed) await logEligibility(user.id, inquiry.id, passed);
  revalidatePath("/admin/offers");
  redirect(`${back}?notice=inquiry`);
}

// A buyer who says they control 350 or more homes acknowledges the ROAD Act notice once on a listing, before
// bidding on it. The acknowledgement is logged with their stated count.
export async function acknowledgeRoadNotice(formData: FormData) {
  const user = await requireBuyer();
  const listingId = String(formData.get("listingId") || "");
  const back = `/marketplace/${listingId}`;
  if (String(formData.get("acknowledged") || "") !== "yes") redirect(`${back}?error=${encodeURIComponent("Tick the box to acknowledge the notice.")}#eligibility`);
  const result = await acknowledgeRoad(user, listingId);
  if (result.error !== null) redirect(`${back}?error=${encodeURIComponent(result.error)}`);
  revalidatePath(back);
  redirect(`${back}?notice=${encodeURIComponent("Acknowledged. You can bid on this listing.")}#offer`);
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
  // A form without a cadence alerts as each listing goes live, as before.
  const cadence = readCadence(formData.get("cadence")) ?? "INSTANT";
  await prisma.savedSearch.create({ data: { userId: user.id, name, filters, cadence } });
  redirect("/buyer/alerts?notice=saved");
}

export async function toggleSearchAlert(formData: FormData) {
  const user = await requireBuyer();
  const id = String(formData.get("id") || "");
  const search = await prisma.savedSearch.findUnique({ where: { id } });
  if (!search || search.userId !== user.id) return;
  // A resumed search starts its roundup window now, so it doesn't send what went live while it was paused.
  await prisma.savedSearch.update({ where: { id }, data: { alertEnabled: !search.alertEnabled, ...(search.alertEnabled ? {} : { lastAlertAt: new Date() }) } });
  revalidatePath("/buyer/alerts");
}

export async function setSearchCadence(formData: FormData) {
  const user = await requireBuyer();
  const id = String(formData.get("id") || "");
  const cadence = readCadence(formData.get("cadence"));
  const search = await prisma.savedSearch.findUnique({ where: { id } });
  if (!search || search.userId !== user.id) return;
  if (!cadence) redirect(`/buyer/alerts?error=${encodeURIComponent("Choose how often this search alerts.")}`);
  // Instant alerts already covered everything up to now, so a first roundup starts from here.
  const fromNow = cadenceOf(search) === "INSTANT" && cadence !== "INSTANT";
  await prisma.savedSearch.update({ where: { id }, data: { cadence, ...(fromNow ? { lastAlertAt: new Date() } : {}) } });
  revalidatePath("/buyer/alerts");
  redirect(`/buyer/alerts?notice=${encodeURIComponent(cadence === "INSTANT" ? "That search now alerts as each listing goes live." : `That search now sends a ${cadence === "DAILY" ? "daily" : "weekly"} roundup.`)}`);
}

export async function deleteSearch(formData: FormData) {
  const user = await requireBuyer();
  const id = String(formData.get("id") || "");
  await prisma.savedSearch.deleteMany({ where: { id, userId: user.id } });
  revalidatePath("/buyer/alerts");
}
