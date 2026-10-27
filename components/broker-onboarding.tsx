"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveBrokerProfile } from "@/actions/broker";
import { FieldLabel, StepChrome } from "@/components/broker-chrome";
import { portraitSrc } from "@/lib/broker-fees";

export type BrokerDraft = {
  userId: string;
  name: string;
  company: string;
  licenseType: string;
  licenseNumber: string;
  states: string;
  payoutNote: string;
  bio: string;
  portraitKey: string;
  w9Name: string;
};

const STEPS = 6;

export function BrokerOnboarding({ draft, start }: { draft: BrokerDraft; start: number }) {
  const router = useRouter();
  const [step, setStep] = useState(Math.min(Math.max(start, 0), STEPS - 1));
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [company, setCompany] = useState(draft.company);
  const [licenseType, setLicenseType] = useState(draft.licenseType);
  const [licenseNumber, setLicenseNumber] = useState(draft.licenseNumber);
  const [states, setStates] = useState(draft.states);
  const [payoutNote, setPayoutNote] = useState(draft.payoutNote);
  const [bio, setBio] = useState(draft.bio);
  const [preview, setPreview] = useState(draft.portraitKey ? portraitSrc(draft.userId, draft.portraitKey) : "");
  const [w9Name, setW9Name] = useState(draft.w9Name);
  const [portrait, setPortrait] = useState<File | null>(null);
  const [w9, setW9] = useState<File | null>(null);

  async function save(fields: Record<string, string>, file?: { name: string; value: File | null }, finish = false) {
    setPending(true);
    setError("");
    const body = new FormData();
    Object.entries(fields).forEach(([key, value]) => body.set(key, value));
    if (file?.value) body.set(file.name, file.value);
    const result = await saveBrokerProfile(body);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (finish) {
      router.push("/broker");
      router.refresh();
      return;
    }
    setStep((current) => Math.min(current + 1, STEPS - 1));
  }

  const foot = (primary: string, onPrimary: () => void, secondary?: { label: string; onClick: () => void }) => (
    <div className="sticky bottom-0 z-10 -mx-4 mt-8 flex flex-col gap-2 border-t border-border bg-card/92 px-4 py-4 backdrop-blur md:static md:mx-0 md:flex-row md:border-0 md:bg-transparent md:px-0">
      {step > 0 && (
        <button type="button" onClick={() => { setError(""); setStep((current) => current - 1); }} className="min-h-12 px-4 text-[13px] font-medium text-muted-foreground">
          Back
        </button>
      )}
      {secondary && (
        <button type="button" onClick={secondary.onClick} className="min-h-12 border border-border px-4 text-[13px] font-medium text-foreground rounded-lg">
          {secondary.label}
        </button>
      )}
      <button type="button" disabled={pending} onClick={onPrimary} className="min-h-12 bg-primary px-5 text-[13px] font-medium text-primary-foreground disabled:opacity-60 rounded-lg">
        {pending ? "Saving…" : primary}
      </button>
    </div>
  );

  return (
    <>
      {step === 0 && (
        <StepChrome step={1} total={STEPS} kicker="Your seat" title="Tell the desk who you bring paper for." lede="Buyers and sellers already have a door. This one is for the person between them. A company name is enough to start. The license can wait if you only make introductions.">
          <div className="space-y-4">
            <FieldLabel label="Company">
              <input className="desk-input" value={company} onChange={(event) => setCompany(event.target.value)} aria-label="Company" placeholder="Vale Note Advisors" />
            </FieldLabel>
            <p className="text-sm leading-relaxed text-muted-foreground">You will choose, on each file, whether you are the seller’s broker or a referring affiliate.</p>
            {error && <p className="text-sm text-bad">{error}</p>}
            {foot("Continue", () => save({ company }))}
          </div>
        </StepChrome>
      )}
      {step === 1 && (
        <StepChrome step={2} total={STEPS} kicker="Credentials" title="Where you are allowed to work." lede="License type and number are optional for an affiliate. A seller’s broker needs both before that kind of file can be sent. States are two-letter codes.">
          <div className="space-y-4">
            <FieldLabel label="License type">
              <input className="desk-input" value={licenseType} onChange={(event) => setLicenseType(event.target.value)} aria-label="License type" placeholder="Mortgage broker" />
            </FieldLabel>
            <FieldLabel label="License number">
              <input className="desk-input" value={licenseNumber} onChange={(event) => setLicenseNumber(event.target.value)} aria-label="License number" placeholder="Optional for affiliates" />
            </FieldLabel>
            <FieldLabel label="States served">
              <input className="desk-input" value={states} onChange={(event) => setStates(event.target.value)} aria-label="States served" placeholder="FL, GA, SC" />
            </FieldLabel>
            {error && <p className="text-sm text-bad">{error}</p>}
            {foot("Continue", () => save({ licenseType, licenseNumber, states }))}
          </div>
        </StepChrome>
      )}
      {step === 2 && (
        <StepChrome step={3} total={STEPS} kicker="Portrait" title="A face, or a mark, for the page you share." lede="Buyers decide faster when they can see who introduced the paper. A headshot or a logo, square-ish, JPG or PNG. You can skip this and use a monogram.">
          <div className="space-y-4">
            <div className="mx-auto grid aspect-[3/4] w-48 place-items-center overflow-hidden border border-link/30 bg-card rounded-xl">
              {preview ? (
                // User uploads are served from this origin or a storage key. next/image would need a remote pattern for the API route.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="font-semibold tracking-tight text-[28px] text-link">{initials(draft.name)}</span>
              )}
            </div>
            <FieldLabel label="Headshot or logo">
              <input
                className="desk-input py-2 file:mr-3 file:border-0 file:bg-transparent file:text-[13px] file:font-medium file:text-link"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label="Portrait"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setPortrait(file);
                  if (file) setPreview(URL.createObjectURL(file));
                }}
              />
            </FieldLabel>
            {error && <p className="text-sm text-bad">{error}</p>}
            {foot("Save portrait", () => { void save({}, { name: "portrait", value: portrait }); })}
            <button type="button" className="text-[13px] font-medium text-muted-foreground" onClick={() => setStep(3)}>Skip for now</button>
          </div>
        </StepChrome>
      )}
      {step === 3 && (
        <StepChrome step={4} total={STEPS} kicker="W-9" title="The desk needs it before a fee is owed." lede="PDF or a photo of the form. It stays on your file. It is not shown on the public page. You can file the rest of the profile and add this before the first deal.">
          <div className="space-y-4">
            <FieldLabel label="W-9">
              <input
                className="desk-input py-2 file:mr-3 file:border-0 file:bg-transparent file:text-[13px] file:font-medium file:text-link"
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                aria-label="W-9"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setW9(file);
                  if (file) setW9Name(file.name);
                }}
              />
            </FieldLabel>
            {w9Name && <p className="text-sm text-foreground">{w9Name} is on the file.</p>}
            {error && <p className="text-sm text-bad">{error}</p>}
            {foot("Save W-9", () => { void save({}, { name: "w9", value: w9 }); }, { label: "I'll add it before I file", onClick: () => setStep(4) })}
          </div>
        </StepChrome>
      )}
      {step === 4 && (
        <StepChrome step={5} total={STEPS} kicker="Payout" title="How should the desk pay you?" lede="Name the method only. ACH, check, or wire. Do not type an account number, routing number, or any other bank coordinate. The desk collects those off this page.">
          <div className="space-y-4">
            <FieldLabel label="Payout note">
              <textarea className="desk-input min-h-32" value={payoutNote} onChange={(event) => setPayoutNote(event.target.value)} aria-label="Payout note" placeholder="ACH to the operating account named on the W-9." />
            </FieldLabel>
            {error && <p className="text-sm text-bad">{error}</p>}
            {foot("Continue", () => save({ payoutNote }))}
          </div>
        </StepChrome>
      )}
      {step === 5 && (
        <StepChrome step={6} total={STEPS} kicker="Public page" title="The paragraph you would send a buyer." lede="This is the bio on your public profile. Two or three sentences. No pitch deck. When the desk approves the seat, the page is yours to share.">
          <div className="space-y-4">
            <div className="border border-link/25 bg-card p-5 rounded-xl">
              <p className="eyebrow">{company || "Your company"}</p>
              <p className="mt-2 font-semibold tracking-tight text-3xl text-foreground">{draft.name}</p>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{bio || "Your bio will sit here."}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {states.split(",").map((state) => state.trim()).filter(Boolean).map((state) => (
                  <span key={state} className="border border-link/40 px-2 py-1 text-xs font-medium text-link rounded-xl">{state}</span>
                ))}
              </div>
            </div>
            <FieldLabel label="Bio">
              <textarea className="desk-input min-h-36" value={bio} onChange={(event) => setBio(event.target.value)} aria-label="Bio" maxLength={600} />
            </FieldLabel>
            <div className="border border-border p-4 rounded-xl">
              <p className="font-semibold tracking-tight text-2xl text-foreground">What happens next</p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">The desk reviews the seat. You can look around, but deals and referral fees wait on approval. The welcome is the first thing you see after that.</p>
            </div>
            {error && <p className="text-sm text-bad">{error}</p>}
            {foot("Finish", () => { void save({ bio }, undefined, true); }, { label: "Skip the bio", onClick: () => router.push("/broker") })}
          </div>
        </StepChrome>
      )}
    </>
  );
}

function initials(name: string) {
  return name.split(" ").map((part) => part[0]).slice(0, 2).join("").toUpperCase();
}
