"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { buyerApiProblem, buyerKeyProblem, cleanBuyerScopes, mintKey } from "@/lib/api-keys";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { unset } from "@/lib/db-filters";
import { canManageSeats } from "@/lib/seats";
import { BUYER_WEBHOOK_EVENTS, cleanEvents, redeliver, webhookUrlProblem } from "@/lib/webhooks";

const PAGE = "/buyer/api";
const back = (error: string) => redirect(`${PAGE}?error=${encodeURIComponent(error)}`);

// A key reads as the whole firm with nobody signed in, so only the owner or a managing seat changes keys and webhooks.
async function buyer() {
  const user = await requireRole(["BUYER"]);
  if (!canManageSeats(user)) back("Only a managing seat or the account owner can change API keys and webhooks.");
  return user;
}

export type BuyerRevealState = { secret: string; error: string };

// The key and the webhook secret come back in the form state, never in a URL.
export async function createBuyerKey(_prev: BuyerRevealState, formData: FormData): Promise<BuyerRevealState> {
  const user = await buyer();
  const file = await prisma.buyerProfile.findUnique({ where: { userId: user.id }, select: { status: true } });
  const problem = buyerKeyProblem(user, file);
  if (problem) return { secret: "", error: problem };
  const scopes = cleanBuyerScopes(formData.getAll("scopes"));
  if (!scopes) return { secret: "", error: "Pick at least one scope." };
  const name = String(formData.get("name") || "").trim().slice(0, 80) || "Buyer key";
  const minted = mintKey();
  const key = await prisma.apiKey.create({ data: { userId: user.id, name, prefix: minted.prefix, hash: minted.hash, scopes } });
  await audit(user.id, "API_KEY_CREATED", "apiKey", key.id, `${name} · ${scopes}`);
  revalidatePath(PAGE);
  return { secret: minted.token, error: "" };
}

// A revoked key stays on the list, marked, so the account can see what was turned off and when.
export async function revokeBuyerKey(formData: FormData) {
  const user = await buyer();
  const id = String(formData.get("id") || "");
  const revoked = await prisma.apiKey.updateMany({ where: { id, userId: user.id, ...unset("revokedAt") }, data: { revokedAt: new Date() } });
  if (revoked.count !== 1) back("That key isn't live on this account.");
  await audit(user.id, "API_KEY_REVOKED", "apiKey", id, "Revoked from the Buyer API page");
  redirect(`${PAGE}?notice=key`);
}

export async function saveBuyerWebhook(_prev: BuyerRevealState, formData: FormData): Promise<BuyerRevealState> {
  const user = await buyer();
  const problem = buyerApiProblem(user);
  if (problem) return { secret: "", error: problem };
  const url = String(formData.get("url") || "").trim();
  const urlProblem = webhookUrlProblem(url);
  if (urlProblem) return { secret: "", error: urlProblem };
  const minted = mintKey();
  // Every buyer event to start with. The endpoint's own list narrows it.
  await prisma.webhookEndpoint.create({ data: { userId: user.id, url, secret: minted.token, events: cleanEvents(BUYER_WEBHOOK_EVENTS.map((item) => item.event), BUYER_WEBHOOK_EVENTS) } });
  revalidatePath(PAGE);
  return { secret: minted.token, error: "" };
}

export async function deleteBuyerWebhook(formData: FormData) {
  const user = await buyer();
  await prisma.webhookEndpoint.deleteMany({ where: { id: String(formData.get("id") || ""), userId: user.id } });
  redirect(`${PAGE}?notice=webhook`);
}

export async function saveBuyerWebhookEvents(formData: FormData) {
  const user = await buyer();
  const events = cleanEvents(formData.getAll("events"), BUYER_WEBHOOK_EVENTS);
  if (!events) back("Pick at least one event, or remove the webhook.");
  const saved = await prisma.webhookEndpoint.updateMany({ where: { id: String(formData.get("endpointId") || ""), userId: user.id }, data: { events } });
  if (saved.count !== 1) back("That webhook isn't on this account.");
  redirect(`${PAGE}?notice=webhook`);
}

export async function redeliverBuyerWebhook(formData: FormData) {
  const user = await buyer();
  // A paused account's events aren't sent, and neither is a repeat of one.
  const problem = buyerApiProblem(user);
  if (problem) back(problem);
  const result = await redeliver(String(formData.get("deliveryId") || ""), user.id);
  if (result.error) back(result.error);
  redirect(`${PAGE}?notice=${encodeURIComponent(result.delivered ? "Sent again, and the endpoint took it." : "Sent again, and the endpoint refused it. The log shows its answer.")}`);
}
