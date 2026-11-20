"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actionGate } from "@/lib/action-gates";
import { requireRole } from "@/lib/auth";
import {
  answerRequest,
  createRequest,
  declineResponse,
  deskCloseRequest,
  requestInputFrom,
  setRequestStatus,
  updateRequest,
  type StatusAction,
} from "@/lib/bids-wanted";
import { deskDenied, requireDesk } from "@/lib/staff";

// Bids wanted: the buyer's requests, the seller's and broker's answers, and the desk's close. The rules are in
// lib/bids-wanted.ts. A firm's seat posts and answers for its firm when its seat role may write (lib/seats.ts).

const BUYER_PAGE = "/buyer/requests";
const DESK_PAGE = "/admin/requests";

type Result = { ok: true } | { ok: false; error: string };

function refresh() {
  for (const path of [BUYER_PAGE, "/wanted", DESK_PAGE, "/buying"]) revalidatePath(path);
}

function back(path: string, outcome: Result, notice: string, hash = ""): never {
  refresh();
  const message = outcome.ok ? `notice=${encodeURIComponent(notice)}` : `error=${encodeURIComponent(outcome.error)}`;
  redirect(`${path}?${message}${hash}`);
}

const refused = (error: string) => ({ ok: false as const, error });

export async function postBuyerRequest(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const gate = await actionGate(user, "message");
  const outcome = gate ? refused(gate) : await createRequest(user, requestInputFrom(formData));
  back(BUYER_PAGE, outcome, "Posted. Sellers and brokers see it with your firm named only by type.");
}

export async function editBuyerRequest(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const id = String(formData.get("id") || "");
  const gate = await actionGate(user, "message");
  const outcome = gate ? refused(gate) : await updateRequest(user, id, requestInputFrom(formData));
  if (!outcome.ok) back(`${BUYER_PAGE}/${encodeURIComponent(id)}`, outcome, "");
  back(BUYER_PAGE, outcome, "Saved. The new expiry counts from today.", `#request-${id}`);
}

const STATUS_NOTICES: Record<StatusAction, string> = {
  PAUSE: "Paused. Sellers no longer see it until you resume it.",
  RESUME: "Open again. Sellers see it on their board.",
  FILLED: "Marked filled. It is off the board.",
  CLOSE: "Closed. It is off the board.",
};

export async function changeBuyerRequest(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const id = String(formData.get("id") || "");
  // "move", not "action": a field named action would shadow form.action in the browser.
  const action = String(formData.get("move") || "") as StatusAction;
  const gate = await actionGate(user, "message");
  const outcome = gate ? refused(gate) : await setRequestStatus(user, id, action);
  back(BUYER_PAGE, outcome, STATUS_NOTICES[action] ?? "Saved.", `#request-${id}`);
}

export async function declineRequestAnswer(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  const responseId = String(formData.get("responseId") || "");
  const requestId = String(formData.get("requestId") || "");
  const gate = await actionGate(user, "message");
  const outcome = gate ? refused(gate) : await declineResponse(user, responseId);
  back(BUYER_PAGE, outcome, "Passed. The seller was told.", requestId ? `#request-${requestId}` : "");
}

export async function answerBuyerRequest(formData: FormData) {
  const user = await requireRole(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER", "BROKER", "ADMIN"]);
  const requestId = String(formData.get("requestId") || "");
  const listingId = String(formData.get("listingId") || "");
  const page = `/wanted/${encodeURIComponent(requestId)}`;
  if (!listingId) back(page, refused("Choose a listing to send."), "");
  const gate = deskDenied(user, "sales") ?? (await actionGate(user, "list").then((error) => (error ? refused(error) : null)));
  const outcome = gate ?? (await answerRequest(user, { requestId, listingId }));
  const notice = outcome.ok && outcome.value.invited
    ? "Sent. The buyer is invited to the private listing. It shows on their book, and no one else's."
    : "Sent. The listing stays as it is, and the buyer heard about it.";
  back(page, outcome, notice);
}

export async function deskCloseBuyerRequest(formData: FormData) {
  const user = await requireDesk("sales", DESK_PAGE);
  const requestId = String(formData.get("requestId") || "");
  const outcome = await deskCloseRequest(user, { requestId, reason: formData.get("reason") });
  back(DESK_PAGE, outcome, "Closed. The buyer was told the reason, and the audit log has it.", `#request-${requestId}`);
}
