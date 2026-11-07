"use client";

import { useState } from "react";
import { saveBoarding } from "@/actions/boarding";
import { SubmitButton } from "@/components/submit-button";
import type { BoardingChoice } from "@/lib/servicers";

type Saved = {
  servicerId: string | null;
  servicerName: string;
  contactEmail: string;
  loanNumber: string;
  boardedAt: string;
  goodbyeSentAt: string;
  helloSentAt: string;
  notes: string;
};

// The buyer's boarding form. A servicer picked from the desk's directory fills the name and the boarding email, and
// says when it doesn't list a loan's state. One that isn't on the directory is typed in, as before.
export function BoardingForm({ closingId, saved, choices }: { closingId: string; saved: Saved; choices: BoardingChoice[] }) {
  const linked = choices.some((choice) => choice.id === saved.servicerId) ? saved.servicerId ?? "" : "";
  const [pick, setPick] = useState(linked);
  const [name, setName] = useState(saved.servicerName);
  const [email, setEmail] = useState(saved.contactEmail);
  const chosen = choices.find((choice) => choice.id === pick) ?? null;
  const warn = chosen && (chosen.missing.length > 0 || chosen.unlisted);
  const choose = (id: string) => {
    setPick(id);
    const next = choices.find((choice) => choice.id === id);
    if (!next) return;
    setName(next.name);
    if (next.contactEmail) setEmail(next.contactEmail);
  };
  return (
    <form action={saveBoarding} className="mt-4 grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="closingId" value={closingId} />
      {choices.length > 0 && (
        <label className="block sm:col-span-2">
          <span className="text-[13px] text-muted-foreground">From the servicer directory</span>
          <select name="servicerId" value={pick} onChange={(event) => choose(event.target.value)} className="desk-input mt-2" aria-describedby={warn ? "servicer-states" : undefined}>
            <option value="">Not on the directory. I&apos;ll type it below</option>
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.name}{choice.active ? "" : " (no longer on the directory)"}
              </option>
            ))}
          </select>
        </label>
      )}
      {chosen && warn && (
        <p id="servicer-states" role="status" className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-foreground sm:col-span-2">
          {chosen.unlisted
            ? `The directory lists no states for ${chosen.name}. Check they service loans where this one is before boarding it.`
            : `${chosen.name} doesn't list ${chosen.missing.join(", ")} on the directory. Check they service loans there before boarding.`}
        </p>
      )}
      <label className="block sm:col-span-2">
        <span className="text-[13px] text-muted-foreground">Servicer</span>
        <input
          name="servicerName"
          value={name}
          onChange={(event) => setName(event.target.value)}
          readOnly={Boolean(chosen)}
          className="desk-input mt-2 read-only:text-muted-foreground"
          required
        />
        {chosen && <span className="mt-1 block text-xs text-muted-foreground">The name as the directory has it. Choose &quot;Not on the directory&quot; to type another.</span>}
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Contact email</span>
        <input name="contactEmail" type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="desk-input mt-2" />
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Loan number</span>
        <input name="loanNumber" defaultValue={saved.loanNumber} className="desk-input mt-2" />
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Servicing transfer date</span>
        <input name="boardedAt" type="date" defaultValue={saved.boardedAt} className="desk-input mt-2" aria-label="Servicing transfer date" />
        <span className="mt-1 block text-xs text-muted-foreground">The day the new servicer starts taking payments.</span>
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Old servicer&apos;s letter sent</span>
        <input name="goodbyeSentAt" type="date" defaultValue={saved.goodbyeSentAt} className="desk-input mt-2" aria-label="Old servicer's letter sent" />
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">New servicer&apos;s letter sent</span>
        <input name="helloSentAt" type="date" defaultValue={saved.helloSentAt} className="desk-input mt-2" aria-label="New servicer's letter sent" />
      </label>
      <label className="block sm:col-span-2">
        <span className="text-[13px] text-muted-foreground">Notes</span>
        <textarea name="notes" defaultValue={saved.notes} className="desk-input mt-2 min-h-24" aria-label="Boarding notes" />
      </label>
      <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
        <SubmitButton className="h-11 text-[13px] font-medium">Save boarding</SubmitButton>
        <a className="text-[13px] font-medium text-link" href={`/api/closings/${closingId}/boarding`}>Download package</a>
      </div>
    </form>
  );
}
