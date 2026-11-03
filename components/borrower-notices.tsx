import { saveBorrowerNotices } from "@/actions/notices";
import { SubmitButton } from "@/components/submit-button";
import { borrowerNotices, calendarDay, loanScope, loansInScope, PAYMENT_POLICIES, type NoticeState } from "@/lib/borrower-notices";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";

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
  };
  boarding: { boardedAt: Date | null; goodbyeSentAt: Date | null; helloSentAt: Date | null } | null;
  notes: Note[];
  canEdit: boolean;
  owner: { kind: "desk" | "group" | "buyer"; buyerId: string | null; label: string };
};

// Loans the buyer closed on UPB in the last year. Purchases elsewhere count toward the rule too, so this is a floor.
async function loansBought(buyerId: string, now: Date) {
  const won = await prisma.inquiry.findMany({ where: { buyerId, status: "ACCEPTED" }, select: { id: true } });
  if (!won.length) return 0;
  const closings = await prisma.closing.findMany({
    where: { inquiryId: { in: won.map((row) => row.id) }, status: "COMPLETE", closedAt: { gte: new Date(now.getTime() - 365 * DAY) } },
    select: { noteId: true, listing: { select: { _count: { select: { notes: true } } } } },
  });
  return closings.reduce((sum, closing) => sum + (closing.noteId ? 1 : closing.listing._count.notes), 0);
}

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
  const bought = owner.kind === "buyer" && owner.buyerId ? await loansBought(owner.buyerId, now) : null;
  const rows = [
    {
      label: "Sale notice to the borrower",
      rule: "New owner · 12 CFR 1026.39",
      due: plan.sale.due,
      ...chip(plan.sale.state, plan.sale.due, closing.ownerNoticeSentAt, "Starts when the file closes", now),
    },
    {
      label: "Old servicer's transfer letter",
      rule: "15 days before the servicing transfer · 12 CFR 1024.33",
      due: plan.goodbye.due,
      ...chip(plan.goodbye.state, plan.goodbye.due, boarding?.goodbyeSentAt, "Set the servicing transfer date", now),
    },
    {
      label: "New servicer's welcome letter",
      rule: "Within 15 days after the servicing transfer · 12 CFR 1024.33",
      due: plan.hello.due,
      ...chip(plan.hello.state, plan.hello.due, boarding?.helloSentAt, "Set the servicing transfer date", now),
    },
  ];
  const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : "");

  return (
    <section className="mt-6 glass p-6" aria-labelledby="notices-heading">
      <p id="notices-heading" className="eyebrow">Borrower notices</p>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        When a loan changes hands, the borrower is owed notices. UPB never contacts borrowers. These dates are for the new owner and the servicers, who send them. This is UPB&apos;s read of the rules, not legal advice.
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
        {owner.kind === "desk" && "UPB Capital is the new owner on a desk purchase, so the desk sends this notice."}
        {owner.kind === "group" && "The co-buyers send one joint notice, due from the earliest closing date."}
        {owner.kind === "buyer" && `The notice is owed by an owner that acquires more than one mortgage loan in 12 months. ${owner.label} closed ${bought} loan${bought === 1 ? "" : "s"} on UPB in the last year. Purchases elsewhere count too.`}
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
      <p className="mt-3 text-xs text-muted-foreground">
        {plan.transfer ? `Date of transfer ${prettyDate(plan.transfer)}. ` : ""}
        {plan.graceThrough
          ? `A payment sent on time to the old servicer can't be treated as late through ${prettyDate(plan.graceThrough)}.`
          : "Add the new servicer and its transfer date under Servicer boarding to date the servicers' letters."}
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
