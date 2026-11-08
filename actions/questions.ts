"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actionGate } from "@/lib/action-gates";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { answerQuestion, askQuestion, declineQuestion } from "@/lib/questions";
import { seatGate } from "@/lib/seats";
import { deskDenied } from "@/lib/staff";

// The pages a question is asked or answered from. The form names one; anything else falls back to the listing.
const PAGES: Record<string, (id: string) => string> = {
  marketplace: (id) => `/marketplace/${id}`,
  seller: (id) => `/seller/listings/${id}`,
  broker: (id) => `/broker/deals/${id}`,
  admin: (id) => `/admin/listings/${id}`,
  resale: (id) => `/buyer/resales/${id}`,
};

function refresh(listingId: string) {
  for (const page of Object.values(PAGES)) revalidatePath(page(listingId));
}

function back(formData: FormData, listingId: string, outcome: { ok: true } | { ok: false; error: string }, notice: string): never {
  const page = (PAGES[String(formData.get("from") || "")] ?? PAGES.marketplace)(listingId);
  refresh(listingId);
  const message = outcome.ok ? `notice=${encodeURIComponent(notice)}` : `error=${encodeURIComponent(outcome.error)}`;
  redirect(`${page}?${message}${page.startsWith("/marketplace/") ? "&tab=room" : ""}#questions`);
}

export async function askListingQuestion(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") || "");
  // A question or an answer speaks for the account, so a firm's seat needs a role that writes (lib/seats.ts).
  const gated = await actionGate(user, "message");
  if (gated) back(formData, listingId, { ok: false, error: gated }, "");
  const outcome = await askQuestion(user, { listingId, question: formData.get("question"), noteId: String(formData.get("noteId") || "") || null });
  back(formData, listingId, outcome, "Your question is with the seller. If they answer it, every bidder in the room reads the answer, without your name.");
}

async function listingOf(questionId: string) {
  const row = await prisma.listingQuestion.findUnique({ where: { id: questionId }, select: { listingId: true } });
  if (!row) redirect("/");
  return row.listingId;
}

export async function answerListingQuestion(formData: FormData) {
  const user = await requireUser();
  const questionId = String(formData.get("questionId") || "");
  const listingId = await listingOf(questionId);
  const gated = await actionGate(user, "message");
  if (gated) back(formData, listingId, { ok: false, error: gated }, "");
  const outcome = deskDenied(user, "sales") ?? (await answerQuestion(user, { questionId, answer: formData.get("answer") }));
  const told = outcome.ok ? outcome.value.told : 0;
  back(formData, listingId, outcome, `The answer is published to every bidder in the room, and ${told} bidder${told === 1 ? " was" : "s were"} told.`);
}

export async function declineListingQuestion(formData: FormData) {
  const user = await requireUser();
  const questionId = String(formData.get("questionId") || "");
  const listingId = await listingOf(questionId);
  const gated = await seatGate(user, "message");
  if (gated) back(formData, listingId, { ok: false, error: gated }, "");
  const outcome = deskDenied(user, "sales") ?? (await declineQuestion(user, { questionId, note: formData.get("note") }));
  back(formData, listingId, outcome, "The question is closed. Only the bidder who asked was told.");
}
