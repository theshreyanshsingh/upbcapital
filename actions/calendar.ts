"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requirePerson } from "@/lib/auth";
import { calendarFeedUrl, endCalendarFeed, issueCalendarFeed } from "@/lib/calendar-feed";
import { consumeRateLimit } from "@/lib/rate-limit";

const PAGE = "/account/notifications";

export type FeedState = { url: string; error: string; notice: string };

// The site's own address for a link that leaves it: the configured app URL, else the host this request came to.
async function origin() {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL;
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") || incoming.get("host") || "";
  const proto = incoming.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  return host ? `${proto}://${host}` : "";
}

// "make" makes the link, or a new one in place of the old, which stops working at once. The link comes back in the
// form state, shown once, never in a URL. "off" ends the feed.
export async function changeCalendarFeed(_prev: FeedState, formData: FormData): Promise<FeedState> {
  // The link is the person's own, so a firm's seats each have theirs and one rotating it never cuts off another.
  const user = (await requirePerson()).person;
  if (formData.get("intent") === "off") {
    await endCalendarFeed(user.id);
    revalidatePath(PAGE);
    return { url: "", error: "", notice: "The calendar feed is off. Calendars subscribed to it stop updating." };
  }
  if (!(await consumeRateLimit(`calendar-link:${user.id}`, 10, 60 * 60 * 1000))) {
    return { url: "", error: "Too many new links in the last hour. Wait a while, then try again.", notice: "" };
  }
  const token = await issueCalendarFeed(user.id);
  revalidatePath(PAGE);
  return { url: calendarFeedUrl(token, await origin()), error: "", notice: "" };
}
