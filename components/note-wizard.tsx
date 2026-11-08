"use client";

import { useRef, useState, useTransition } from "react";
import { createNoteListing, updateOwnNote } from "@/actions/listings";
import { checkNoteMarket } from "@/actions/market-rates";
import { PriceAgainstTime } from "@/components/indicative-price";
import { Field } from "@/components/page-intro";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { chargeFees, effectiveBps, flatTerms, type FeeTerms } from "@/lib/fee-schedule";
import { money } from "@/lib/format";
import type { PriceLadder } from "@/lib/indicative";
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
import {
  BANKRUPTCY_CHAPTERS,
  CREDIT_SCORE_MAX,
  CREDIT_SCORE_MIN,
  CREDIT_SCORE_TYPES,
  LOAN_PURPOSES,
  LOSS_MIT_STAGES,
  PAYMENT_TYPES,
  SERVICING_KEYS,
  VALUE_TYPES,
  parseMersMin,
  parsePayString,
  type ServicingKey,
} from "@/lib/tape-fields";

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
} & Record<ServicingKey, string>;

const steps = ["Property", "Loan", "Performance", "Servicing", "Price", "Documents", "Review"] as const;

const YES_NO = [
  { value: "true", label: "Yes" },
  { value: "false", label: "No" },
] as const;

const CHAPTERS = BANKRUPTCY_CHAPTERS.map((chapter) => ({ value: chapter, label: `Chapter ${chapter}` }));

const DAY = 86400000;

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
  ...(Object.fromEntries(SERVICING_KEYS.map((key) => [key, ""])) as Record<ServicingKey, string>),
};

export function NoteWizard({
  mode,
  listingId,
  initial,
  premiumBps: flatPremiumBps,
  commissionBps: flatCommissionBps,
  fees,
  leadId,
}: {
  mode: "create" | "edit";
  listingId?: string;
  initial?: Partial<Draft>;
  premiumBps: number;
  commissionBps: number;
  // The listing's fee terms, so a graded schedule prices the ask as typed. Missing means the two rates flat.
  fees?: FeeTerms;
  leadId?: string;
}) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>({ ...empty, ...initial });
  const [files, setFiles] = useState<Record<string, File[]>>({});
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const [market, setMarket] = useState<{ ladder: PriceLadder | null; error: string | null; loading: boolean }>({ ladder: null, error: null, loading: false });
  // Only the latest check lands, so an answer for an older ask never overwrites a newer one.
  const checkId = useRef(0);
  // An edit page that doesn't pass the stored servicing record shows it blank, so blanks mustn't clear it on save.
  const servicingLoaded = mode === "create" || SERVICING_KEYS.some((key) => initial?.[key] !== undefined);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function validate(index: number) {
    const name = steps[index];
    if (name === "Property") {
      if (draft.streetAddress.trim().length < 3) return "Enter the street address.";
      if (draft.city.trim().length < 2) return "Enter the city.";
      if (!/^[A-Za-z]{2}$/.test(draft.state)) return "Use a two-letter state.";
      if (!/^\d{5}$/.test(draft.zip)) return "Use a 5-digit ZIP.";
    }
    if (name === "Loan") {
      if (Number(draft.upb) <= 0) return "UPB must be greater than zero.";
      if (draft.interestRate.trim() === "" || !(Number(draft.interestRate) >= 0 && Number(draft.interestRate) <= 40)) return "Enter a note rate between 0 and 40.";
      if (Number(draft.monthlyPi) < 0 || draft.monthlyPi === "") return "Enter monthly principal and interest.";
      if (Number(draft.estimatedValue) <= 0) return "Enter the estimated property value.";
    }
    if (name === "Performance" && Number(draft.monthsDelinquent) < 0) return "Months delinquent cannot be negative.";
    if (name === "Servicing") {
      if (draft.payString.trim() && !parsePayString(draft.payString)) return "Use 0 to 9 or X for each month of the pay string, newest month first.";
      // A day of slack, as on the server, for a date picked ahead of the server's timezone.
      const future = (value: string) => value !== "" && new Date(value).getTime() > Date.now() + DAY;
      if (future(draft.modificationDate)) return "The modification date can't be in the future.";
      if (future(draft.bankruptcyFiledAt)) return "The bankruptcy filing date can't be in the future.";
      if (future(draft.foreclosureFiledAt)) return "The foreclosure filing date can't be in the future.";
      if (future(draft.valueAsOf)) return "The value date can't be in the future.";
      if (draft.armMargin.trim() && !(Number(draft.armMargin) >= 0 && Number(draft.armMargin) <= 20)) return "Enter the margin as a percent, such as 2.75.";
      const score = draft.creditScore.trim();
      if (score && !(Number.isInteger(Number(score)) && Number(score) >= CREDIT_SCORE_MIN && Number(score) <= CREDIT_SCORE_MAX)) {
        return `Credit scores run from ${CREDIT_SCORE_MIN} to ${CREDIT_SCORE_MAX}.`;
      }
      if (future(draft.creditScoreDate)) return "The score date can't be in the future.";
      if (draft.mersMin.trim() && !parseMersMin(draft.mersMin)) return "A MERS MIN is 18 digits.";
      // Tape v3, with the server's wording.
      const amount = (value: string) => (value.trim() === "" ? null : Number(value));
      const original = amount(draft.originalBalance);
      if (original != null && !(original > 0)) return "The original balance must be greater than zero.";
      if (draft.escrowBalance.trim() && !Number.isFinite(Number(draft.escrowBalance))) return "Enter the escrow balance as an amount.";
      const arrears = amount(draft.arrearsAmount);
      if (arrears != null && !(arrears >= 0)) return "Arrears can't be below zero.";
      const payoff = amount(draft.payoffAmount);
      if (payoff != null && !(payoff > 0)) return "The payoff must be greater than zero.";
      if (payoff != null && !draft.payoffAsOf) return "Give the date the payoff is good through.";
      if (draft.payoffAsOf && payoff == null) return "Enter the payoff amount for that date.";
      const senior = amount(draft.seniorLienBalance);
      if (senior != null && !(senior >= 0)) return "The senior lien balance can't be below zero.";
    }
    if (name === "Price" && Number(draft.askingPrice) <= 0) return "Enter an asking price.";
    return "";
  }

  // The ask against standing demand and comps, run as the seller reaches the review.
  function checkMarket() {
    const id = ++checkId.current;
    setMarket({ ladder: null, error: null, loading: true });
    checkNoteMarket({
      state: draft.state,
      lienPosition: draft.lienPosition,
      paymentStatus: draft.paymentStatus,
      occupancy: draft.occupancy,
      upb: draft.upb,
      interestRate: draft.interestRate,
      monthlyPi: draft.monthlyPi,
      estimatedValue: draft.estimatedValue,
      askingPrice: draft.askingPrice,
      maturityDate: draft.maturityDate,
      monthsDelinquent: draft.monthsDelinquent,
      foreclosureFiledAt: draft.foreclosureFiledAt,
      valueType: draft.valueType,
      valueAsOf: draft.valueAsOf,
    })
      .then((result) => {
        if (id !== checkId.current) return;
        setMarket(result.error === null ? { ladder: result.ladder, error: null, loading: false } : { ladder: null, error: result.error, loading: false });
      })
      .catch(() => {
        if (id === checkId.current) setMarket({ ladder: null, error: "The market check is unavailable right now. You can still submit.", loading: false });
      });
  }

  function next() {
    const message = validate(step);
    setError(message);
    if (message) return;
    const upcoming = Math.min(step + 1, steps.length - 1);
    setStep(upcoming);
    if (steps[upcoming] === "Review") checkMarket();
  }

  function submit() {
    const message = steps.map((_, index) => validate(index)).find(Boolean);
    if (message) {
      setError(message);
      return;
    }
    const formData = new FormData();
    if (leadId) formData.set("leadId", leadId);
    Object.entries(draft).forEach(([key, value]) => formData.set(key, value));
    // A first lien has nothing ahead of it, so a senior balance typed before the lien changed isn't sent.
    if (draft.lienPosition === "FIRST") formData.set("seniorLienBalance", "");
    formData.set("servicingLoaded", servicingLoaded ? "true" : "false");
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
  const charged = chargeFees(fees ?? flatTerms(flatPremiumBps, flatCommissionBps), ask);
  const premium = charged.premiumCents / 100;
  const commission = charged.commissionCents / 100;
  // The rates the fees come to at this ask, minimums included, for the fee card's labels.
  const premiumBps = ask > 0 ? effectiveBps(charged) : charged.premiumBps;
  const commissionBps = ask > 0 ? effectiveBps(charged, "commission") : charged.commissionBps;
  const payStored = draft.payString.trim() ? parsePayString(draft.payString) : null;

  return (
    <div className="grid gap-5 sm:gap-8 lg:grid-cols-[200px_minmax(0,1fr)]">
      {/* Below a wide screen the steps are one line, which step of how many, and a bar that fills as they go. A
          finished step's segment goes back to it, as the step list does on a wide screen. */}
      <div className="lg:hidden">
        <div className="flex items-baseline justify-between gap-3" aria-live="polite">
          <p className="text-[13px] font-medium text-link tabular-nums">Step {step + 1} of {steps.length}</p>
          <p className="truncate text-sm font-semibold text-foreground">{steps[step]}</p>
        </div>
        <ol className="mt-1 flex gap-1">
          {steps.map((label, index) => (
            <li key={label} className="flex-1">
              <button
                type="button"
                disabled={index >= step}
                onClick={() => setStep(index)}
                aria-label={index < step ? `Back to step ${index + 1}, ${label}` : `Step ${index + 1}, ${label}`}
                aria-current={index === step ? "step" : undefined}
                className="flex h-6 w-full items-center disabled:cursor-default"
              >
                <span className={`step-bar h-1 w-full rounded-full ${index <= step ? "bg-link" : "bg-muted"}`} />
              </button>
            </li>
          ))}
        </ol>
      </div>
      <ol className="relative hidden lg:block lg:space-y-4">
        {steps.map((label, index) => (
          <li key={label}>
            <button type="button" onClick={() => index < step && setStep(index)} className={index === step ? "text-link" : "text-muted-foreground"}>
              <span className="mr-3 font-semibold tracking-tight text-2xl">{String(index + 1).padStart(2, "0")}</span>
              <span className="text-[13px] font-medium">{label}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="glass p-5 md:p-10">
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
              <Input className="h-11 bg-card" inputMode="numeric" maxLength={10} value={draft.zip} onChange={(event) => set("zip", event.target.value)} />
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
          <div className="grid gap-5 md:grid-cols-2">
            <p className="text-sm leading-relaxed text-muted-foreground md:col-span-2">
              All optional. Fill in what you know from the servicer&apos;s statement or your own records, and skip the rest. Buyers price faster with a pay history and a next due date.
            </p>
            <Field label="Loan number" hint="The servicer's number for this loan. Kept private, like the street address.">
              <Input className="h-11 bg-card" autoComplete="off" value={draft.loanNumber} onChange={(event) => set("loanNumber", event.target.value)} />
            </Field>
            <Field label="Servicer" hint="The company that collects the payments. Leave it blank if you collect them yourself.">
              <Input className="h-11 bg-card" value={draft.servicerName} onChange={(event) => set("servicerName", event.target.value)} />
            </Field>
            <div className="md:col-span-2">
              <Field
                label="Pay history"
                hint={`One character a month, newest month first: 0 paid on time, 1 to 9 months behind, X nothing due. A year of on-time payments is 000000000000.${payStored && payStored !== draft.payString.trim() ? ` Saved as ${payStored}.` : ""}`}
              >
                <Input className="h-11 bg-card tabular-nums" autoComplete="off" spellCheck={false} value={draft.payString} onChange={(event) => set("payString", event.target.value)} />
              </Field>
            </div>
            <Field label="Next payment due" hint="The due date of the oldest unpaid payment.">
              <Input className="h-11 bg-card" type="date" value={draft.nextDueDate} onChange={(event) => set("nextDueDate", event.target.value)} />
            </Field>
            <Field label="Loss mitigation" hint="Any forbearance, repayment plan or trial modification, in a few words.">
              <Input className="h-11 bg-card" value={draft.lossMitigation} onChange={(event) => set("lossMitigation", event.target.value)} />
            </Field>
            <Field label="Loss mitigation stage" hint="Where the borrower's request stands: received, options offered, or decided.">
              <OptionalSelect value={draft.lossMitStage} options={LOSS_MIT_STAGES} unsure="None or not sure" onChange={(value) => set("lossMitStage", value)} />
            </Field>
            <Field label="Has the loan been modified?">
              <OptionalSelect
                value={draft.modified}
                options={YES_NO}
                onChange={(value) => setDraft((current) => ({ ...current, modified: value, modificationDate: value === "true" ? current.modificationDate : "" }))}
              />
            </Field>
            {draft.modified === "true" ? (
              <Field label="Modification date">
                <Input className="h-11 bg-card" type="date" value={draft.modificationDate} onChange={(event) => set("modificationDate", event.target.value)} />
              </Field>
            ) : (
              <div className="hidden md:block" />
            )}
            <Field label="Borrower bankruptcy">
              <OptionalSelect
                value={draft.bankruptcyChapter}
                options={CHAPTERS}
                unsure="None or not sure"
                onChange={(value) => setDraft((current) => ({ ...current, bankruptcyChapter: value, bankruptcyFiledAt: value ? current.bankruptcyFiledAt : "" }))}
              />
            </Field>
            {draft.bankruptcyChapter ? (
              <Field label="Bankruptcy filed">
                <Input className="h-11 bg-card" type="date" value={draft.bankruptcyFiledAt} onChange={(event) => set("bankruptcyFiledAt", event.target.value)} />
              </Field>
            ) : (
              <div className="hidden md:block" />
            )}
            <Field label="Foreclosure filed" hint="Leave it blank if no foreclosure case has been filed.">
              <Input className="h-11 bg-card" type="date" value={draft.foreclosureFiledAt} onChange={(event) => set("foreclosureFiledAt", event.target.value)} />
            </Field>
            <Field label="Loan purpose" hint="What the borrower used the loan for.">
              <OptionalSelect value={draft.loanPurpose} options={LOAN_PURPOSES} onChange={(value) => set("loanPurpose", value)} />
            </Field>
            <Field label="Where the value came from">
              <OptionalSelect value={draft.valueType} options={VALUE_TYPES} onChange={(value) => set("valueType", value)} />
            </Field>
            <Field label="Value date" hint="When the BPO, appraisal or estimate was done.">
              <Input className="h-11 bg-card" type="date" value={draft.valueAsOf} onChange={(event) => set("valueAsOf", event.target.value)} />
            </Field>
            <Field label="HOA lien on the property?" hint="A homeowners association can file a lien for unpaid dues.">
              <OptionalSelect value={draft.hoaLien} options={YES_NO} onChange={(value) => set("hoaLien", value)} />
            </Field>
            <Field label="Property taxes past due?">
              <OptionalSelect value={draft.taxDelinquent} options={YES_NO} onChange={(value) => set("taxDelinquent", value)} />
            </Field>
            {draft.loanPurpose === "SELLER_FINANCED" && (
              <div className="md:col-span-2">
                <OriginatorLicense value={draft.originatorLicense} onChange={(value) => set("originatorLicense", value)} />
              </div>
            )}

            <p className="eyebrow pt-4 md:col-span-2">Rate, credit and registry</p>
            <Field label="ARM index" hint="For an adjustable rate only: what it resets from, such as 30-day average SOFR. Leave blank for a fixed rate.">
              <Input className="h-11 bg-card" value={draft.armIndex} onChange={(event) => set("armIndex", event.target.value)} />
            </Field>
            <Field label="ARM margin (%)" hint="Added to the index at each reset.">
              <Input className="h-11 bg-card tabular-nums" inputMode="decimal" value={draft.armMargin} onChange={(event) => set("armMargin", event.target.value)} />
            </Field>
            <Field label="Next rate reset" hint="The date the rate next changes.">
              <Input className="h-11 bg-card" type="date" value={draft.armNextReset} onChange={(event) => set("armNextReset", event.target.value)} />
            </Field>
            <div className="hidden md:block" />
            <Field label="Credit score" hint={`The borrower's latest score, ${CREDIT_SCORE_MIN} to ${CREDIT_SCORE_MAX}.`}>
              <Input className="h-11 bg-card tabular-nums" inputMode="numeric" value={draft.creditScore} onChange={(event) => set("creditScore", event.target.value)} />
            </Field>
            <Field label="Score model" hint="FICO and VantageScore read differently.">
              <OptionalSelect value={draft.creditScoreType} options={CREDIT_SCORE_TYPES} onChange={(value) => set("creditScoreType", value)} />
            </Field>
            <Field label="Score date" hint="When the score was pulled.">
              <Input className="h-11 bg-card" type="date" value={draft.creditScoreDate} onChange={(event) => set("creditScoreDate", event.target.value)} />
            </Field>
            <div className="hidden md:block" />
            <Field label="MERS MIN" hint="The 18-digit number on the mortgage, if it's registered with MERS. Kept private, like the street address.">
              <Input className="h-11 bg-card tabular-nums" autoComplete="off" inputMode="numeric" value={draft.mersMin} onChange={(event) => set("mersMin", event.target.value)} />
            </Field>
            <Field label="eNote ID" hint="Only for a note signed electronically. Kept private, like the street address.">
              <Input className="h-11 bg-card" autoComplete="off" value={draft.eNoteId} onChange={(event) => set("eNoteId", event.target.value)} />
            </Field>
            <Field label="Originating platform" hint="The lender or system that made the loan.">
              <Input className="h-11 bg-card" value={draft.originatingPlatform} onChange={(event) => set("originatingPlatform", event.target.value)} />
            </Field>
            <div className="hidden md:block" />
            <div className="md:col-span-2">
              <Field
                label="Inherited sale covenants"
                hint="Promises that came with the loan from an earlier sale, such as an agency loan sale's loss mitigation terms. Leave it blank if there are none. Buyers read this as your statement, not a legal opinion."
              >
                <Textarea className="min-h-20 bg-card" maxLength={600} value={draft.inheritedCovenants} onChange={(event) => set("inheritedCovenants", event.target.value)} />
              </Field>
            </div>

            <p className="eyebrow pt-4 md:col-span-2">Balances and risk flags</p>
            <Field label="Original balance" hint="The amount on the note when it was made.">
              <Input className="h-11 bg-card tabular-nums" inputMode="decimal" value={draft.originalBalance} onChange={(event) => set("originalBalance", event.target.value)} />
            </Field>
            <Field label="Payment type">
              <OptionalSelect value={draft.paymentType} options={PAYMENT_TYPES} onChange={(value) => set("paymentType", value)} />
            </Field>
            <Field label="Balloon date" hint="For a balloon loan: when the rest of the balance is due.">
              <Input className="h-11 bg-card" type="date" value={draft.balloonDate} onChange={(event) => set("balloonDate", event.target.value)} />
            </Field>
            <Field label="Escrow balance" hint="Taxes and insurance held by the servicer. Below zero if the servicer advanced them.">
              <Input className="h-11 bg-card tabular-nums" inputMode="decimal" value={draft.escrowBalance} onChange={(event) => set("escrowBalance", event.target.value)} />
            </Field>
            <Field label="Arrears" hint="Missed payments, late fees and advances owed.">
              <Input className="h-11 bg-card tabular-nums" inputMode="decimal" value={draft.arrearsAmount} onChange={(event) => set("arrearsAmount", event.target.value)} />
            </Field>
            {draft.lienPosition !== "FIRST" ? (
              <Field label="Senior lien balance" hint="What is owed on the liens ahead of this one. Buyers use it for the combined LTV.">
                <Input className="h-11 bg-card tabular-nums" inputMode="decimal" value={draft.seniorLienBalance} onChange={(event) => set("seniorLienBalance", event.target.value)} />
              </Field>
            ) : (
              <div className="hidden md:block" />
            )}
            <Field label="Payoff amount" hint="The servicer's payoff quote. Give the date it's good through.">
              <Input className="h-11 bg-card tabular-nums" inputMode="decimal" value={draft.payoffAmount} onChange={(event) => set("payoffAmount", event.target.value)} />
            </Field>
            <Field label="Payoff good through">
              <Input className="h-11 bg-card" type="date" value={draft.payoffAsOf} onChange={(event) => set("payoffAsOf", event.target.value)} />
            </Field>
            <Field label="SCRA protection?" hint="Is the borrower an active-duty servicemember protected by the Servicemembers Civil Relief Act?">
              <OptionalSelect value={draft.scraFlag} options={YES_NO} onChange={(value) => set("scraFlag", value)} />
            </Field>
            <Field label="Borrower deceased?">
              <OptionalSelect value={draft.borrowerDeceased} options={YES_NO} onChange={(value) => set("borrowerDeceased", value)} />
            </Field>
            <Field label="Litigation?" hint="Any lawsuit about the loan or the property, including a contested foreclosure.">
              <OptionalSelect
                value={draft.litigationFlag}
                options={YES_NO}
                onChange={(value) => setDraft((current) => ({ ...current, litigationFlag: value, litigationNote: value === "true" ? current.litigationNote : "" }))}
              />
            </Field>
            {draft.litigationFlag === "true" ? (
              <Field label="Litigation note" hint="The court and what the case is about. Kept private, like the street address.">
                <Input className="h-11 bg-card" maxLength={300} value={draft.litigationNote} onChange={(event) => set("litigationNote", event.target.value)} />
              </Field>
            ) : (
              <div className="hidden md:block" />
            )}
          </div>
        )}
        {step === 4 && (
          <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
            <div className="space-y-5">
              <Field label="Asking price" hint="What you want for the note, before the desk's buyer premium.">
                <Input className="h-11 bg-card" inputMode="decimal" value={draft.askingPrice} onChange={(event) => set("askingPrice", event.target.value)} />
              </Field>
              <Field label="Borrower name" hint="Shown only after a buyer acknowledges confidentiality.">
                <Input className="h-11 bg-card" value={draft.borrowerName} onChange={(event) => set("borrowerName", event.target.value)} />
              </Field>
              <Field label="Summary for buyers" hint="Shown on the book to every buyer, before any NDA. Leave out borrower names and street addresses.">
                <Textarea className="min-h-32 bg-card" value={draft.narrative} onChange={(event) => set("narrative", event.target.value)} />
              </Field>
            </div>
            <FeeCard ask={ask} upb={upb} value={value} premium={premium} commission={commission} premiumBps={premiumBps} commissionBps={commissionBps} />
          </div>
        )}
        {step === 5 && (
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
        {step === 6 && (
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
              <Row k="Servicer" v={draft.servicerName.trim() || "—"} />
              <Row k="Pay history" v={payStored || "—"} />
            </dl>
            <FeeCard ask={ask} upb={upb} value={value} premium={premium} commission={commission} premiumBps={premiumBps} commissionBps={commissionBps} />
            <PriceAgainstTime ladder={market.ladder} loading={market.loading} error={market.error} />
            <label className="flex items-start gap-3 text-sm text-foreground">
              <input
                type="checkbox"
                className="mt-1"
                checked={draft.sellerFinanced === "true"}
                onChange={(event) => set("sellerFinanced", event.target.checked ? "true" : "false")}
              />
              <span>This note was originated as seller financing. The listing will carry the Dodd-Frank and SAFE Act reminders.</span>
            </label>
            {draft.sellerFinanced === "true" && (
              <OriginatorLicense value={draft.originatorLicense} onChange={(value) => set("originatorLicense", value)} />
            )}
          </div>
        )}
        {error && <p role="alert" className="mt-6 text-sm text-bad">{error}</p>}
        {/* On a phone Back and Continue stay pinned above the tab bar while the step scrolls. */}
        <div className="mt-8 flex items-center justify-between gap-3 max-md:sticky max-md:bottom-[var(--dock,0px)] max-md:z-10 max-md:-mx-5 max-md:-mb-5 max-md:rounded-b-[inherit] max-md:border-t max-md:border-border max-md:bg-card/95 max-md:px-5 max-md:py-3 max-md:backdrop-blur-xl">
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

// Asked only for seller financing, where buyers check whether a licensed loan originator took the application.
function OriginatorLicense({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Field
      label="Originator license"
      hint="Seller-financed notes are easier to sell when a licensed loan originator handled the borrower. Enter their name and NMLS ID, or say in a few words why none was used. Kept private, like the street address."
    >
      <Input className="h-11 bg-card" maxLength={200} value={value} onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

const UNSURE = "UNSURE";

// "Not sure" is a real answer here, and it saves nothing.
function OptionalSelect({
  value,
  onChange,
  options,
  unsure = "Not sure",
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  unsure?: string;
}) {
  return (
    <EnumSelect
      value={value || UNSURE}
      onChange={(next) => onChange(next === UNSURE ? "" : next)}
      options={[{ value: UNSURE, label: unsure }, ...options]}
    />
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
