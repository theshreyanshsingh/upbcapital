"use server";

import { requireRole } from "@/lib/auth";
import { deskAssist, type DeskTask } from "@/lib/desk-ai";
import { prisma } from "@/lib/prisma";

export async function askDesk(_prev: { answer: string; provider: string }, formData: FormData) {
  const user = await requireRole(["ADMIN", "INSTITUTIONAL_SELLER"]);
  const task = String(formData.get("task") || "describe") as DeskTask;
  if (task !== "summarize" && task !== "tape" && task !== "describe") {
    return { answer: "That request is not one of the desk tasks.", provider: "mock" };
  }
  let payload = String(formData.get("payload") || "").trim();
  const listingId = String(formData.get("listingId") || "");
  if (listingId && task !== "tape") {
    const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { notes: true } });
    if (listing && user.role !== "ADMIN" && listing.sellerId !== user.id) {
      return { answer: "That listing is not one of yours.", provider: "mock" };
    }
    if (listing) {
      const loans = listing.notes.map((note) => ({
        state: note.state,
        city: note.city,
        upb: Number(note.upb),
        paymentStatus: note.paymentStatus,
        rate: Number(note.interestRate),
        lien: note.lienPosition,
        ask: Number(note.askingPrice),
      }));
      payload = JSON.stringify({ title: listing.title, summary: listing.summary, prompt: payload, loans });
    }
  }
  if (payload.length < 8) return { answer: "Add a few facts first.", provider: "mock" };
  const result = await deskAssist(task, payload.slice(0, 12000));
  return { answer: result.text, provider: result.provider };
}
