"use client";

import { useState } from "react";
import { addEntity } from "@/actions/buyer-entities";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";

type Kind = { value: string; label: string };
type Regulator = { value: string; label: string; kinds: string[] };

// Another buying entity for the buyer's file. An IRA asks for its custodian and the account title the paper vests in,
// with the note that the custodian signs and funds. A bank or credit union asks for its charter number and regulator,
// which the desk checks (lib/institutions.ts). An LLC, trust, fund or other entity lists its owners next.
export function BuyerEntityForm({
  kinds,
  iraNote,
  titleExample,
  taxNote,
  regulators = [],
  charterNote = "",
}: {
  kinds: readonly Kind[];
  iraNote: string;
  titleExample: string;
  taxNote: string;
  regulators?: readonly Regulator[];
  charterNote?: string;
}) {
  const [kind, setKind] = useState(kinds[0]?.value ?? "LLC");
  const ira = kind === "IRA";
  const institution = kind === "BANK" || kind === "CREDIT_UNION";
  // Kept beside lib/beneficial-owners.ts needsOwners: a person and an IRA list no owners.
  const listsOwners = !ira && kind !== "INDIVIDUAL";
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
      {institution && (
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block min-w-0">
            <span className="text-[13px] text-muted-foreground">{kind === "BANK" ? "FDIC certificate number" : "NCUA charter number"}</span>
            <Input name="charterNumber" required inputMode="numeric" pattern="[0-9 ]*" maxLength={8} autoComplete="off" placeholder="12345" className="mt-2 h-11 w-full bg-card tabular-nums" aria-describedby="entity-charter-note" />
          </label>
          <label className="block min-w-0">
            <span className="text-[13px] text-muted-foreground">Regulator</span>
            <select key={kind} name="regulator" required defaultValue="" className="desk-input mt-2">
              <option value="" disabled>Choose one</option>
              {regulators.filter((regulator) => regulator.kinds.includes(kind)).map((regulator) => (
                <option key={regulator.value} value={regulator.value}>{regulator.label}</option>
              ))}
            </select>
          </label>
          <p id="entity-charter-note" className="text-xs text-muted-foreground sm:col-span-2">{charterNote}</p>
        </div>
      )}
      <label className="block">
        <span className="text-[13px] text-muted-foreground">{ira ? "Last four digits of the IRA's tax ID, if it has one" : kind === "INDIVIDUAL" ? "Last four digits of the SSN or EIN" : "Last four digits of its EIN"}</span>
        <Input name="taxIdLast4" inputMode="numeric" pattern="[0-9]{4}" minLength={4} maxLength={4} autoComplete="off" required={!ira} placeholder="1234" className="mt-2 h-11 w-32 bg-card tabular-nums" aria-describedby="entity-tax-note" />
        <span id="entity-tax-note" className="mt-1 block text-xs text-muted-foreground">{taxNote}</span>
      </label>
      <SubmitButton variant="outline" className="h-11 text-[13px] font-medium" pendingLabel="Sending…">
        {listsOwners ? "Add the entity" : "Send to the desk"}
      </SubmitButton>
      {listsOwners && <p className="text-xs text-muted-foreground">Next you list its owners and send it to the desk.</p>}
    </form>
  );
}
