"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDesk } from "@/lib/staff";
import { CALENDAR_KEYS, cancelEvent, createEvent, editEvent, enterEvent, leaveEvent } from "@/lib/sale-events";

// Every action here is the desk's. Each one checks the role itself, since a server action is a public endpoint.

const field = (formData: FormData, key: string) => String(formData.get(key) || "");

// The process calendar's four optional dates and the letter's notes, as the event forms send them.
function calendarFields(formData: FormData) {
  return {
    ...Object.fromEntries(CALENDAR_KEYS.map((key) => [key, field(formData, key)])),
    processNotes: field(formData, "processNotes"),
  };
}

function to(path: string, key: "notice" | "error", text: string): never {
  redirect(`${path}?${key}=${encodeURIComponent(text)}`);
}

function refresh(eventId: string, listingId?: string) {
  revalidatePath("/admin/events");
  revalidatePath(`/admin/events/${eventId}`);
  revalidatePath("/events");
  revalidatePath("/marketplace");
  if (listingId) {
    revalidatePath(`/admin/listings/${listingId}`);
    revalidatePath(`/marketplace/${listingId}`);
  }
}

// Adding and removing run from the event page and from the listing's desk page, and land back where they started.
function backTo(formData: FormData, eventId: string, listingId: string) {
  return field(formData, "back") === "listing" ? `/admin/listings/${listingId}` : `/admin/events/${eventId}`;
}

export async function createSaleEvent(formData: FormData) {
  const user = await requireDesk("sales", "/admin/events");
  const result = await createEvent({
    name: field(formData, "name"),
    summary: field(formData, "summary"),
    indicationsAt: field(formData, "indicationsAt"),
    bestFinalAt: field(formData, "bestFinalAt"),
    ...calendarFields(formData),
    actorId: user.id,
  });
  if (result.error !== null) to("/admin/events", "error", result.error);
  refresh(result.event.id);
  to(`/admin/events/${result.event.id}`, "notice", result.usual ? "Event created. Add listings next." : "Event created. Its gap is outside the usual 16 to 21 days.");
}

export async function editSaleEvent(formData: FormData) {
  const user = await requireDesk("sales", "/admin/events");
  const eventId = field(formData, "eventId");
  const result = await editEvent({
    eventId,
    name: field(formData, "name"),
    summary: field(formData, "summary"),
    indicationsAt: field(formData, "indicationsAt"),
    bestFinalAt: field(formData, "bestFinalAt"),
    ...calendarFields(formData),
    actorId: user.id,
  });
  if (result.error !== null) to(`/admin/events/${eventId}`, "error", result.error);
  refresh(eventId);
  to(`/admin/events/${eventId}`, "notice", result.moved ? "Event saved. The sellers have the new dates." : "Event saved.");
}

export async function addEventListing(formData: FormData) {
  const user = await requireDesk("sales", "/admin/events");
  const eventId = field(formData, "eventId");
  const listingId = field(formData, "listingId");
  const back = backTo(formData, eventId, listingId);
  if (!eventId || !listingId) to(back, "error", "Choose an event and a listing.");
  const result = await enterEvent({ eventId, listingId, consent: field(formData, "consent"), actorId: user.id });
  if (result.error !== null) to(back, "error", result.error);
  refresh(eventId, listingId);
  to(back, "notice", "The listing is in the event. Its seller was told, and its bids are sealed indications now.");
}

export async function removeEventListing(formData: FormData) {
  const user = await requireDesk("sales", "/admin/events");
  const eventId = field(formData, "eventId");
  const listingId = field(formData, "listingId");
  const back = backTo(formData, eventId, listingId);
  const result = await leaveEvent({ eventId, listingId, actorId: user.id });
  if (result.error !== null) to(back, "error", result.error);
  refresh(eventId, listingId);
  to(back, "notice", "The listing is out of the event and back on open offers. Its seller was told.");
}

export async function cancelSaleEvent(formData: FormData) {
  const user = await requireDesk("sales", "/admin/events");
  const eventId = field(formData, "eventId");
  const result = await cancelEvent({ eventId, actorId: user.id });
  if (result.error !== null) to(`/admin/events/${eventId}`, "error", result.error);
  refresh(eventId);
  to(`/admin/events/${eventId}`, "notice", "The event is canceled. Its listings are back on open offers.");
}
