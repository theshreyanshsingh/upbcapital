"use client";

import { useState } from "react";
import { submitBrokerDeal } from "@/actions/broker";
import { ChoiceCard, FieldLabel, StepChrome } from "@/components/broker-chrome";
import { FORECLOSURES, LIEN_POSITIONS, OCCUPANCIES, PAYMENT_STATUSES, PROPERTY_TYPES, US_STATES } from "@/lib/labels";

const empty = {
  clientSellerName: "",
  clientRelationship: "",
  brokerRole: "SELLER_BROKER",
  kind: "NOTE",
  title: "",
  summary: "",
  streetAddress: "",
  city: "",
  state: "FL",
  zip: "",
  propertyType: "SFR",
  occupancy: "UNKNOWN",
  estimatedValue: "",
  lienPosition: "FIRST",
  upb: "",
  interestRate: "",
  monthlyPi: "",
  paymentStatus: "PERFORMING",
  monthsDelinquent: "0",
  askingPrice: "",
  foreclosureStatus: "NONE",
  borrowerName: "",
  narrative: "",
};

export function BrokerWizard({ licensed }: { licensed: boolean }) {
  const [step, setStep] = useState(0);
  const [fields, setFields] = useState(empty);
  const [authorization, setAuthorization] = useState<File | null>(null);
  const [tape, setTape] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  function set<K extends keyof typeof empty>(key: K, value: string) {
    setFields((current) => ({ ...current, [key]: value }));
  }

  async function send() {
    setPending(true);
    setError("");
    const body = new FormData();
    Object.entries(fields).forEach(([key, value]) => body.set(key, value));
    if (authorization) body.set("authorization", authorization);
    if (tape) body.set("tape", tape);
    const result = await submitBrokerDeal(body);
    setPending(false);
    if (result?.error) setError(result.error);
  }

  const back = step > 0 ? (
    <button type="button" onClick={() => { setError(""); setStep((current) => current - 1); }} className="min-h-12 px-4 text-[13px] font-medium text-muted-foreground">
      Back
    </button>
  ) : null;

  return (
    <>
      {step === 0 && (
        <StepChrome step={1} total={4} kicker="The relationship" title="Who is the seller, and what are you to them?" lede="Name the client and how you represent them. The authorization comes on the next pages. A seller’s broker needs a license on file. An affiliate does not.">
          <div className="space-y-4">
            <FieldLabel label="Seller">
              <input className="desk-input" value={fields.clientSellerName} onChange={(event) => set("clientSellerName", event.target.value)} aria-label="Seller name" placeholder="Helen Marsh" />
            </FieldLabel>
            <FieldLabel label="How you know them">
              <input className="desk-input" value={fields.clientRelationship} onChange={(event) => set("clientRelationship", event.target.value)} aria-label="Relationship" placeholder="Engaged to sell the note" />
            </FieldLabel>
            <div className="grid gap-3">
              <ChoiceCard selected={fields.brokerRole === "SELLER_BROKER"} title="Seller’s broker" lede={licensed ? "You are engaged to sell this paper." : "Add a license number on your profile before you file in this seat."} onSelect={() => set("brokerRole", "SELLER_BROKER")} />
              <ChoiceCard selected={fields.brokerRole === "AFFILIATE"} title="Referring affiliate" lede="You introduced the seller. You are not the broker of record." onSelect={() => set("brokerRole", "AFFILIATE")} />
            </div>
            {error && <p className="text-sm text-bad">{error}</p>}
            <div className="sticky bottom-0 -mx-4 mt-8 flex gap-2 border-t border-border bg-card/92 px-4 py-4 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:px-0">
              <button type="button" className="min-h-12 flex-1 bg-primary px-5 text-[13px] font-medium text-primary-foreground rounded-lg" onClick={() => {
                if (fields.clientSellerName.trim().length < 2 || fields.clientRelationship.trim().length < 2) {
                  setError("Name the seller and the relationship.");
                  return;
                }
                if (fields.brokerRole === "SELLER_BROKER" && !licensed) {
                  setError("A seller’s broker needs a license number on the profile.");
                  return;
                }
                setError("");
                setStep(1);
              }}>Continue</button>
            </div>
          </div>
        </StepChrome>
      )}
      {step === 1 && (
        <StepChrome step={2} total={4} kicker="The paper" title="One note, or a whole tape." lede="A single loan is enough. A tape should use the desk’s column names, or stay close to them. The file still waits on review before a buyer sees it.">
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <ChoiceCard selected={fields.kind === "NOTE"} title="Single note" lede="One loan, one asking price." onSelect={() => set("kind", "NOTE")} />
              <ChoiceCard selected={fields.kind === "TAPE"} title="Tape" lede="A CSV or Excel sheet of loans." onSelect={() => set("kind", "TAPE")} />
            </div>
            {fields.kind === "TAPE" ? (
              <>
                <FieldLabel label="Pool name">
                  <input className="desk-input" value={fields.title} onChange={(event) => set("title", event.target.value)} aria-label="Pool name" />
                </FieldLabel>
                <FieldLabel label="Tape">
                  <input className="desk-input py-2" type="file" accept=".csv,.xlsx,.xls,text/csv" aria-label="Tape file" onChange={(event) => setTape(event.target.files?.[0] ?? null)} />
                </FieldLabel>
                <a className="inline-block text-[13px] font-medium text-link" href="/api/tapes/template?format=csv">Download the template</a>
                <FieldLabel label="Note for the desk">
                  <textarea className="desk-input min-h-24" value={fields.summary} onChange={(event) => set("summary", event.target.value)} aria-label="Pool summary" />
                </FieldLabel>
              </>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <FieldLabel label="Street"><input className="desk-input" value={fields.streetAddress} onChange={(event) => set("streetAddress", event.target.value)} aria-label="Street" /></FieldLabel>
                <FieldLabel label="City"><input className="desk-input" value={fields.city} onChange={(event) => set("city", event.target.value)} aria-label="City" /></FieldLabel>
                <FieldLabel label="State">
                  <select className="desk-input" value={fields.state} onChange={(event) => set("state", event.target.value)} aria-label="State">
                    {US_STATES.map((state) => <option key={state}>{state}</option>)}
                  </select>
                </FieldLabel>
                <FieldLabel label="ZIP"><input className="desk-input" value={fields.zip} onChange={(event) => set("zip", event.target.value)} aria-label="ZIP" inputMode="numeric" /></FieldLabel>
                <FieldLabel label="Property">
                  <select className="desk-input" value={fields.propertyType} onChange={(event) => set("propertyType", event.target.value)} aria-label="Property type">
                    {PROPERTY_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </FieldLabel>
                <FieldLabel label="Lien">
                  <select className="desk-input" value={fields.lienPosition} onChange={(event) => set("lienPosition", event.target.value)} aria-label="Lien">
                    {LIEN_POSITIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </FieldLabel>
                <FieldLabel label="Occupancy">
                  <select className="desk-input" value={fields.occupancy} onChange={(event) => set("occupancy", event.target.value)} aria-label="Occupancy">
                    {OCCUPANCIES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </FieldLabel>
                <FieldLabel label="Foreclosure">
                  <select className="desk-input" value={fields.foreclosureStatus} onChange={(event) => set("foreclosureStatus", event.target.value)} aria-label="Foreclosure">
                    {FORECLOSURES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </FieldLabel>
                <FieldLabel label="Estimated value"><input className="desk-input" value={fields.estimatedValue} onChange={(event) => set("estimatedValue", event.target.value)} aria-label="Estimated value" inputMode="decimal" /></FieldLabel>
                <FieldLabel label="Unpaid balance"><input className="desk-input" value={fields.upb} onChange={(event) => set("upb", event.target.value)} aria-label="Unpaid balance" inputMode="decimal" /></FieldLabel>
                <FieldLabel label="Rate %"><input className="desk-input" value={fields.interestRate} onChange={(event) => set("interestRate", event.target.value)} aria-label="Interest rate" inputMode="decimal" /></FieldLabel>
                <FieldLabel label="Monthly P&I"><input className="desk-input" value={fields.monthlyPi} onChange={(event) => set("monthlyPi", event.target.value)} aria-label="Monthly payment" inputMode="decimal" /></FieldLabel>
                <FieldLabel label="Asking price"><input className="desk-input" value={fields.askingPrice} onChange={(event) => set("askingPrice", event.target.value)} aria-label="Asking price" inputMode="decimal" /></FieldLabel>
                <FieldLabel label="Pay status">
                  <select className="desk-input" value={fields.paymentStatus} onChange={(event) => set("paymentStatus", event.target.value)} aria-label="Payment status">
                    {PAYMENT_STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </FieldLabel>
                <FieldLabel label="Months late"><input className="desk-input" value={fields.monthsDelinquent} onChange={(event) => set("monthsDelinquent", event.target.value)} aria-label="Months delinquent" inputMode="numeric" /></FieldLabel>
                <FieldLabel label="Borrower, if you have it"><input className="desk-input" value={fields.borrowerName} onChange={(event) => set("borrowerName", event.target.value)} aria-label="Borrower" /></FieldLabel>
                <div className="sm:col-span-2">
                  <FieldLabel label="What a buyer should know">
                    <textarea className="desk-input min-h-24" value={fields.narrative} onChange={(event) => set("narrative", event.target.value)} aria-label="Narrative" />
                  </FieldLabel>
                </div>
              </div>
            )}
            {error && <p className="text-sm text-bad">{error}</p>}
            <div className="sticky bottom-0 -mx-4 mt-8 flex gap-2 border-t border-border bg-card/92 px-4 py-4 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:px-0">
              {back}
              <button type="button" className="min-h-12 flex-1 bg-primary px-5 text-[13px] font-medium text-primary-foreground rounded-lg" onClick={() => { setError(""); setStep(2); }}>Continue</button>
            </div>
          </div>
        </StepChrome>
      )}
      {step === 2 && (
        <StepChrome step={3} total={4} kicker="Authorization" title="The seller said you could bring this." lede="Upload the engagement letter or a written authorization. PDF or a photo. The desk reads it before the file goes live. It is not shown to buyers.">
          <div className="space-y-4">
            <FieldLabel label="Authorization or engagement letter">
              <input className="desk-input py-2" type="file" accept="application/pdf,image/png,image/jpeg" aria-label="Authorization" onChange={(event) => setAuthorization(event.target.files?.[0] ?? null)} />
            </FieldLabel>
            {authorization && <p className="text-sm text-foreground">{authorization.name}</p>}
            <p className="text-sm leading-relaxed text-muted-foreground">Without this letter the file cannot be sent. A fee is not owed until the trade closes, and it is withheld if you are also the buyer or the seller.</p>
            {error && <p className="text-sm text-bad">{error}</p>}
            <div className="sticky bottom-0 -mx-4 mt-8 flex gap-2 border-t border-border bg-card/92 px-4 py-4 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:px-0">
              {back}
              <button type="button" className="min-h-12 flex-1 bg-primary px-5 text-[13px] font-medium text-primary-foreground rounded-lg" onClick={() => {
                if (!authorization) {
                  setError("Upload the seller’s authorization.");
                  return;
                }
                setError("");
                setStep(3);
              }}>Review</button>
            </div>
          </div>
        </StepChrome>
      )}
      {step === 3 && (
        <StepChrome step={4} total={4} kicker="Send it" title="Read it once, then give it to the desk." lede="You can come back to the file from your pipeline. Status changes show on the deal, from review through close.">
          <div className="space-y-3 border border-border p-5 text-sm rounded-xl">
            <Row k="Seller" v={fields.clientSellerName} />
            <Row k="Relationship" v={fields.clientRelationship} />
            <Row k="Your seat" v={fields.brokerRole === "AFFILIATE" ? "Referring affiliate" : "Seller’s broker"} />
            <Row k="Paper" v={fields.kind === "TAPE" ? fields.title || "Tape" : `${fields.city || "City"} · ${fields.state}`} />
            <Row k="Ask" v={fields.kind === "NOTE" && fields.askingPrice ? `$${Number(fields.askingPrice).toLocaleString("en-US")}` : "From the tape"} />
            <Row k="Letter" v={authorization?.name || "Missing"} />
          </div>
          {error && <p className="mt-4 text-sm text-bad">{error}</p>}
          <div className="sticky bottom-0 -mx-4 mt-8 flex gap-2 border-t border-border bg-card/92 px-4 py-4 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:px-0">
            {back}
            <button type="button" disabled={pending} onClick={send} className="min-h-12 flex-1 bg-primary px-5 text-[13px] font-medium text-primary-foreground disabled:opacity-60 rounded-lg">
              {pending ? "Sending…" : "File with the desk"}
            </button>
          </div>
        </StepChrome>
      )}
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right text-foreground">{v}</dd>
    </div>
  );
}
