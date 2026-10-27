"use client";

import { useActionState } from "react";
import { askDesk } from "@/actions/assistant";
import { SubmitButton } from "@/components/submit-button";

export function AssistantPanel({ listings }: { listings: { id: string; title: string }[] }) {
  const [state, action] = useActionState(askDesk, { answer: "", provider: "" });
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <form action={action} className="glass space-y-4 p-5">
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Task</span>
          <select name="task" className="desk-input mt-2" aria-label="Task">
            <option value="summarize">Summarize a tape</option>
            <option value="tape">Explain data issues</option>
            <option value="describe">Draft a listing</option>
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Listing, optional</span>
          <select name="listingId" className="desk-input mt-2" aria-label="Listing" defaultValue="">
            <option value="">None</option>
            {listings.map((listing) => <option key={listing.id} value={listing.id}>{listing.title}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Notes or tape rows</span>
          <textarea name="payload" className="desk-input mt-2 min-h-40" aria-label="Prompt" placeholder="Paste rows, or leave a sentence if a listing is selected." />
        </label>
        <SubmitButton className="h-11 text-[13px] font-medium">Ask the desk</SubmitButton>
      </form>
      <section className="border border-border p-5 rounded-xl">
        <p className="eyebrow">{state.provider === "live" ? "Model" : state.provider === "mock" ? "Desk sketch" : "Answer"}</p>
        <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{state.answer || "The answer lands here. Without an API key, the desk writes the sketch itself."}</p>
      </section>
    </div>
  );
}
