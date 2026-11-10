import { saveBorrowerNotices } from "@/actions/notices";
import { SubmitButton } from "@/components/submit-button";
import {
  borrowerNotices,
  calendarDay,
  loanScope,
  loansInScope,
  NOTICE_EXEMPTIONS,
  otherPurchasesOnUpb,
  PAYMENT_POLICIES,
  suggestedExemption,
  type NoticeExemption,
  type NoticeState,
} from "@/lib/borrower-notices";
import { prettyDate } from "@/lib/format";

const DAY = 24 * 60 * 60 * 1000;

type Note = { id: string; city: string; state: string; occupancy: string; borrowerName: string };

type Props = {
  closing: {
    id: string;
    status: string;
    closedAt: Date | null;
    transferAt: Date | null;
    loanPurpose: string | null;
    paymentPolicy: string | null;
    ownerContact: string | null;
    recordingNote: string | null;
    ownerNoticeSentAt: Date | null;
    ownerNoticeProof?: string | null;
    ownerNoticeExemption?: string | null;
    ownerOtherLoans?: boolean | null;
    deskBidId?: string | null;
    funders?: { userId: string }[];
  };
  boarding: { boardedAt: Date | null; goodbyeSentAt: Date | null; helloSentAt: Date | null } | null;
  notes: Note[];
  canEdit: boolean;
  owner: { kind: "desk" | "group" | "buyer"; buyerId: string | null; label: string };
};

function chip(state: NoticeState, due: Date | null, sent: Date | null | undefined, waiting: string, now: Date) {
  if (state === "sent") return { text: `Sent ${prettyDate(sent)}`, tone: "text-good" };
  if (state === "not_needed") return { text: "Not needed for these loans", tone: "text-muted-foreground" };
  if (state === "waiting" || !due) return { text: waiting, tone: "text-muted-foreground" };
  const left = Math.round((calendarDay(due).getTime() - calendarDay(now).getTime()) / DAY);
  if (state === "late") return { text: `${-left} day${left === -1 ? "" : "s"} late`, tone: "text-bad" };
  return { text: left === 0 ? "Due today" : `Due in ${left} day${left === 1 ? "" : "s"}`, tone: state === "due_soon" ? "text-bad" : "text-foreground" };
}

export async function BorrowerNotices({ closing, boarding, notes, canEdit, owner }: Props) {
  const now = new Date();
  const inScope = loansInScope(notes, closing.loanPurpose);
  const plan = borrowerNotices(closing, boarding, inScope.length, now);
  // UPB's own record of the owner's other purchases near this transfer. Purchases elsewhere count too, so it's a floor.
  const otherOnUpb = await otherPurchasesOnUpb(closing, owner.buyerId, plan.transfer, now);
  const suggestion = owner.kind === "group" ? null : suggestedExemption({ otherLoans: closing.ownerOtherLoans, otherOnUpb, loansHere: inScope.length });
  const exemption = plan.sale.exemption;
  const ownerName = owner.kind === "group" ? "any of the co-buyers" : owner.label;
  const effectiveNote = plan.effectiveSet ? "" : " Dated from the date of transfer until the servicing transfer date is set under Servicer boarding.";
  const graceOver = plan.graceThrough ? calendarDay(now).getTime() > plan.graceThrough.getTime() : false;
  const rows = [
    {
      label: "Owner's sale notice to the borrower",
      rule: "New owner · 30 days after the date of transfer · 12 CFR 1026.39",
      due: plan.sale.due,
      ...(exemption
        ? { text: `Not needed: ${NOTICE_EXEMPTIONS[exemption].label.toLowerCase()}`, tone: "text-muted-foreground" }
        : chip(plan.sale.state, plan.sale.due, closing.ownerNoticeSentAt, "Starts when the file closes", now)),
    },
    {
      label: "Old servicer's goodbye letter",
      rule: "At least 15 days before the servicing transfer · 12 CFR 1024.33",
      due: plan.goodbye.due,
      ...chip(plan.goodbye.state, plan.goodbye.due, boarding?.goodbyeSentAt, "Starts when the file closes", now),
    },
    {
      label: "New servicer's welcome letter",
      rule: "No more than 15 days after the servicing transfer · 12 CFR 1024.33",
      due: plan.hello.due,
      ...chip(plan.hello.state, plan.hello.due, boarding?.helloSentAt, "Starts when the file closes", now),
    },
    {
      label: "Payments to the old servicer protected",
      rule: "60 days from the servicing transfer · 12 CFR 1024.33(c)",
      due: null,
      text: plan.graceThrough ? `${graceOver ? "Ended" : "Through"} ${prettyDate(plan.graceThrough)}` : "Starts when the file closes",
      tone: "text-muted-foreground",
    },
  ];
  const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : "");
  const answer = closing.ownerOtherLoans === true ? "yes" : closing.ownerOtherLoans === false ? "no" : "";

  return (
    <section id="notices" className="mt-6 scroll-mt-6 glass p-6" aria-labelledby="notices-heading">
      <p id="notices-heading" className="eyebrow">Borrower notices</p>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        When a loan changes hands, the borrower is owed notices. UPB never contacts borrowers. These dates are for the new owner and the servicers, who send them. This is UPB&apos;s read of the rules, not legal advice. Counsel confirms it.
      </p>
      <p className="mt-3 text-sm text-foreground">
        {inScope.length} of {notes.length} loan{notes.length === 1 ? "" : "s"} look{inScope.length === 1 ? "s" : ""} in scope for the sale notice.
        {closing.loanPurpose === "BUSINESS" && " Marked business purpose, so Reg Z doesn't apply."}
        {closing.loanPurpose === "CONSUMER" && " Marked consumer credit."}
      </p>
      {!closing.loanPurpose && notes.length <= 12 && (
        <ul className="mt-2 space-y-1 text-[13px] text-muted-foreground">
          {notes.map((note) => (
            <li key={note.id}>{note.city}, {note.state} · {loanScope(note).reason}</li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[13px] text-muted-foreground">
        {owner.kind === "desk" && "UPB Capital is the new owner on a desk purchase, so the desk sends this notice. "}
        {owner.kind === "group" && "The co-buyers send one joint notice, due from the earliest closing date. "}
        The notice is owed by an owner that acquires more than one mortgage loan in any 12 months, counting loans bought anywhere.{" "}
        UPB&apos;s record shows {otherOnUpb} other purchase{otherOnUpb === 1 ? "" : "s"} by {owner.kind === "group" ? "the co-buyers" : owner.label} within 12 months of this transfer. Purchases elsewhere count too.
      </p>

      <ul className="mt-4 divide-y divide-border border border-border rounded-xl">
        {rows.map((row) => (
          <li key={row.label} className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3">
            <div>
              <p className="text-sm text-foreground">{row.label}</p>
              <p className="text-xs text-muted-foreground">{row.rule}{row.due ? ` · by ${prettyDate(row.due)}` : ""}</p>
            </div>
            <span className={`whitespace-nowrap text-[13px] font-medium ${row.tone}`}>{row.text}</span>
          </li>
        ))}
      </ul>
      {plan.sale.state === "sent" && (
        <p className="mt-3 text-xs text-foreground">
          {plan.sale.proof ? `Proof of mailing: ${plan.sale.proof}` : "No proof of mailing is on file for this notice. Add how it went and its proof below."}
        </p>
      )}
      {exemption && (
        <p className="mt-3 text-xs text-foreground">
          No sale notice recorded as owed: {NOTICE_EXEMPTIONS[exemption].reason} This is UPB&apos;s read; counsel confirms it.
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        {plan.transfer ? `Date of transfer ${prettyDate(plan.transfer)}. ` : ""}
        {plan.effective ? `Servicing transfer ${prettyDate(plan.effective)}.${effectiveNote} ` : ""}
        {plan.graceThrough
          ? `Through ${prettyDate(plan.graceThrough)}, a payment the borrower sends on time to the old servicer can't be treated as late, as UPB reads the rule.`
          : "The servicers' letters and the 60-day payment window are dated once the file closes."}
      </p>

      {canEdit && closing.status !== "CANCELED" && (
        <form action={saveBorrowerNotices} className="mt-5 grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="closingId" value={closing.id} />
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Date of transfer</span>
            <input name="transferAt" type="date" defaultValue={day(closing.transferAt)} className="desk-input mt-2" aria-label="Date of transfer" />
            <span className="mt-1 block text-xs text-muted-foreground">Leave blank to use the day the file closes.</span>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Loan purpose</span>
            <select name="loanPurpose" defaultValue={closing.loanPurpose ?? ""} className="desk-input mt-2" aria-label="Loan purpose">
              <option value="">As each loan&apos;s facts suggest</option>
              <option value="CONSUMER">Consumer credit to a person</option>
              <option value="BUSINESS">Business purpose or company borrower</option>
            </select>
          </label>
          <fieldset className="block sm:col-span-2">
            <legend className="text-[13px] text-muted-foreground">
              Has {ownerName} acquired any other mortgage loan, on UPB or anywhere else, in the 12 months before this transfer?
            </legend>
            <div className="mt-2 flex flex-wrap gap-4 text-sm text-foreground">
              <label className="flex items-center gap-2"><input type="radio" name="ownerOtherLoans" value="yes" defaultChecked={answer === "yes"} /> Yes</label>
              <label className="flex items-center gap-2"><input type="radio" name="ownerOtherLoans" value="no" defaultChecked={answer === "no"} /> No</label>
              <label className="flex items-center gap-2"><input type="radio" name="ownerOtherLoans" value="" defaultChecked={answer === ""} /> Not answered yet</label>
            </div>
            <span className="mt-1 block text-xs text-muted-foreground">Buying another within 12 months after it may count too. Counsel confirms.</span>
          </fieldset>
          <label className="block sm:col-span-2">
            <span className="text-[13px] text-muted-foreground">Why no sale notice is owed</span>
            <select name="ownerNoticeExemption" defaultValue={closing.ownerNoticeExemption ?? ""} className="desk-input mt-2" aria-label="Why no sale notice is owed" aria-describedby="notice-exemptions">
              <option value="">A notice is owed</option>
              {(Object.keys(NOTICE_EXEMPTIONS) as NoticeExemption[]).map((key) => (
                <option key={key} value={key}>{NOTICE_EXEMPTIONS[key].label}{suggestion === key ? " (suggested)" : ""}</option>
              ))}
            </select>
            <ul id="notice-exemptions" className="mt-2 space-y-1 text-xs text-muted-foreground">
              {(Object.keys(NOTICE_EXEMPTIONS) as NoticeExemption[]).map((key) => (
                <li key={key}><span className="text-foreground">{NOTICE_EXEMPTIONS[key].label}.</span> {NOTICE_EXEMPTIONS[key].reason}</li>
              ))}
              <li>A loan taken under a repurchase agreement has its own rule. A note sale on UPB is an outright sale, so it isn&apos;t offered here.</li>
              <li>This is UPB&apos;s read of 12 CFR 1026.39. Have counsel confirm before relying on one. An exemption stops the reminders.</li>
            </ul>
            {suggestion && !exemption && (
              <span className="mt-2 block text-xs text-foreground">
                Suggested: {NOTICE_EXEMPTIONS[suggestion].label.toLowerCase()}. The answer above is no, UPB&apos;s record shows no other purchase, and this closing moves one loan in scope.
              </span>
            )}
          </label>
          <label className="block sm:col-span-2">
            <span className="text-[13px] text-muted-foreground">New owner&apos;s contact for the notice</span>
            <textarea name="ownerContact" defaultValue={closing.ownerContact ?? ""} className="desk-input mt-2 min-h-20" placeholder="Mailing address and telephone number" aria-label="New owner's contact" />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-[13px] text-muted-foreground">Where the transfer is recorded</span>
            <input name="recordingNote" defaultValue={closing.recordingNote ?? ""} className="desk-input mt-2" placeholder="County, book and page or instrument number. Blank means not recorded yet." aria-label="Recording details" />
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Partial payments</span>
            <select name="paymentPolicy" defaultValue={closing.paymentPolicy ?? ""} className="desk-input mt-2" aria-label="Partial payment policy">
              <option value="">Not chosen yet</option>
              <option value="APPLY">Accept and apply them</option>
              <option value="HOLD">Hold until the full payment arrives</option>
              <option value="REJECT">Return them</option>
            </select>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Sale notice sent on</span>
            <input name="ownerNoticeSentAt" type="date" defaultValue={day(closing.ownerNoticeSentAt)} className="desk-input mt-2" aria-label="Sale notice sent on" />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-[13px] text-muted-foreground">How it was sent, and the proof</span>
            <input
              name="ownerNoticeProof"
              maxLength={200}
              defaultValue={closing.ownerNoticeProof ?? ""}
              className="desk-input mt-2"
              placeholder="Certified mail 9407 1118 9876 5432 1012 34, or the certificate of mailing reference"
              aria-label="How the sale notice was sent, and the proof"
            />
            <span className="mt-1 block text-xs text-muted-foreground">Needed with the sent date. Keep the receipt or certificate with your records.</span>
          </label>
          {closing.paymentPolicy && <p className="text-xs text-muted-foreground sm:col-span-2">The notice will say: {PAYMENT_POLICIES[closing.paymentPolicy as keyof typeof PAYMENT_POLICIES]}</p>}
          <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
            <SubmitButton className="h-11 text-[13px] font-medium">Save notice details</SubmitButton>
            {inScope.length > 0 && <a className="text-[13px] font-medium text-link" href={`/api/closings/${closing.id}/sale-notice`}>Draft the sale notice (PDF)</a>}
          </div>
        </form>
      )}
    </section>
  );
}
