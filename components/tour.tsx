"use client";

import { useEffect, useState } from "react";

const STEPS: Record<string, { title: string; body: string }[]> = {
  ADMIN: [
    { title: "The ledger first", body: "Revenue is the home of the desk. Premiums, commissions, and Pro sit there." },
    { title: "Review, then award", body: "The queue releases paper. Offers become closings. A sealed bid waits for its deadline." },
    { title: "Forms and people", body: "Contacts show demand. The forms page edits the purchase agreement, assignment, and allonge." },
  ],
  BUYER: [
    { title: "The book", body: "Filter the live paper, or open the map. Free membership veils the ratios." },
    { title: "Underwrite, then bid", body: "A listing takes a bid and shows yield or a resolution case. Offers wait on an approved buyer file." },
    { title: "Membership", body: "Pro opens the data room. A referral code can cover one month." },
  ],
  SELLER: [
    { title: "Your desk", body: "Views, inquiries, and a suggested price from comparable notes live on the home list." },
    { title: "File the paper", body: "One note, or a tape. The desk still reviews before anything is live." },
    { title: "After a bid", body: "An accepted offer opens a closing. You can download the forms and, once closed, the boarding package." },
  ],
};

export function OnboardingTour({ role }: { role: string }) {
  const key = role === "BROKER" ? "" : role === "ADMIN" ? "ADMIN" : role === "BUYER" ? "BUYER" : "SELLER";
  const steps = key ? STEPS[key] : [];
  const storageKey = `upb-tour-${key}`;
  const [index, setIndex] = useState<number | null>(null);
  useEffect(() => {
    if (!key) return;
    if (window.localStorage.getItem(storageKey) === "done") return;
    setIndex(0);
  }, [storageKey, key]);
  if (!key || index == null || !steps.length) return null;
  const step = steps[index];
  function finish() {
    window.localStorage.setItem(storageKey, "done");
    setIndex(null);
  }
  return (
    <div className="fixed inset-x-3 bottom-3 z-40 rounded-[14px] border border-border bg-popover p-4 shadow-[var(--shadow)] sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-96">
      <p className="eyebrow">First look · {index + 1} of {steps.length}</p>
      <h2 className="mt-1 text-base font-semibold tracking-tight text-foreground">{step.title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
      <div className="mt-3 flex gap-2">
        {index < steps.length - 1 ? (
          <button type="button" className="h-8 rounded-[9px] bg-primary px-3 text-[13px] font-semibold text-primary-foreground" onClick={() => setIndex(index + 1)}>
            Next
          </button>
        ) : (
          <button type="button" className="h-8 rounded-[9px] bg-primary px-3 text-[13px] font-semibold text-primary-foreground" onClick={finish}>
            Done
          </button>
        )}
        <button type="button" className="h-8 rounded-[9px] px-3 text-[13px] font-medium text-muted-foreground hover:bg-hover" onClick={finish}>
          Skip
        </button>
      </div>
    </div>
  );
}
