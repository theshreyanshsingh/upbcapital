"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { needsSecondFactor } from "@/lib/access";
import { requireUser, setSession, twoStepRequired } from "@/lib/auth";
import { homeFor } from "@/lib/labels";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requestMeta } from "@/lib/request-meta";
import {
  SEAT_INVITE_DAYS,
  acceptSeatInvite,
  approveSeatBid,
  declineSeatBid,
  inviteSeat,
  removeSeat,
  resendSeatInvite,
  resolveSessionUser,
  revokeSeatInvite,
  secondFactorSubject,
  updateSeat,
  withdrawSeatBid,
} from "@/lib/seats";

const TEAM = "/account/team";

function done(kind: "notice" | "error", text: string, hash: string): never {
  revalidatePath(TEAM);
  redirect(`${TEAM}?${kind}=${encodeURIComponent(text)}${hash}`);
}

// Every team action is for the signed-in account. The desk's own staff get desk roles instead. The lib checks the
// seat or invitation named in the form belongs to this account and that the person may change it.
async function teamAccount() {
  const user = await requireUser();
  if (user.role === "ADMIN") redirect("/admin/users");
  return user;
}

export async function inviteTeamSeat(formData: FormData) {
  const user = await teamAccount();
  const result = await inviteSeat({
    account: user,
    email: String(formData.get("email") || ""),
    name: String(formData.get("name") || ""),
    seatRole: String(formData.get("seatRole") || ""),
    bidLimit: formData.get("bidLimit"),
  });
  if (result.error !== null) done("error", result.error, "#invite");
  done("notice", `Invitation sent. The link is good for ${SEAT_INVITE_DAYS} days.`, "#invites");
}

export async function resendTeamInvite(formData: FormData) {
  const user = await teamAccount();
  const result = await resendSeatInvite(user, String(formData.get("inviteId") || ""));
  if (result.error !== null) done("error", result.error, "#invites");
  done("notice", "A fresh link went out. The earlier one no longer works.", "#invites");
}

export async function revokeTeamInvite(formData: FormData) {
  const user = await teamAccount();
  const result = await revokeSeatInvite(user, String(formData.get("inviteId") || ""));
  if (result.error !== null) done("error", result.error, "#invites");
  done("notice", "Invitation withdrawn. The link no longer works.", "#invites");
}

export async function saveTeamSeat(formData: FormData) {
  const user = await teamAccount();
  const result = await updateSeat({ account: user, seatId: String(formData.get("seatId") || ""), seatRole: String(formData.get("seatRole") || ""), bidLimit: formData.get("bidLimit") });
  if (result.error !== null) done("error", result.error, "#seats");
  done("notice", "The seat is updated. It takes effect on the seat's next page.", "#seats");
}

export async function removeTeamSeat(formData: FormData) {
  const user = await teamAccount();
  const result = await removeSeat(user, String(formData.get("seatId") || ""));
  if (result.error !== null) done("error", result.error, "#seats");
  done("notice", "The seat is removed and signed out. It can no longer act for this account.", "#seats");
}

export async function approveHeldBid(formData: FormData) {
  const user = await teamAccount();
  const result = await approveSeatBid(user, String(formData.get("approvalId") || ""));
  if (result.error !== null) done("error", result.error, "#approvals");
  revalidatePath("/buyer/offers");
  revalidatePath("/admin/offers");
  revalidatePath(`/marketplace/${result.listingId}`);
  done("notice", "Approved. The bid is placed, and the seat that asked was told.", "#approvals");
}

export async function declineHeldBid(formData: FormData) {
  const user = await teamAccount();
  const result = await declineSeatBid(user, String(formData.get("approvalId") || ""), String(formData.get("reason") || ""));
  if (result.error !== null) done("error", result.error, "#approvals");
  done("notice", "Declined. Nothing was placed, and the seat that asked has your reason.", "#approvals");
}

export async function withdrawHeldBid(formData: FormData) {
  const user = await teamAccount();
  const result = await withdrawSeatBid(user, String(formData.get("approvalId") || ""));
  if (result.error !== null) done("error", result.error, "#approvals");
  done("notice", "Withdrawn. Nothing was placed.", "#approvals");
}

// The invitee's form on the invitation page. They are signed in as their seat straight after, and the desk's
// two-step rule then sends them to set up an authenticator if it applies.
export async function acceptTeamInvite(formData: FormData) {
  const token = String(formData.get("token") || "");
  const again = `/seat/${encodeURIComponent(token)}`;
  const meta = await requestMeta();
  if (!(await consumeRateLimit(`seat-accept:${meta.ipAddress}`, 10, 60 * 60 * 1000))) {
    redirect(`${again}?error=${encodeURIComponent("Too many tries from this network. Wait and try again.")}`);
  }
  const result = await acceptSeatInvite({
    token,
    name: String(formData.get("name") || ""),
    password: String(formData.get("password") || ""),
    confirm: String(formData.get("confirm") || ""),
    terms: formData.get("terms"),
  });
  if (result.error !== null) redirect(result.closed ? again : `${again}?error=${encodeURIComponent(result.error)}`);
  const { user } = result;
  await setSession({ sub: user.id, email: user.email, role: user.role, name: user.name });
  const account = await resolveSessionUser(user.id);
  if (account && needsSecondFactor(secondFactorSubject(account), await twoStepRequired())) redirect("/account/security?setup=1");
  redirect(homeFor(user.role));
}
