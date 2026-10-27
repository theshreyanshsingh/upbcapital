"use client";

import { useEffect, useState } from "react";

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
  return (
    <p className="font-semibold tracking-tight text-3xl text-foreground" aria-live="polite">
      <span className="mb-1 block text-xs font-medium text-link">{label}</span>
      {days}d {hours}h {minutes}m {seconds}s
    </p>
  );
}
