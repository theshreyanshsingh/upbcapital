"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { creditInvoice, issueClosingInvoices } from "@/lib/invoices";
import { addPayoutAccount, decidePayoutAccount, logCallback, retirePayoutAccount } from "@/lib/payout-accounts";
import { clearProration, saveProration } from "@/lib/proration-service";
import { requireDesk } from "@/lib/staff";

// Proration, payout accounts and invoices. Every export here is a public endpoint, so each one signs the caller in
// and checks what they may do before it reads the form.

const ACCOUNT_PAGE = "/account/finance";

// A closing page to come back to. Ids are cuids, so anything else falls back to the closings list.
function closingPage(raw: FormDataEntryValue | null) {
  const id = String(raw || "");
  return /^[a-z0-9]{8,40}$/i.test(id) ? `/closings/${id}` : "/closings";
}

function back(path: string, kind: "notice" | "error", message: string, anchor = ""): never {
  redirect(`${path}?${kind}=${encodeURIComponent(message)}${anchor}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Proration, by the desk member running the closing.

export async function saveProrationAction(formData: FormData) {
  const page = closingPage(formData.get("closingId"));
  const actor = await requireDesk("closings", page);
  const loans: Record<string, { upb: string; paidTo: string }> = {};
  for (const [name, value] of formData.entries()) {
    const match = /^(upb|paidTo)_(.+)$/.exec(name);
    if (!match) continue;
    loans[match[2]] ??= { upb: "", paidTo: "" };
    loans[match[2]][match[1] as "upb" | "paidTo"] = String(value ?? "");
  }
  const saved = await saveProration(actor, {
    closingId: String(formData.get("closingId") || ""),
    cutoffDate: String(formData.get("cutoffDate") || ""),
    closingDate: String(formData.get("closingDate") || ""),
    loans,
  });
  if (saved.error !== null) back(page, "error", saved.error, "#proration");
  revalidatePath(page);
  back(page, "notice", "The proration is set. Both sides were told what it does to their figures.", "#proration");
}

export async function clearProrationAction(formData: FormData) {
  const page = closingPage(formData.get("closingId"));
  const actor = await requireDesk("closings", page);
  const cleared = await clearProration(actor, String(formData.get("closingId") || ""));
  if (cleared.error !== null) back(page, "error", cleared.error, "#proration");
  revalidatePath(page);
  back(page, "notice", "The proration is off. Both sides were told.", "#proration");
}

// ---------------------------------------------------------------------------------------------------------------
// The seller's payout accounts.

export async function addPayoutAccountAction(formData: FormData) {
  const user = await requireUser();
  const added = await addPayoutAccount(user, {
    bankName: String(formData.get("bankName") || ""),
    accountName: String(formData.get("accountName") || ""),
    routingNumber: String(formData.get("routingNumber") || ""),
    accountLast4: String(formData.get("accountLast4") || ""),
    replaces: String(formData.get("replaces") || "") || null,
  });
  if (added.error !== null) back(ACCOUNT_PAGE, "error", added.error, "#payout-accounts");
  revalidatePath(ACCOUNT_PAGE);
  back(ACCOUNT_PAGE, "notice", "Saved. The desk will call you on a number it finds itself before proceeds can go to it. We emailed you about the change.", "#payout-accounts");
}

export async function removePayoutAccountAction(formData: FormData) {
  const user = await requireUser();
  const removed = await retirePayoutAccount(user, String(formData.get("accountId") || ""));
  if (removed.error !== null) back(ACCOUNT_PAGE, "error", removed.error, "#payout-accounts");
  revalidatePath(ACCOUNT_PAGE);
  back(ACCOUNT_PAGE, "notice", "Removed. Proceeds can't go to that account now.", "#payout-accounts");
}

// ---------------------------------------------------------------------------------------------------------------
// The desk's call-back and its four-eyes decision, from the closing page, or the payouts page for a broker's account.

const PAYOUTS_PAGE = "/admin/payouts";

function deskPage(formData: FormData) {
  return formData.get("back") === PAYOUTS_PAGE ? PAYOUTS_PAGE : closingPage(formData.get("closingId"));
}

const payoutAnchor = (page: string) => (page === PAYOUTS_PAGE ? "#broker-accounts" : "#payout");

export async function logPayoutCallbackAction(formData: FormData) {
  const page = deskPage(formData);
  const actor = await requireDesk("approveWires", page);
  const logged = await logCallback(actor, {
    accountId: String(formData.get("accountId") || ""),
    phone: String(formData.get("phone") || ""),
    source: String(formData.get("source") || ""),
    note: String(formData.get("note") || ""),
    independent: String(formData.get("independent") || "") === "yes",
  });
  if (logged.error !== null) back(page, "error", logged.error, payoutAnchor(page));
  revalidatePath(page);
  back(page, "notice", "Call-back logged. Another desk member who approves wires verifies the account.", payoutAnchor(page));
}

export async function decidePayoutAccountAction(formData: FormData) {
  const page = deskPage(formData);
  const actor = await requireDesk("approveWires", page);
  const decided = await decidePayoutAccount(actor, {
    accountId: String(formData.get("accountId") || ""),
    decision: String(formData.get("decision") || ""),
    note: String(formData.get("note") || ""),
    reason: String(formData.get("reason") || ""),
  });
  if (decided.error !== null) back(page, "error", decided.error, payoutAnchor(page));
  revalidatePath(page);
  revalidatePath(ACCOUNT_PAGE);
  back(page, "notice", decided.status === "VERIFIED" ? "The payout account is verified. The account holder was told." : "The payout account is rejected. The account holder was told.", payoutAnchor(page));
}

// ---------------------------------------------------------------------------------------------------------------
// Invoices and credit notes.

export async function creditInvoiceAction(formData: FormData) {
  const page = closingPage(formData.get("closingId"));
  const actor = await requireDesk("admin", page);
  const raw = String(formData.get("amount") || "").replace(/[$,\s]/g, "");
  const amount = raw ? Number(raw) : null;
  if (amount != null && !(Number.isFinite(amount) && amount > 0)) back(page, "error", "Enter the amount to credit in dollars, or leave it blank to cancel the whole fee.", "#invoices");
  const credited = await creditInvoice(actor, {
    invoiceId: String(formData.get("invoiceId") || ""),
    amountCents: amount == null ? null : Math.round(amount * 100),
    reason: String(formData.get("reason") || ""),
  });
  if (credited.error !== null) back(page, "error", credited.error, "#invoices");
  revalidatePath(page);
  back(page, "notice", `Credit note ${credited.credit.number} issued. The party was told.`, "#invoices");
}

// A completed closing's invoices, issued again if the close's own issue failed. A repeat finds them issued.
export async function issueClosingInvoicesAction(formData: FormData) {
  const page = closingPage(formData.get("closingId"));
  await requireDesk("closings", page);
  const closingId = String(formData.get("closingId") || "");
  const closing = await prisma.closing.findUnique({ where: { id: closingId }, select: { status: true } });
  if (closing?.status !== "COMPLETE") back(page, "error", "Invoices are issued once the closing completes.", "#invoices");
  await issueClosingInvoices(closingId);
  revalidatePath(page);
  back(page, "notice", "The closing's invoices are issued.", "#invoices");
}
