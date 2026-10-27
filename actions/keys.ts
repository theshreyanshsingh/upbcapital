"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { mintKey } from "@/lib/api-keys";
import { prisma } from "@/lib/prisma";

async function seller() {
  const user = await requireUser();
  if (user.role !== "INSTITUTIONAL_SELLER" && user.role !== "ADMIN") redirect("/");
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
  if (!/^https?:\/\//i.test(url)) return { secret: "", error: "The webhook needs an http or https URL." };
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
