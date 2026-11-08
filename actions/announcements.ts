"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { confirmSubscriber, leaveList, readDraft, readSubscriberEmail, sendAnnouncement, subscribe } from "@/lib/announcements";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requestMeta } from "@/lib/request-meta";
import { requireDesk } from "@/lib/staff";

const HOUR = 60 * 60 * 1000;

function back(path: string, key: "notice" | "error", text: string): never {
  return redirect(`${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(text)}`);
}

// The public sign-up. No account needed. Limited per network and per address, so the form can't be used to flood
// someone's inbox with confirmations. The answer is the same whether or not the address is already on the list.
export async function joinDealList(formData: FormData) {
  const meta = await requestMeta();
  // A field people never see. A bot that fills it gets the same answer and nothing is sent.
  if (String(formData.get("website") || "").trim()) back("/announcements", "notice", "Check your inbox for a confirmation link.");
  if (!(await consumeRateLimit(`deal-list:${meta.ipAddress}`, 5, HOUR))) back("/announcements", "error", "Too many sign-ups from this network. Wait and try again.");
  const email = readSubscriberEmail(String(formData.get("email") || ""));
  if (!email) back("/announcements", "error", "Enter a valid email address.");
  if (!(await consumeRateLimit(`deal-list-email:${email}`, 3, 24 * HOUR))) back("/announcements", "notice", "Check your inbox for a confirmation link.");
  const result = await subscribe({ email, name: String(formData.get("name") || ""), source: "PUBLIC" });
  if (result.error) back("/announcements", "error", result.error);
  back("/announcements", "notice", "Check your inbox for a confirmation link.");
}

// The confirm button. The subscriber's token is the permission.
export async function confirmDealList(formData: FormData) {
  const meta = await requestMeta();
  const token = String(formData.get("token") || "");
  const page = `/announcements/confirm?token=${encodeURIComponent(token)}`;
  if (!(await consumeRateLimit(`deal-list-token:${meta.ipAddress}`, 30, HOUR))) back(page, "error", "Too many tries from this network. Wait and try again.");
  if (!(await confirmSubscriber(token))) redirect("/announcements/confirm");
  redirect(`${page}&done=1`);
}

// The leave button. The token is the permission, as on the member unsubscribe page.
export async function leaveDealList(formData: FormData) {
  const meta = await requestMeta();
  const token = String(formData.get("token") || "");
  const page = `/announcements/leave?token=${encodeURIComponent(token)}`;
  if (!(await consumeRateLimit(`deal-list-token:${meta.ipAddress}`, 30, HOUR))) back(page, "error", "Too many tries from this network. Wait and try again.");
  if (!(await leaveList(token))) redirect("/announcements/leave");
  redirect(`${page}&done=1`);
}

// The desk's send. Sales work, like the sale-event notices.
export async function sendDealAnnouncement(formData: FormData) {
  const actor = await requireDesk("sales", "/admin/announcements");
  const { draft, error } = readDraft({
    subject: String(formData.get("subject") || ""),
    body: String(formData.get("body") || ""),
    listingIds: formData.getAll("listingIds").map(String),
    linkEvents: formData.get("linkEvents") === "on",
  });
  if (!draft) back("/admin/announcements", "error", error ?? "Check the announcement.");
  const result = await sendAnnouncement({ id: String(formData.get("draftId") || ""), draft, sentById: actor.id });
  if (result.error !== null) back("/admin/announcements", "error", result.error);
  revalidatePath("/admin/announcements");
  if (result.already) back("/admin/announcements", "notice", "That announcement already went out.");
  const failed = result.failed ? ` ${result.failed} could not be sent. The server log has the reason.` : "";
  back("/admin/announcements", "notice", `Sent to ${result.sent} reader${result.sent === 1 ? "" : "s"}.${failed}`);
}
