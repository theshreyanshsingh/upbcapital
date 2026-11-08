import { CalendarFeedControl } from "@/components/calendar-feed-control";
import { requirePerson } from "@/lib/auth";

// On the notice settings page. The link is the signed-in person's own, so a firm's seat sees whether it has one.
export async function CalendarFeedSection() {
  const { person } = await requirePerson();
  return <CalendarFeedControl active={Boolean(person.calendarTokenHash)} />;
}
