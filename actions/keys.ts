"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { guardDesk } from "@/lib/staff";
import { mintKey } from "@/lib/api-keys";
import { prisma } from "@/lib/prisma";
import { canManageSeats } from "@/lib/seats";
import { cleanEvents, redeliver, webhookUrlProblem } from "@/lib/webhooks";

async function seller() {
  const user = await requireUser();
  if (user.role !== "INSTITUTIONAL_SELLER" && user.role !== "ADMIN") redirect("/");
  // A desk key reads and pushes as the desk, so minting one is an owner's call.
  guardDesk(user, "admin", "/seller/api");
  // A key acts as the whole firm, with nobody signed in to stop it, so only the owner or a managing seat mints one.
  if (!canManageSeats(user)) redirect(`/seller/api?error=${encodeURIComponent("Only a managing seat or the account owner can change API keys and webhooks.")}`);
  return user;
}

export type RevealState = { secret: string; error: string };

// The key and the webhook secret come back in the form state, never in a URL.
export async function createApiKey(_prev: RevealState, formData: FormData): Promise<RevealState> {
  const user = await seller();
  const name = String(formData.get("name") || "Tape key").trim().slice(0, 80);
  const minted = mintKey();
  await prisma.apiKey.create({ data: { userId: user.id, name, prefix: minted.prefix, hash: minted.hash } });
  revalidatePath("/seller/api");
  return { secret: minted.token, error: "" };
}

export async function revokeApiKey(formData: FormData) {
  const user = await seller();
  const id = String(formData.get("id") || "");
  await prisma.apiKey.deleteMany({ where: { id, userId: user.id } });
  redirect("/seller/api?notice=key");
}

export async function saveWebhook(_prev: RevealState, formData: FormData): Promise<RevealState> {
  const user = await seller();
  const url = String(formData.get("url") || "").trim();
  const problem = webhookUrlProblem(url);
  if (problem) return { secret: "", error: problem };
  const minted = mintKey();
  await prisma.webhookEndpoint.create({
    data: { userId: user.id, url, secret: minted.token },
  });
  revalidatePath("/seller/api");
  return { secret: minted.token, error: "" };
}

export async function deleteWebhook(formData: FormData) {
  const user = await seller();
  const id = String(formData.get("id") || "");
  await prisma.webhookEndpoint.deleteMany({ where: { id, userId: user.id } });
  redirect("/seller/api?notice=webhook");
}

// Which events one endpoint receives. At least one, or the endpoint should be removed instead.
export async function saveWebhookEvents(formData: FormData) {
  const user = await seller();
  const id = String(formData.get("endpointId") || "");
  const events = cleanEvents(formData.getAll("events"));
  if (!events) redirect(`/seller/api?error=${encodeURIComponent("Pick at least one event, or remove the webhook.")}`);
  const saved = await prisma.webhookEndpoint.updateMany({ where: { id, userId: user.id }, data: { events } });
  if (saved.count !== 1) redirect(`/seller/api?error=${encodeURIComponent("That webhook isn't on this account.")}`);
  redirect("/seller/api?notice=webhook");
}

export async function redeliverWebhook(formData: FormData) {
  const user = await seller();
  const result = await redeliver(String(formData.get("deliveryId") || ""), user.id);
  if (result.error) redirect(`/seller/api?error=${encodeURIComponent(result.error)}`);
  const notice = result.delivered ? "Sent again, and the endpoint took it." : "Sent again, and the endpoint refused it. The log shows its answer.";
  redirect(`/seller/api?notice=${encodeURIComponent(notice)}`);
}
