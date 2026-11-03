"use client";

import { useEffect, useState } from "react";

// What a screen reader hears, and only when it changes: a live region on a clock that ticks every second would
// talk over everything else on the page.
function milestone(left: number) {
  if (left <= 0) return "closed";
  if (left <= 10 * 60000) return "under 10 minutes left";
  if (left <= 3600000) return "under an hour left";
  if (left <= 86400000) return "under a day left";
  return "";
}

export function Countdown({ deadline, mode }: { deadline: string; mode: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = new Date(deadline).getTime() - now;
  const label = mode === "SEALED" ? "Sealed bid" : mode === "BEST_AND_FINAL" ? "Best and final" : "Deadline";
  if (left <= 0) {
    return <p className="text-sm text-foreground" role="status">{label} is closed. The desk can award from the book.</p>;
  }
  const days = Math.floor(left / 86400000);
  const hours = Math.floor((left % 86400000) / 3600000);
  const minutes = Math.floor((left % 3600000) / 60000);
  const seconds = Math.floor((left % 60000) / 1000);
  const heard = milestone(left);
  return (
    <div>
      <p className="font-semibold tracking-tight text-3xl text-foreground" role="timer" aria-live="off" aria-label={`${label} closes ${new Date(deadline).toISOString().slice(0, 16).replace("T", " ")} UTC`}>
        <span className="mb-1 block text-xs font-medium text-link">{label}</span>
        {days}d {hours}h {minutes}m {seconds}s
      </p>
      <p className="sr-only" role="status">{heard ? `${label}: ${heard}.` : ""}</p>
    </div>
  );
}
