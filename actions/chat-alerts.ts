"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { addBuyerChannel, addDeskChannel, changeChannel } from "@/lib/chat-alerts";
import { requireDesk } from "@/lib/staff";

const BUYER_PAGE = "/account/notifications";
const DESK_PAGE = "/admin/settings";

// The answer shows in the chat section itself, which sits low on both pages. The address typed never goes in the URL.
function back(page: string, outcome: { ok: true; message: string } | { ok: false; error: string }): never {
  revalidatePath(page);
  const query = outcome.ok ? `chat=${encodeURIComponent(outcome.message)}` : `chatError=${encodeURIComponent(outcome.error)}`;
  redirect(`${page}?${query}#${page === DESK_PAGE ? "desk-chat" : "chat"}`);
}

function channelInput(formData: FormData) {
  return { kind: formData.get("kind"), url: formData.get("url"), label: formData.get("label"), events: formData.getAll("events") };
}

export async function addChatChannel(formData: FormData) {
  const user = await requireRole(["BUYER"]);
  back(BUYER_PAGE, await addBuyerChannel(user, channelInput(formData)));
}

export async function addDeskChatChannel(formData: FormData) {
  const user = await requireDesk("admin", DESK_PAGE);
  back(DESK_PAGE, await addDeskChannel(user, channelInput(formData)));
}

// Send a test, pause, resume or remove: the desk's channel for a desk owner, the firm's for its buyers.
export async function changeChatChannel(formData: FormData) {
  const user = await requireRole(["BUYER", "ADMIN"]);
  const page = user.role === "ADMIN" ? DESK_PAGE : BUYER_PAGE;
  back(page, await changeChannel(user, String(formData.get("id") || ""), String(formData.get("intent") || "")));
}
