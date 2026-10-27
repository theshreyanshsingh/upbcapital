"use client";

import { useState, useTransition } from "react";
import { createNoteListing, updateOwnNote } from "@/actions/listings";
import { Field } from "@/components/page-intro";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { money } from "@/lib/format";
import {
  DOC_TYPES,
  FORECLOSURES,
  LIEN_POSITIONS,
  OCCUPANCIES,
  PAYMENT_STATUSES,
  PROPERTY_TYPES,
  US_STATES,
} from "@/lib/labels";
import { bpsToPercent } from "@/lib/money";

type Draft = {
  streetAddress: string;
  city: string;
  state: string;
  zip: string;
  propertyType: string;
  occupancy: string;
  estimatedValue: string;
  lienPosition: string;
  upb: string;
  interestRate: string;
  monthlyPi: string;
  paymentStatus: string;
  monthsDelinquent: string;
  lastPaidDate: string;
  originationDate: string;
  maturityDate: string;
  askingPrice: string;
  foreclosureStatus: string;
  borrowerName: string;
  narrative: string;
  sellerFinanced: string;
};

const steps = ["Property", "Loan", "Performance", "Price", "Documents", "Review"];

const empty: Draft = {
  streetAddress: "",
  city: "",
  state: "FL",
  zip: "",
  propertyType: "SFR",
  occupancy: "OWNER_OCCUPIED",
  estimatedValue: "",
  lienPosition: "FIRST",
  upb: "",
  interestRate: "",
  monthlyPi: "",
  paymentStatus: "PERFORMING",
  monthsDelinquent: "0",
  lastPaidDate: "",
  originationDate: "",
  maturityDate: "",
  askingPrice: "",
  foreclosureStatus: "NONE",
  borrowerName: "",
  narrative: "",
  sellerFinanced: "false",
};

export function NoteWizard({
  mode,
  listingId,
  initial,
  premiumBps,
  commissionBps,
  leadId,
}: {
  mode: "create" | "edit";
  listingId?: string;
  initial?: Partial<Draft>;
  premiumBps: number;
  commissionBps: number;
  leadId?: string;
}) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>({ ...empty, ...initial });
  const [files, setFiles] = useState<Record<string, File[]>>({});
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function validate(index: number) {
    if (index === 0) {
      if (draft.streetAddress.trim().length < 3) return "Enter the street address.";
      if (draft.city.trim().length < 2) return "Enter the city.";
      if (!/^[A-Za-z]{2}$/.test(draft.state)) return "Use a two-letter state.";
      if (!/^\d{5}$/.test(draft.zip)) return "Use a 5-digit ZIP.";
    }
    if (index === 1) {
      if (Number(draft.upb) <= 0) return "UPB must be greater than zero.";
      if (Number(draft.interestRate) < 0 || Number(draft.interestRate) > 40) return "Enter a note rate between 0 and 40.";
      if (Number(draft.monthlyPi) < 0 || draft.monthlyPi === "") return "Enter monthly principal and interest.";
      if (Number(draft.estimatedValue) <= 0) return "Enter the estimated property value.";
    }
    if (index === 2 && Number(draft.monthsDelinquent) < 0) return "Months delinquent cannot be negative.";
    if (index === 3 && Number(draft.askingPrice) <= 0) return "Enter an asking price.";
    return "";
  }

  function next() {
    const message = validate(step);
    setError(message);
    if (!message) setStep((current) => Math.min(current + 1, steps.length - 1));
  }

  function submit() {
    const message = [0, 1, 2, 3].map(validate).find(Boolean);
    if (message) {
      setError(message);
      return;
    }
    const formData = new FormData();
    if (leadId) formData.set("leadId", leadId);
    Object.entries(draft).forEach(([key, value]) => formData.set(key, value));
    Object.entries(files).forEach(([type, group]) => {
      group.forEach((file) => {
        formData.append("documents", file);
        formData.append("documentTypes", type);
      });
    });
    start(async () => {
      const result = mode === "edit" && listingId ? await updateOwnNote(listingId, formData) : await createNoteListing(formData);
      if (result?.error) setError(result.error);
    });
  }

  const ask = Number(draft.askingPrice) || 0;
  const upb = Number(draft.upb) || 0;
  const value = Number(draft.estimatedValue) || 0;
  const premium = (ask * premiumBps) / 10000;
  const commission = (ask * commissionBps) / 10000;

  return (
    <div className="grid gap-8 lg:grid-cols-[200px_minmax(0,1fr)]">
      <ol className="flex gap-4 overflow-x-auto lg:block lg:space-y-4">
        {steps.map((label, index) => (
          <li key={label}>
            <button type="button" onClick={() => index < step && setStep(index)} className={index === step ? "text-link" : "text-muted-foreground"}>
              <span className="mr-3 font-semibold tracking-tight text-2xl">{String(index + 1).padStart(2, "0")}</span>
              <span className="text-[13px] font-medium">{label}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="glass p-6 md:p-10">
        {step === 0 && (
          <div className="grid gap-5 md:grid-cols-2">
            <div className="md:col-span-2">
              <Field label="Street address" hint="Hidden from buyers until they acknowledge confidentiality.">
                <Input className="h-11 bg-card" value={draft.streetAddress} onChange={(event) => set("streetAddress", event.target.value)} />
              </Field>
            </div>
            <Field label="City">
              <Input className="h-11 bg-card" value={draft.city} onChange={(event) => set("city", event.target.value)} />
            </Field>
            <Field label="State">
              <EnumSelect value={draft.state} onChange={(value) => set("state", value)} options={US_STATES.map((state) => ({ value: state, label: state }))} />
            </Field>
            <Field label="ZIP">
              <Input className="h-11 bg-card" value={draft.zip} onChange={(event) => set("zip", event.target.value)} />
            </Field>
            <Field label="Property type">
              <EnumSelect value={draft.propertyType} onChange={(value) => set("propertyType", value)} options={PROPERTY_TYPES} />
            </Field>
            <Field label="Occupancy">
              <EnumSelect value={draft.occupancy} onChange={(value) => set("occupancy", value)} options={OCCUPANCIES} />
            </Field>
          </div>
        )}
        {step === 1 && (
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="Lien position">
              <EnumSelect value={draft.lienPosition} onChange={(value) => set("lienPosition", value)} options={LIEN_POSITIONS} />
            </Field>
            <Field label="Unpaid principal balance">
              <Input className="h-11 bg-card" inputMode="decimal" value={draft.upb} onChange={(event) => set("upb", event.target.value)} />
            </Field>
            <Field label="Interest rate (%)">
              <Input className="h-11 bg-card" inputMode="decimal" value={draft.interestRate} onChange={(event) => set("interestRate", event.target.value)} />
            </Field>
            <Field label="Monthly P&I">
              <Input className="h-11 bg-card" inputMode="decimal" value={draft.monthlyPi} onChange={(event) => set("monthlyPi", event.target.value)} />
            </Field>
            <Field label="Estimated property value" hint="BPO, appraisal, or your own as-is view.">
              <Input className="h-11 bg-card" inputMode="decimal" value={draft.estimatedValue} onChange={(event) => set("estimatedValue", event.target.value)} />
            </Field>
            <Field label="Origination">
              <Input className="h-11 bg-card" type="date" value={draft.originationDate} onChange={(event) => set("originationDate", event.target.value)} />
            </Field>
            <Field label="Maturity">
              <Input className="h-11 bg-card" type="date" value={draft.maturityDate} onChange={(event) => set("maturityDate", event.target.value)} />
            </Field>
          </div>
        )}
        {step === 2 && (
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="Payment status">
              <EnumSelect value={draft.paymentStatus} onChange={(value) => set("paymentStatus", value)} options={PAYMENT_STATUSES} />
            </Field>
            <Field label="Months delinquent">
              <Input className="h-11 bg-card" inputMode="numeric" value={draft.monthsDelinquent} onChange={(event) => set("monthsDelinquent", event.target.value)} />
            </Field>
            <Field label="Last paid">
              <Input className="h-11 bg-card" type="date" value={draft.lastPaidDate} onChange={(event) => set("lastPaidDate", event.target.value)} />
            </Field>
            <Field label="Foreclosure">
              <EnumSelect value={draft.foreclosureStatus} onChange={(value) => set("foreclosureStatus", value)} options={FORECLOSURES} />
            </Field>
          </div>
        )}
        {step === 3 && (
          <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
            <div className="space-y-5">
              <Field label="Asking price" hint="What you want for the note, before the desk's buyer premium.">
                <Input className="h-11 bg-card" inputMode="decimal" value={draft.askingPrice} onChange={(event) => set("askingPrice", event.target.value)} />
              </Field>
              <Field label="Borrower name" hint="Shown only after a buyer acknowledges confidentiality.">
                <Input className="h-11 bg-card" value={draft.borrowerName} onChange={(event) => set("borrowerName", event.target.value)} />
              </Field>
              <Field label="Notes for the desk">
                <Textarea className="min-h-32 bg-card" value={draft.narrative} onChange={(event) => set("narrative", event.target.value)} />
              </Field>
            </div>
            <FeeCard ask={ask} upb={upb} value={value} premium={premium} commission={commission} premiumBps={premiumBps} commissionBps={commissionBps} />
          </div>
        )}
        {step === 4 && (
          <div className="grid gap-4">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Attach the note, mortgage, pay history, BPO, and title if you have them. The desk can ask for anything missing. Buyers see files only after confidentiality, and only on Pro.
            </p>
            {DOC_TYPES.map((doc) => (
              <label key={doc.value} className="block border border-dashed border-link/30 p-4 rounded-xl">
                <span className="eyebrow">{doc.label}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{doc.hint}</span>
                <input
                  type="file"
                  multiple
                  accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.xls,.xlsx,.doc,.docx,.txt"
                  className="mt-3 block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-2 file:text-[13px] file:font-medium file:text-primary-foreground"
                  onChange={(event) => setFiles((current) => ({ ...current, [doc.value]: Array.from(event.target.files ?? []) }))}
                />
                {(files[doc.value] ?? []).length > 0 && (
                  <span className="mt-2 block text-xs text-foreground">{files[doc.value].map((file) => file.name).join(", ")}</span>
                )}
              </label>
            ))}
          </div>
        )}
        {step === 5 && (
          <div className="space-y-6">
            <div>
              <p className="eyebrow">{draft.city || "City"}, {draft.state}</p>
              <h2 className="mt-2 font-semibold tracking-tight text-lg text-foreground">{draft.streetAddress || "Untitled note"}</h2>
              <p className="mt-3 text-sm text-muted-foreground">{draft.narrative || "No narrative yet."}</p>
            </div>
            <dl className="grid gap-4 sm:grid-cols-2 text-sm">
              <Row k="UPB" v={upb ? money(upb) : "—"} />
              <Row k="Ask" v={ask ? money(ask) : "—"} />
              <Row k="Value" v={value ? money(value) : "—"} />
              <Row k="Rate" v={draft.interestRate ? `${draft.interestRate}%` : "—"} />
              <Row k="Status" v={draft.paymentStatus.replaceAll("_", " ").toLowerCase()} />
              <Row k="Lien" v={draft.lienPosition.toLowerCase()} />
            </dl>
            <FeeCard ask={ask} upb={upb} value={value} premium={premium} commission={commission} premiumBps={premiumBps} commissionBps={commissionBps} />
            <label className="flex items-start gap-3 text-sm text-foreground">
              <input
                type="checkbox"
                className="mt-1"
                checked={draft.sellerFinanced === "true"}
                onChange={(event) => set("sellerFinanced", event.target.checked ? "true" : "false")}
              />
              <span>This note was originated as seller financing. The listing will carry the Dodd-Frank and SAFE Act reminders.</span>
            </label>
          </div>
        )}
        {error && <p className="mt-6 text-sm text-bad">{error}</p>}
        <div className="mt-8 flex items-center justify-between gap-3">
          <Button type="button" variant="ghost" className="h-11 px-4 text-[13px] font-medium" onClick={() => setStep((current) => Math.max(current - 1, 0))} disabled={step === 0}>
            Back
          </Button>
          {step < steps.length - 1 ? (
            <Button type="button" className="h-11 px-5 text-[13px] font-medium" onClick={next}>
              Continue
            </Button>
          ) : (
            <Button type="button" className="h-11 px-5 text-[13px] font-medium" onClick={submit} disabled={pending}>
              {pending ? "Sending…" : mode === "edit" ? "Resubmit to the desk" : "Submit to the desk"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-b border-border py-2">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-foreground">{v}</dd>
    </div>
  );
}

function FeeCard({
  ask,
  upb,
  value,
  premium,
  commission,
  premiumBps,
  commissionBps,
}: {
  ask: number;
  upb: number;
  value: number;
  premium: number;
  commission: number;
  premiumBps: number;
  commissionBps: number;
}) {
  return (
    <aside className="border border-link/30 bg-link/5 p-5 rounded-xl">
      <p className="eyebrow">At this ask</p>
      <dl className="mt-4 space-y-2 text-sm">
        <Row k="Price / UPB" v={upb ? `${((ask / upb) * 100).toFixed(1)}%` : "—"} />
        <Row k="Price / value" v={value ? `${((ask / value) * 100).toFixed(1)}%` : "—"} />
        <Row k={`Your commission ${bpsToPercent(commissionBps).toFixed(2)}%`} v={ask ? money(commission) : "—"} />
        <Row k="Estimated net to you" v={ask ? money(ask - commission) : "—"} />
        <Row k={`Buyer all-in +${bpsToPercent(premiumBps).toFixed(2)}%`} v={ask ? money(ask + premium) : "—"} />
      </dl>
    </aside>
  );
}

function EnumSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <Select
      value={value}
      items={Object.fromEntries(options.map((option) => [option.value, option.label]))}
      onValueChange={(next) => onChange(next ?? value)}
    >
      <SelectTrigger className="h-11 w-full rounded-sm bg-card">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
