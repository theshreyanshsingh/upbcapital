"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { AccountStatus, ListingStatus, ReviewAction } from "@prisma/client";
import { alertMatchingSearches } from "@/actions/listings";
import { deadlinePassed } from "@/lib/auction";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth";
import { notify } from "@/lib/email";
import { openClosing } from "@/lib/closing-service";
import { onGroupAccepted, onGroupDeclined } from "@/actions/group";
import { rescoreListing } from "@/lib/matching";
import { feeBreakdown, percentToBps } from "@/lib/money";
import { workingAmount } from "@/lib/offers";
import { prisma } from "@/lib/prisma";
import { clearSettingsCache, getSettings } from "@/lib/settings";
import { syncProPrice } from "@/lib/stripe-sync";

async function admin() {
  return requireRole(["ADMIN"]);
}

function back(listingId: string, notice: string) {
  revalidatePath("/admin/queue");
  revalidatePath("/marketplace");
  revalidatePath(`/admin/listings/${listingId}`);
  revalidatePath(`/marketplace/${listingId}`);
  redirect(`/admin/listings/${listingId}?notice=${encodeURIComponent(notice)}`);
}

export async function reviewListing(formData: FormData) {
  const user = await admin();
  const listingId = String(formData.get("listingId") || "");
  const action = String(formData.get("action") || "");
  const comment = String(formData.get("comment") || "").trim();
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    include: { seller: true, notes: true },
  });
  if (!listing) redirect("/admin/queue?error=Listing not found.");

  const needsComment = action === "REJECT" || action === "REQUEST_CHANGES";
  if (needsComment && comment.length < 3) {
    redirect(`/admin/listings/${listingId}?error=${encodeURIComponent("A comment is required for that decision.")}`);
  }

  if (action === "UNDER_REVIEW") {
    await prisma.listing.update({ where: { id: listingId }, data: { status: "UNDER_REVIEW" } });
    await record(user.id, listingId, "UNDER_REVIEW", comment || "Moved into review.");
    await notify(listing.seller.email, `In review · ${listing.title}`, comment || "The desk is reading the file.");
    back(listingId, "Moved to review");
  }

  if (action === "APPROVE") {
    await prisma.listing.update({
      where: { id: listingId },
      data: { status: "APPROVED", approvedAt: new Date() },
    });
    await record(user.id, listingId, "APPROVE", comment || "Approved for the book.");
    await notify(listing.seller.email, `Live · ${listing.title}`, comment || "Your listing is live to approved buyers.");
    await alertMatchingSearches(listingId);
    await rescoreListing(listingId, true);
    back(listingId, "Listing is live");
  }

  if (action === "REJECT") {
    await prisma.listing.update({ where: { id: listingId }, data: { status: "REJECTED" } });
    await record(user.id, listingId, "REJECT", comment);
    await notify(listing.seller.email, `Declined · ${listing.title}`, comment);
    back(listingId, "Listing declined");
  }

  if (action === "REQUEST_CHANGES") {
    await prisma.listing.update({ where: { id: listingId }, data: { status: "CHANGES_REQUESTED" } });
    await record(user.id, listingId, "REQUEST_CHANGES", comment);
    await notify(listing.seller.email, `Changes requested · ${listing.title}`, comment);
    back(listingId, "Changes requested");
  }

  if (action === "MARK_PENDING") {
    await prisma.listing.update({ where: { id: listingId }, data: { status: "PENDING" } });
    await record(user.id, listingId, "MARK_PENDING", comment || "Marked in contract.");
    await notify(listing.seller.email, `In contract · ${listing.title}`, comment || "The desk marked this listing in contract.");
    back(listingId, "Marked in contract");
  }

  if (action === "MARK_SOLD") {
    if (listing.status === "SOLD") {
      redirect(`/admin/listings/${listingId}?error=${encodeURIComponent("This listing is already sold.")}`);
    }
    const openClosingRow = await prisma.closing.findFirst({ where: { listingId, status: "OPEN" } });
    if (openClosingRow) {
      redirect(`/closings/${openClosingRow.id}?error=${encodeURIComponent("This listing has an open closing. Mark it closed there so the ledger posts once.")}`);
    }
    const salePrice = Number(String(formData.get("salePrice") || "").replace(/[$,]/g, ""));
    if (!Number.isFinite(salePrice) || salePrice <= 0) {
      redirect(`/admin/listings/${listingId}?error=${encodeURIComponent("Enter the accepted sale price.")}`);
    }
    const settings = await getSettings();
    const fees = feeBreakdown(salePrice, settings.buyerPremiumBps, settings.sellerCommissionBps);
    await prisma.listing.update({
      where: { id: listingId },
      data: {
        status: "SOLD",
        soldAt: new Date(),
        salePrice,
        buyerPremiumCents: fees.premiumCents,
        sellerCommissionCents: fees.commissionCents,
        buyerTotalCents: fees.buyerTotalCents,
        netToSellerCents: fees.netToSellerCents,
      },
    });
    await prisma.revenueEvent.create({
      data: {
        type: "BUYER_PREMIUM",
        amountCents: fees.premiumCents,
        listingId,
        description: `Buyer premium on ${listing.title}`,
      },
    });
    await prisma.revenueEvent.create({
      data: {
        type: "SELLER_COMMISSION",
        amountCents: fees.commissionCents,
        listingId,
        description: `Seller commission on ${listing.title}`,
      },
    });
    await record(user.id, listingId, "MARK_SOLD", comment || `Sold at $${salePrice.toLocaleString("en-US")}.`);
    await notify(
      listing.seller.email,
      `Sold · ${listing.title}`,
      `Sale price $${salePrice.toLocaleString("en-US")}. Commission $${(fees.commissionCents / 100).toLocaleString("en-US")}. Estimated net $${(fees.netToSellerCents / 100).toLocaleString("en-US")}.`,
    );
    back(listingId, "Marked sold");
  }

  redirect(`/admin/listings/${listingId}?error=Unknown action.`);
}

async function record(authorId: string, listingId: string, action: ReviewAction, comment: string) {
  await prisma.reviewComment.create({ data: { authorId, listingId, action, comment } });
  await audit(authorId, action, "listing", listingId, comment);
}

export async function adminUpdateListing(formData: FormData) {
  const user = await admin();
  const listingId = String(formData.get("listingId") || "");
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { notes: true } });
  if (!listing) redirect("/admin/queue");
  const title = String(formData.get("title") || "").trim();
  const summary = String(formData.get("summary") || "").trim();
  await prisma.listing.update({
    where: { id: listingId },
    data: { title: title || listing.title, summary },
  });

  if (listing.kind === "SINGLE" && listing.notes[0]) {
    const note = listing.notes[0];
    const num = (key: string, fallback: number) => {
      const value = Number(String(formData.get(key) || "").replace(/[$,]/g, ""));
      return Number.isFinite(value) ? value : fallback;
    };
    await prisma.note.update({
      where: { id: note.id },
      data: {
        streetAddress: String(formData.get("streetAddress") || note.streetAddress),
        city: String(formData.get("city") || note.city),
        state: String(formData.get("state") || note.state).toUpperCase(),
        zip: String(formData.get("zip") || note.zip),
        upb: num("upb", Number(note.upb)),
        askingPrice: num("askingPrice", Number(note.askingPrice)),
        estimatedValue: num("estimatedValue", Number(note.estimatedValue)),
        interestRate: num("interestRate", Number(note.interestRate)),
        monthlyPi: num("monthlyPi", Number(note.monthlyPi)),
        monthsDelinquent: Math.round(num("monthsDelinquent", note.monthsDelinquent)),
        borrowerName: String(formData.get("borrowerName") || ""),
        memo: summary,
      },
    });
  }

  if (listing.kind === "POOL") {
    for (const note of listing.notes) {
      const upb = Number(formData.get(`upb_${note.id}`));
      const askingPrice = Number(formData.get(`ask_${note.id}`));
      const estimatedValue = Number(formData.get(`value_${note.id}`));
      const data: { upb?: number; askingPrice?: number; estimatedValue?: number; paymentStatus?: "PERFORMING" | "NON_PERFORMING" | "SUB_PERFORMING" } = {};
      if (Number.isFinite(upb) && upb > 0) data.upb = upb;
      if (Number.isFinite(askingPrice) && askingPrice > 0) data.askingPrice = askingPrice;
      if (Number.isFinite(estimatedValue) && estimatedValue > 0) data.estimatedValue = estimatedValue;
      const payment = String(formData.get(`status_${note.id}`) || "");
      if (payment === "PERFORMING" || payment === "NON_PERFORMING" || payment === "SUB_PERFORMING") data.paymentStatus = payment;
      if (Object.keys(data).length) await prisma.note.update({ where: { id: note.id }, data });
    }
  }

  await record(user.id, listingId, "EDIT", "Desk edited the listing.");
  back(listingId, "Listing updated");
}

export async function decideInquiry(formData: FormData) {
  const user = await admin();
  const inquiryId = String(formData.get("inquiryId") || "");
  const decision = String(formData.get("decision") || "");
  const inquiry = await prisma.inquiry.findUnique({
    where: { id: inquiryId },
    include: { buyer: true, listing: { include: { seller: true } } },
  });
  if (!inquiry) redirect("/admin/offers");
  if (decision === "ACCEPT" && inquiry.type === "OFFER") {
    if (inquiry.listing.bidMode !== "NONE" && !deadlinePassed(inquiry.listing.bidDeadline)) {
      redirect(`/admin/offers?error=${encodeURIComponent("Award this after the bid deadline.")}`);
    }
    const messages = await prisma.offerMessage.findMany({ where: { inquiryId: inquiry.id } });
    const price = workingAmount(
      inquiry.amount ? Number(inquiry.amount) : null,
      messages.map((message) => ({ kind: message.kind, amount: message.amount ? Number(message.amount) : null, createdAt: message.createdAt })),
    );
    if (!price || price <= 0) redirect("/admin/offers?error=That offer has no amount.");
    await prisma.inquiry.update({ where: { id: inquiry.id }, data: { status: "ACCEPTED", amount: price } });
    if (inquiry.noteId) {
      await prisma.note.update({ where: { id: inquiry.noteId }, data: { tradeStatus: "IN_CONTRACT" } });
    } else if (inquiry.listing.status !== "SOLD") {
      await prisma.listing.update({
        where: { id: inquiry.listingId },
        data: { status: "PENDING" satisfies ListingStatus, acceptedInquiryId: inquiry.id },
      });
    }
    const closing = await openClosing({
      listingId: inquiry.listingId,
      inquiryId: inquiry.id,
      noteId: inquiry.noteId,
      salePrice: price,
      title: inquiry.listing.title,
    });
    await onGroupAccepted(inquiry.id, closing.id, closing.buyerPremiumCents);
    const { emitWebhook } = await import("@/lib/webhooks");
    await emitWebhook(inquiry.listing.sellerId, "offer.accepted", {
      inquiryId: inquiry.id,
      listingId: inquiry.listingId,
      closingId: closing.id,
      amount: price,
    });
    const link = `${process.env.NEXT_PUBLIC_APP_URL || ""}/closings/${closing.id}`;
    await notify(inquiry.buyer.email, `Offer accepted · ${inquiry.listing.title}`, `The desk accepted $${price.toLocaleString("en-US")}. The closing checklist is open: ${link}`);
    await notify(inquiry.listing.seller.email, `Offer accepted · ${inquiry.listing.title}`, `${inquiry.buyer.name}'s offer was accepted. Closing checklist: ${link}`);
  } else if (decision === "DECLINE") {
    await prisma.inquiry.update({ where: { id: inquiry.id }, data: { status: "DECLINED" } });
    await onGroupDeclined(inquiry.id);
    const { emitWebhook } = await import("@/lib/webhooks");
    await emitWebhook(inquiry.listing.sellerId, "offer.declined", { inquiryId: inquiry.id, listingId: inquiry.listingId });
    await notify(inquiry.buyer.email, `Inquiry declined · ${inquiry.listing.title}`, "The desk declined this inquiry.");
  } else {
    await prisma.inquiry.update({ where: { id: inquiry.id }, data: { status: "REVIEWED" } });
  }
  await prisma.reviewComment.create({
    data: {
      listingId: inquiry.listingId,
      authorId: user.id,
      action: "COMMENT",
      comment: `Inquiry ${decision.toLowerCase()} for ${inquiry.buyer.name}.`,
    },
  });
  await audit(user.id, decision === "ACCEPT" ? "AWARD" : `INQUIRY_${decision}`, "inquiry", inquiry.id, inquiry.listing.title);
  revalidatePath("/admin/offers");
  revalidatePath(`/admin/listings/${inquiry.listingId}`);
  redirect(`/admin/offers?notice=${encodeURIComponent(decision.toLowerCase())}`);
}

export async function setAccountStatus(formData: FormData) {
  const actor = await admin();
  const userId = String(formData.get("userId") || "");
  const status = String(formData.get("status") || "") as AccountStatus;
  if (userId === actor.id) redirect("/admin/users?error=You cannot change your own account.");
  if (status !== "APPROVED" && status !== "REJECTED" && status !== "PENDING") redirect("/admin/users");
  const user = await prisma.user.update({ where: { id: userId }, data: { accountStatus: status } });
  await audit(actor.id, "ACCOUNT", "user", user.id, status);
  await notify(user.email, `Account ${status.toLowerCase()}`, `Your UPB Capital account is now ${status.toLowerCase()}.`);
  revalidatePath("/admin/users");
  redirect("/admin/users?notice=updated");
}

export async function setMembership(formData: FormData) {
  await admin();
  const userId = String(formData.get("userId") || "");
  const tier = String(formData.get("tier") || "FREE");
  if (tier === "PRO") {
    await prisma.user.update({
      where: { id: userId },
      data: {
        subscriptionTier: "PRO",
        subscriptionStatus: "ACTIVE",
        subscriptionComped: true,
        subscriptionCurrentPeriodEnd: new Date(Date.now() + 30 * 86400000),
      },
    });
  } else {
    await prisma.user.update({
      where: { id: userId },
      data: { subscriptionTier: "FREE", subscriptionStatus: "CANCELED", subscriptionComped: false },
    });
  }
  revalidatePath("/admin/users");
  redirect("/admin/users?notice=membership");
}

export async function saveSettings(formData: FormData) {
  await admin();
  const premium = Number(formData.get("buyerPremium"));
  const commission = Number(formData.get("sellerCommission"));
  const price = Number(formData.get("proPrice"));
  const early = Number(formData.get("earlyAccessHours"));
  const limit = Number(formData.get("freeBrowseLimit"));
  if ([premium, commission, price, early, limit].some((value) => !Number.isFinite(value))) {
    redirect("/admin/settings?error=Enter numbers only.");
  }
  if (premium < 0 || premium > 15 || commission < 0 || commission > 15) {
    redirect("/admin/settings?error=Keep premium and commission between 0% and 15%.");
  }
  if (price < 0 || price > 5000) redirect("/admin/settings?error=Pro price must be between $0 and $5,000.");
  if (early < 0 || early > 336) redirect("/admin/settings?error=Early access can run from 0 to 336 hours.");
  if (limit < 1 || limit > 100) redirect("/admin/settings?error=Free browse limit must be between 1 and 100.");
  const brokerBasis = String(formData.get("brokerFeeBasis") || "PERCENT");
  const affiliateBasis = String(formData.get("affiliateFeeBasis") || "PERCENT");
  const brokerPercent = Number(formData.get("brokerFeePercent"));
  const brokerFlat = Number(formData.get("brokerFeeFlat"));
  const affiliatePercent = Number(formData.get("affiliateFeePercent"));
  const affiliateFlat = Number(formData.get("affiliateFeeFlat"));
  if (![brokerPercent, brokerFlat, affiliatePercent, affiliateFlat].every((value) => Number.isFinite(value))) {
    redirect("/admin/settings?error=Enter numbers for the broker fees.");
  }
  if (brokerBasis !== "PERCENT" && brokerBasis !== "FLAT") redirect("/admin/settings?error=Choose a broker fee basis.");
  if (affiliateBasis !== "PERCENT" && affiliateBasis !== "FLAT") redirect("/admin/settings?error=Choose an affiliate fee basis.");
  if (brokerPercent < 0 || brokerPercent > 100 || affiliatePercent < 0 || affiliatePercent > 100) {
    redirect("/admin/settings?error=Broker percentages stay between 0 and 100.");
  }
  if (brokerFlat < 0 || affiliateFlat < 0 || brokerFlat > 100000 || affiliateFlat > 100000) {
    redirect("/admin/settings?error=Flat broker fees stay between $0 and $100,000.");
  }
  const wireInstructions = String(formData.get("wireInstructions") || "");
  const cents = Math.round(price * 100);
  const current = await prisma.platformSettings.upsert({
    where: { id: "default" },
    update: {
      buyerPremiumBps: percentToBps(premium),
      sellerCommissionBps: percentToBps(commission),
      proMonthlyPriceCents: cents,
      earlyAccessHours: Math.round(early),
      freeBrowseLimit: Math.round(limit),
      wireInstructions,
      chargeDeskFees: formData.get("chargeDeskFees") === "on",
      brokerFeeBasis: brokerBasis as "PERCENT" | "FLAT",
      brokerFeeBps: percentToBps(brokerPercent),
      brokerFeeCents: Math.round(brokerFlat * 100),
      affiliateFeeBasis: affiliateBasis as "PERCENT" | "FLAT",
      affiliateFeeBps: percentToBps(affiliatePercent),
      affiliateFeeCents: Math.round(affiliateFlat * 100),
    },
    create: {
      id: "default",
      buyerPremiumBps: percentToBps(premium),
      sellerCommissionBps: percentToBps(commission),
      proMonthlyPriceCents: cents,
      earlyAccessHours: Math.round(early),
      freeBrowseLimit: Math.round(limit),
      wireInstructions,
      chargeDeskFees: formData.get("chargeDeskFees") === "on",
      brokerFeeBasis: brokerBasis as "PERCENT" | "FLAT",
      brokerFeeBps: percentToBps(brokerPercent),
      brokerFeeCents: Math.round(brokerFlat * 100),
      affiliateFeeBasis: affiliateBasis as "PERCENT" | "FLAT",
      affiliateFeeBps: percentToBps(affiliatePercent),
      affiliateFeeCents: Math.round(affiliateFlat * 100),
    },
  });
  const synced = await syncProPrice({
    secretKey: process.env.STRIPE_SECRET_KEY,
    cents,
    productId: current.stripeProductId,
    priceId: current.stripePriceId,
  });
  if (synced.productId !== current.stripeProductId || synced.priceId !== current.stripePriceId) {
    await prisma.platformSettings.update({
      where: { id: "default" },
      data: { stripeProductId: synced.productId, stripePriceId: synced.priceId },
    });
  }
  clearSettingsCache();
  revalidatePath("/admin/settings");
  revalidatePath("/marketplace");
  if (synced.mode === "error") {
    redirect(`/admin/settings?error=${encodeURIComponent(`The schedule is saved. Stripe was not updated: ${synced.detail}`)}`);
  }
  redirect(`/admin/settings?notice=${synced.mode === "created" ? "stripe_price" : "saved_settings"}`);
}
