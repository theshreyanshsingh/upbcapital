"use client";

import { useState, useTransition } from "react";
import { saveFlowProgram } from "@/actions/flow";
import { Field } from "@/components/page-intro";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LIEN_POSITIONS, PAYMENT_STATUSES } from "@/lib/labels";

export type ProgramDraft = {
  id: string;
  name: string;
  cadence: string;
  firstLookHours: number;
  expectedVolume: number | null;
  terms: string;
  lienPositions: string[];
  paymentStatuses: string[];
  states: string[];
  maxUpb: number | null;
  minSeasoningMonths: number | null;
};

// The seller's programme: a name and cadence, what qualifies a loan, the first-look hours and the terms buyers accept.
// It answers in place rather than reloading, so a long terms text survives a mistake.
export function FlowProgramForm({
  program,
  cadences,
  hours,
}: {
  program?: ProgramDraft;
  cadences: readonly { value: string; label: string }[];
  hours: { min: number; max: number; standard: number };
}) {
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError("");
    start(async () => {
      const result = await saveFlowProgram(data);
      if (result?.error) setError(result.error);
    });
  }

  return (
    <form onSubmit={submit} className="space-y-5 rounded-xl border border-border p-5">
      {program && <input type="hidden" name="programId" value={program.id} />}
      <Field label="Programme name">
        <Input name="name" required minLength={3} maxLength={120} defaultValue={program?.name} placeholder="Gulfstream monthly flow" className="h-11 bg-card" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Cadence">
          <select name="cadence" defaultValue={program?.cadence ?? "MONTHLY"} className="desk-input">
            {cadences.map((cadence) => (
              <option key={cadence.value} value={cadence.value}>{cadence.label}</option>
            ))}
          </select>
        </Field>
        <Field label="First look, in hours" hint={`Between ${hours.min} and ${hours.max}. Committed buyers see each tranche alone for this long after the desk approves it.`}>
          <Input name="firstLookHours" type="number" required min={hours.min} max={hours.max} step={1} defaultValue={program?.firstLookHours ?? hours.standard} className="h-11 bg-card tabular-nums" />
        </Field>
      </div>
      <Field label="Expected volume per tranche, in UPB (optional)" hint="What buyers can plan for. It binds nobody.">
        <Input name="expectedVolume" inputMode="decimal" defaultValue={program?.expectedVolume ?? ""} placeholder="5,000,000" className="h-11 bg-card tabular-nums" />
      </Field>
      <fieldset className="space-y-4 border-t border-border pt-5">
        <legend className="type-label font-medium text-foreground">What qualifies a loan</legend>
        <p className="text-sm text-muted-foreground">Leave a part blank for any. A loan outside the criteria is flagged before you submit a tranche, and the desk sees the flag.</p>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-foreground">
          <span className="w-full text-[13px] text-muted-foreground">Lien positions</span>
          {LIEN_POSITIONS.map((lien) => (
            <label key={lien.value} className="flex items-center gap-2">
              <input type="checkbox" name="lienPositions" value={lien.value} defaultChecked={program?.lienPositions.includes(lien.value)} />
              {lien.label}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-foreground">
          <span className="w-full text-[13px] text-muted-foreground">Payment statuses</span>
          {PAYMENT_STATUSES.map((status) => (
            <label key={status.value} className="flex items-center gap-2">
              <input type="checkbox" name="paymentStatuses" value={status.value} defaultChecked={program?.paymentStatuses.includes(status.value)} />
              {status.label}
            </label>
          ))}
        </div>
        <Field label="States" hint="Two-letter codes, separated by commas.">
          <Input name="states" defaultValue={program?.states.join(", ")} placeholder="FL, GA, TX" className="h-11 bg-card" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Largest UPB a loan">
            <Input name="maxUpb" inputMode="decimal" defaultValue={program?.maxUpb ?? ""} placeholder="400,000" className="h-11 bg-card tabular-nums" />
          </Field>
          <Field label="Minimum seasoning, in months">
            <Input name="minSeasoningMonths" type="number" min={0} max={480} step={1} defaultValue={program?.minSeasoningMonths ?? ""} className="h-11 bg-card tabular-nums" />
          </Field>
        </div>
      </fieldset>
      <Field label="Programme terms" hint="What a buyer accepts once to join: how tranches are offered, the first look, and anything a committed buyer agrees to. Each bid is still confirmed one by one.">
        <Textarea name="terms" required minLength={20} maxLength={10000} defaultValue={program?.terms} className="min-h-48 bg-card" />
      </Field>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending} className="h-11 px-5 text-[13px] font-medium">
          {pending ? "Saving…" : program ? "Save the programme" : "Send to the desk"}
        </Button>
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      </div>
    </form>
  );
}
