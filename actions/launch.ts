"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { launchNow, moveLaunch } from "@/lib/launch";
import { launchTime } from "@/lib/launch-rules";
import { requireDesk } from "@/lib/staff";

function done(listingId: string, outcome: { error: string | null }, notice: string): never {
  revalidatePath("/marketplace");
  revalidatePath(`/marketplace/${listingId}`);
  revalidatePath(`/admin/listings/${listingId}`);
  const query = outcome.error ? `error=${encodeURIComponent(outcome.error)}` : `notice=${encodeURIComponent(notice)}`;
  redirect(`/admin/listings/${listingId}?${query}`);
}

// A coming-soon listing's launch, after approval: a new time, or live now. The sales side decides it, as at approval.
export async function changeLaunch(formData: FormData) {
  const listingId = String(formData.get("listingId") || "");
  const user = await requireDesk("sales", `/admin/listings/${listingId}`);
  if (String(formData.get("intent") || "") === "now") {
    const outcome = await launchNow({ listingId, actorId: user.id });
    return done(listingId, outcome, "Listing is live");
  }
  const outcome = await moveLaunch({ listingId, actorId: user.id, launchAt: String(formData.get("launchAt") || "") });
  done(listingId, outcome, outcome.error === null ? `Coming soon until ${launchTime(outcome.at)}` : "");
}
