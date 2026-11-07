import { milestones, when } from "@/lib/sale-events";

type Dated = {
  id: string;
  indicationsAt: Date;
  bestFinalAt: Date;
  ndaDueAt?: Date | null;
  qaCutoffAt?: Date | null;
  awardTargetAt?: Date | null;
  closingTargetAt?: Date | null;
};

// The event's process letter and its calendar file. Plain links, since both are files the browser opens or saves.
// A span, so it can sit inside a paragraph such as the listing page's event line.
export function EventPaperLinks({ eventId, className = "" }: { eventId: string; className?: string }) {
  return (
    <span className={`flex flex-wrap gap-x-4 gap-y-1 text-[13px] font-medium ${className}`}>
      <a href={`/api/events/${eventId}/letter`} className="text-link">Process letter (PDF)</a>
      <a href={`/api/events/${eventId}/calendar.ics`} className="text-link">Add the dates to your calendar</a>
    </span>
  );
}

// Every date the event has set, in the order the sale runs, in UTC.
export function EventCalendar({ event }: { event: Dated }) {
  return (
    <ol className="space-y-1 text-sm tabular-nums">
      {milestones(event).map((milestone) => (
        <li key={milestone.key} className="flex flex-wrap justify-between gap-x-3">
          <span className="text-muted-foreground">{milestone.label}</span>
          <span className="text-foreground">{when(milestone.at)}</span>
        </li>
      ))}
    </ol>
  );
}
