"use client";

import { useState } from "react";
import { addEntity } from "@/actions/buyer-entities";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";

type Kind = { value: string; label: string };

// Another buying entity for the buyer's file. An IRA asks for its custodian and the account title the paper vests in,
// with the note that the custodian signs and funds.
export function BuyerEntityForm({ kinds, iraNote, titleExample }: { kinds: readonly Kind[]; iraNote: string; titleExample: string }) {
  const [kind, setKind] = useState(kinds[0]?.value ?? "LLC");
  const ira = kind === "IRA";
  return (
    <form action={addEntity} className="mt-4 space-y-4">
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Kind of entity</span>
        <select name="entityType" value={kind} onChange={(event) => setKind(event.target.value)} className="desk-input mt-2">
          {kinds.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">{ira ? "A name for this IRA" : "Legal name"}</span>
        <Input name="name" required minLength={2} maxLength={160} placeholder={ira ? "Jane Doe IRA" : "Harbor Note Partners LLC"} className="mt-2 h-11 bg-card" />
      </label>
      {ira ? (
        <>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Custodian</span>
            <Input name="iraCustodian" required minLength={3} maxLength={160} placeholder="Equity Trust Company" className="mt-2 h-11 bg-card" />
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Account title the paper vests in</span>
            <Input name="iraAccountTitle" required minLength={10} maxLength={200} placeholder={titleExample} className="mt-2 h-11 bg-card" aria-describedby="ira-note" />
          </label>
          <p id="ira-note" className="rounded-lg border border-link/30 bg-link/5 px-3 py-2 text-xs leading-relaxed text-foreground">{iraNote}</p>
        </>
      ) : (
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Formed in</span>
          <Input name="jurisdiction" required minLength={2} maxLength={80} placeholder="Delaware" className="mt-2 h-11 bg-card" />
        </label>
      )}
      <SubmitButton variant="outline" className="h-11 text-[13px] font-medium" pendingLabel="Sending…">
        Send to the desk
      </SubmitButton>
    </form>
  );
}
