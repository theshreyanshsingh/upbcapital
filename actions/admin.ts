"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { AccountStatus, ReviewAction } from "@prisma/client";
import { alertMatchingSearches } from "@/actions/listings";
import { audit } from "@/lib/audit";
import { askSeller, awardOffer, checkAward, declineLosingBids } from "@/lib/awards";
import { endSessions, requireRole } from "@/lib/auth";
import { notify } from "@/lib/email";
import { DEFAULT_CLOSING_DAYS, DEFAULT_DEPOSIT_BPS, DEFAULT_DEPOSIT_DAYS } from "@/lib/closing-clock";
import { onGroupDeclined } from "@/actions/group";
import { rescoreListing } from "@/lib/matching";
import { postRevenueOnce } from "@/lib/ledger";
import { feeBreakdown, percentToBps } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { OFAC_DOWN_MESSAGE, OFAC_HOLD_MESSAGE, ofacHold, screenListing, screenUser } from "@/lib/screening";
import { clearSettingsCache, getSettings } from "@/lib/settings";
import { syncProPrice } from "@/lib/stripe-sync";
import { deskDecisionAllowed } from "@/lib/listing-status";

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

  if (!deskDecisionAllowed(action, listing.status)) {
    redirect(`/admin/listings/${listingId}?error=${encodeURIComponent(`That decision doesn't apply to a listing that is ${listing.status.replaceAll("_", " ").toLowerCase()}.`)}`);
  }
  if ((action === "REJECT" || action === "REQUEST_CHANGES") && (await prisma.closing.count({ where: { listingId, status: "OPEN" } })) > 0) {
    redirect(`/admin/listings/${listingId}?error=${encodeURIComponent("A closing is open on this listing. Cancel it before pulling the listing.")}`);
  }
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
    const screened = await screenListing(listingId, user.id);
    if (screened.unavailable) redirect(`/admin/listings/${listingId}?error=${encodeURIComponent(OFAC_DOWN_MESSAGE)}`);
    if (await ofacHold({ listingId, userIds: [listing.sellerId] })) {
      redirect(`/admin/listings/${listingId}?error=${encodeURIComponent(OFAC_HOLD_MESSAGE)}`);
    }
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

  // Marking in contract or sold by hand skips the award and closing paths, so it checks the same OFAC hold they do.
  if ((action === "MARK_PENDING" || action === "MARK_SOLD") && (await ofacHold({ listingId, userIds: [listing.sellerId] }))) {
    redirect(`/admin/listings/${listingId}?error=${encodeURIComponent(OFAC_HOLD_MESSAGE)}`);
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
    if (listing.brokerId) {
      redirect(`/admin/listings/${listingId}?error=${encodeURIComponent("A broker filed this listing. Award the offer and close it in the closing room, so the broker's fee posts.")}`);
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
    // Keyed like the closing path's rows, so marking the same sale twice leaves one entry each.
    await postRevenueOnce([
      { type: "BUYER_PREMIUM", amountCents: fees.premiumCents, listingId, description: `Buyer premium on ${listing.title}`, externalId: `listing:${listingId}:premium` },
      { type: "SELLER_COMMISSION", amountCents: fees.commissionCents, listingId, description: `Seller commission on ${listing.title}`, externalId: `listing:${listingId}:commission` },
    ]);
    await prisma.note.updateMany({ where: { listingId }, data: { tradeStatus: "SOLD" } });
    await declineLosingBids({ id: null, listingId, noteId: null }, listing.title);
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
    const check = await checkAward(inquiry.id);
    if (check.error !== null) redirect("closingId" in check && check.closingId ? `/closings/${check.closingId}` : `/admin/offers?error=${encodeURIComponent(check.error)}`);
    // No sale without the seller's word on the price. A reserve that covers it counts; otherwise the seller is asked.
    if (!check.agreed) {
      await askSeller(check.offer, check.price);
      await audit(user.id, "SELLER_ASKED", "inquiry", inquiry.id, `${inquiry.listing.title} · $${check.price.toLocaleString("en-US")}`);
      revalidatePath("/admin/offers");
      redirect("/admin/offers?notice=sent_to_seller");
    }
    const result = await awardOffer(inquiry.id, user.id);
    if (result.error !== null) redirect(`/admin/offers?error=${encodeURIComponent(result.error)}`);
    revalidatePath("/admin/offers");
    revalidatePath(`/admin/listings/${inquiry.listingId}`);
    redirect("/admin/offers?notice=accept");
  } else if (inquiry.status !== "OPEN" && inquiry.status !== "REVIEWED") {
    // A stale page can't decline an offer that already has a closing, or one that was already declined.
    redirect(`/admin/offers?error=${encodeURIComponent("That offer is already decided.")}`);
  } else if (decision === "DECLINE") {
    await prisma.inquiry.update({ where: { id: inquiry.id }, data: { status: "DECLINED" } });
    await onGroupDeclined(inquiry.id);
    const { emitWebhook } = await import("@/lib/webhooks");
    await emitWebhook(inquiry.listing.sellerId, "offer.declined", { inquiryId: inquiry.id, listingId: inquiry.listingId });
    await notify(inquiry.buyer.email, `Inquiry declined · ${inquiry.listing.title}`, "The desk declined this inquiry.");
  } else {
    await prisma.inquiry.update({ where: { id: inquiry.id }, data: { status: "REVIEWED" } });
  }
  // The seller reads every review comment, so the bidder stays out of it. The audit log keeps the name.
  await prisma.reviewComment.create({
    data: {
      listingId: inquiry.listingId,
      authorId: user.id,
      action: "COMMENT",
      comment: decision === "DECLINE" ? "An inquiry was declined." : "An inquiry was reviewed.",
    },
  });
  await audit(user.id, `INQUIRY_${decision}`, "inquiry", inquiry.id, `${inquiry.listing.title} · ${inquiry.buyer.name}`);
  revalidatePath("/admin/offers");
  revalidatePath(`/admin/listings/${inquiry.listingId}`);
  redirect(`/admin/offers?notice=${encodeURIComponent(decision.toLowerCase())}`);
}

export async function setAccountStatus(formData: FormData) {
  const actor = await admin();
  const userId = String(formData.get("userId") || "");
  const status = String(formData.get("status") || "") as AccountStatus;
  if (userId === actor.id) redirect("/admin/users?error=You cannot change your own account.");
  if (status !== "APPROVED" && status !== "REJECTED" && status !== "PENDING" && status !== "SUSPENDED") redirect("/admin/users");
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) redirect("/admin/users");
  if (target.role === "ADMIN") redirect("/admin/users?error=Desk admins are not changed from here.");
  if (status === "APPROVED") {
    if ((await screenUser(userId, "Account approval")).unavailable) redirect(`/admin/users?error=${encodeURIComponent(OFAC_DOWN_MESSAGE)}`);
    if (await ofacHold({ userIds: [userId] })) redirect(`/admin/users?error=${encodeURIComponent(OFAC_HOLD_MESSAGE)}`);
  }
  const user = await prisma.user.update({ where: { id: userId }, data: { accountStatus: status } });
  if (status === "REJECTED" || status === "SUSPENDED") await endSessions(user.id);
  await audit(actor.id, "ACCOUNT", "user", user.id, status);
  await notify(user.email, `Account ${status.toLowerCase()}`, `Your UPB Capital account is now ${status.toLowerCase()}.`);
  revalidatePath("/admin/users");
  redirect("/admin/users?notice=updated");
}

export async function forceSignOut(formData: FormData) {
  const actor = await admin();
  const userId = String(formData.get("userId") || "");
  if (userId === actor.id) redirect("/admin/users?error=Use your security page for your own devices.");
  await endSessions(userId);
  await audit(actor.id, "FORCE_SIGN_OUT", "user", userId);
  revalidatePath("/admin/users");
  redirect("/admin/users?notice=signed_out");
}

// For a user who lost both the authenticator and the recovery codes. Their next sign-in is by password alone.
export async function resetTwoFactor(formData: FormData) {
  const actor = await admin();
  const userId = String(formData.get("userId") || "");
  if (userId === actor.id) redirect("/admin/users?error=You cannot clear your own second factor.");
  const user = await prisma.user.update({
    where: { id: userId },
    data: { totpEnabled: false, totpSecret: "", recoveryHashes: "", recoveryReveal: "", emailOtpFallback: false },
  });
  await endSessions(userId);
  await audit(actor.id, "TOTP_RESET", "user", userId);
  await notify(user.email, "Two-factor sign-in was cleared", "The desk cleared the second factor on your account and signed you out. Set it up again from the security page. If you did not ask for this, write the desk now.");
  revalidatePath("/admin/users");
  redirect("/admin/users?notice=factor_reset");
}

export async function setMembership(formData: FormData) {
  const actor = await admin();
  const userId = String(formData.get("userId") || "");
  const tier = String(formData.get("tier") || "FREE");
  if (tier === "PRO") {
    await prisma.user.update({
      where: { id: userId },
      data: {
        subscriptionTier: "PRO",
        subscriptionStatus: "ACTIVE",
        subscriptionComped: true,
        // A desk comp runs until the desk sets the account back to free.
        subscriptionCurrentPeriodEnd: null,
      },
    });
  } else {
    await prisma.user.update({
      where: { id: userId },
      data: { subscriptionTier: "FREE", subscriptionStatus: "CANCELED", subscriptionComped: false },
    });
  }
  await audit(actor.id, "MEMBERSHIP", "user", userId, tier === "PRO" ? "Comped Pro" : "Set to free");
  revalidatePath("/admin/users");
  redirect("/admin/users?notice=membership");
}

export async function saveSettings(formData: FormData) {
  const actor = await admin();
  const before = await getSettings();
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
  const closingDays = Number(formData.get("closingTargetDays") || DEFAULT_CLOSING_DAYS);
  if (!Number.isFinite(closingDays) || closingDays < 5 || closingDays > 180) redirect("/admin/settings?error=Keep the target close between 5 and 180 days.");
  const depositPercent = Number(formData.get("depositPercent") ?? DEFAULT_DEPOSIT_BPS / 100);
  const depositDays = Number(formData.get("depositDays") ?? DEFAULT_DEPOSIT_DAYS);
  if (!Number.isFinite(depositPercent) || depositPercent < 0 || depositPercent > 50) redirect("/admin/settings?error=Keep the deposit between 0% and 50%.");
  if (!Number.isFinite(depositDays) || depositDays < 1 || depositDays > 30) redirect("/admin/settings?error=Give buyers between 1 and 30 days to wire the deposit.");
  const requireTwoStep = formData.get("requireTwoStep") === "on";
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
      closingTargetDays: Math.round(closingDays),
      depositBps: percentToBps(depositPercent),
      depositDays: Math.round(depositDays),
      requireTwoStep,
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
      closingTargetDays: Math.round(closingDays),
      depositBps: percentToBps(depositPercent),
      depositDays: Math.round(depositDays),
      requireTwoStep,
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
  await audit(
    actor.id,
    "FEE_SCHEDULE",
    "settings",
    "default",
    `Premium ${premium}%, commission ${commission}%, Pro $${price}, early access ${Math.round(early)}h, free browse ${Math.round(limit)}, target close ${Math.round(closingDays)} days. Default wires ${wireInstructions === before.wireInstructions ? "unchanged" : "changed"}.`,
  );
  clearSettingsCache();
  revalidatePath("/admin/settings");
  revalidatePath("/marketplace");
  if (synced.mode === "error") {
    redirect(`/admin/settings?error=${encodeURIComponent(`The schedule is saved. Stripe was not updated: ${synced.detail}`)}`);
  }
  redirect(`/admin/settings?notice=${synced.mode === "created" ? "stripe_price" : "saved_settings"}`);
}
