"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { reviewListing } from "@/actions/admin";
import { audit } from "@/lib/audit";
import { bidCapFor, capLine, DEFAULT_NEW_BIDDER_CLOSES, MAX_NEW_BIDDER_CLOSES, newBidderClosesOf, readCapDollars, readReason } from "@/lib/bid-caps";
import { bulkDetail, bulkHead, captureOutcome, isBulkAction, pickedIds, runBulk } from "@/lib/desk-bulk";
import { notify } from "@/lib/email";
import { money } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { clearSettingsCache, getSettings } from "@/lib/settings";
import { requireDesk } from "@/lib/staff";

// The desk tools: bid caps, the buyer profile's cap controls and bulk review decisions. Each export is a public
// endpoint, so each checks the desk role it needs before reading anything.

function centsText(cents: number | null | undefined) {
  return cents != null && cents > 0 ? money(cents / 100) : "none";
}

// The new-bidder cap and how many closings lift it, from the settings page. Only an owner changes them.
export async function saveBidCapSettings(formData: FormData) {
  const actor = await requireDesk("admin", "/admin/settings");
  const cap = readCapDollars(formData.get("newBidderCap"));
  if (cap.error !== null) redirect(`/admin/settings?error=${encodeURIComponent(cap.error)}#bid-caps`);
  const raw = String(formData.get("newBidderCloses") || "").trim();
  const closes = raw ? Number(raw) : DEFAULT_NEW_BIDDER_CLOSES;
  if (!/^\d*$/.test(raw) || closes < 1 || newBidderClosesOf(closes) !== closes) {
    redirect(`/admin/settings?error=${encodeURIComponent(`Set the closings that lift the cap as a whole number from 1 to ${MAX_NEW_BIDDER_CLOSES}.`)}#bid-caps`);
  }
  const before = await getSettings();
  await prisma.platformSettings.upsert({
    where: { id: "default" },
    update: { newBidderCapCents: cap.cents, newBidderCloses: closes },
    create: { id: "default", newBidderCapCents: cap.cents, newBidderCloses: closes },
  });
  clearSettingsCache();
  await audit(
    actor.id,
    "BID_CAP_SETTINGS",
    "settings",
    "default",
    `New-bidder cap ${centsText(before.newBidderCapCents)} to ${centsText(cap.cents)}. Closings to lift it ${newBidderClosesOf(before.newBidderCloses)} to ${closes}.`,
  );
  revalidatePath("/admin/settings");
  const notice = cap.cents
    ? `New bidders bid up to ${money(cap.cents / 100)} on one bid until they have closed ${closes} deal${closes === 1 ? "" : "s"}.`
    : "No new-bidder cap. Verified funds and the desk's own caps still apply.";
  redirect(`/admin/settings?notice=${encodeURIComponent(notice)}#bid-caps`);
}

// One buyer's cap, from their desk profile: the desk's own cap, or lifting or restoring the new-bidder cap. Each
// change takes a reason, goes in the audit log, and tells the buyer their limit now.
export async function setBuyerBidCap(formData: FormData) {
  const userId = String(formData.get("userId") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  const back = userId ? `/admin/buyers/${userId}` : "/admin/contacts";
  const actor = await requireDesk("compliance", back);
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, email: true, bidCapCents: true, bidCapLifted: true } });
  if (!target || target.role !== "BUYER") redirect(`${back}?error=${encodeURIComponent("Bid caps are for buyer accounts.")}`);
  const why = readReason(formData.get("reason"));
  if (why.error !== null) redirect(`${back}?error=${encodeURIComponent(why.error)}#bid-cap`);
  const mode = String(formData.get("mode") || "");
  let change: string;
  if (mode === "cap") {
    const cap = readCapDollars(formData.get("capDollars"));
    if (cap.error !== null) redirect(`${back}?error=${encodeURIComponent(cap.error)}#bid-cap`);
    if ((target.bidCapCents ?? null) === cap.cents) redirect(`${back}?error=${encodeURIComponent("That is the cap already on file.")}#bid-cap`);
    await prisma.user.update({ where: { id: userId }, data: { bidCapCents: cap.cents } });
    change = `Desk cap ${centsText(target.bidCapCents)} to ${centsText(cap.cents)}`;
  } else if (mode === "lift" || mode === "restore") {
    const lift = mode === "lift";
    if (Boolean(target.bidCapLifted) === lift) redirect(`${back}?error=${encodeURIComponent(lift ? "The new-bidder cap is already lifted." : "The new-bidder cap already applies.")}#bid-cap`);
    await prisma.user.update({ where: { id: userId }, data: { bidCapLifted: lift } });
    change = lift ? "New-bidder cap lifted" : "New-bidder cap restored";
  } else {
    redirect(`${back}?error=${encodeURIComponent("Choose what to change.")}#bid-cap`);
  }
  await audit(actor.id, "BID_CAP", "user", userId, `${change}. Reason: ${why.reason}`);
  const line = capLine(await bidCapFor(userId));
  await notify(target.email, "Your bid limit changed", line ? `The desk changed your bid limit. ${line}` : "The desk changed your bid limit. Your verified funds are now your only limit on one bid.");
  revalidatePath(back);
  redirect(`${back}?notice=${encodeURIComponent(`${change}.`)}#bid-cap`);
}

// Several listings from the review queue at once. Each goes through reviewListing, the single-listing decision,
// with every gate it runs, one after another. A listing a gate stops is left as it was and reported with the gate's
// reason. Each listing's outcome goes in the audit log under this run, which the queue reads back.
export async function bulkReview(formData: FormData) {
  const actor = await requireDesk("sales", "/admin/queue");
  const action = String(formData.get("action") || "");
  if (!isBulkAction(action)) redirect(`/admin/queue?error=${encodeURIComponent("Choose approve or request changes.")}`);
  const ids = pickedIds(formData.getAll("listingId"));
  if (!ids.length) redirect(`/admin/queue?error=${encodeURIComponent("Pick at least one listing.")}`);
  const comment = String(formData.get("comment") || "").trim().slice(0, 2000);
  if (action === "REQUEST_CHANGES" && comment.length < 3) redirect(`/admin/queue?error=${encodeURIComponent("Write the note each seller will read.")}`);
  const found = await prisma.listing.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } });
  const listings = ids.flatMap((id) => found.filter((listing) => listing.id === id));
  const run = randomUUID().slice(0, 8);
  const rows = await runBulk(listings, (listingId) => {
    const single = new FormData();
    single.set("listingId", listingId);
    single.set("action", action);
    single.set("comment", comment);
    single.set("launchAt", "");
    return captureOutcome(() => reviewListing(single));
  });
  for (const row of rows) await audit(actor.id, "BULK_REVIEW", "listing", row.id, bulkDetail(run, action, row));
  revalidatePath("/admin/queue");
  const head = bulkHead(action, rows);
  redirect(`/admin/queue?bulk=${run}&${head.ok ? "notice" : "error"}=${encodeURIComponent(head.text)}#bulk-results`);
}
