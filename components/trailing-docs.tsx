import { buildTrailingList, confirmTrailingReceived, nameTransferee, recordTrailingSent, saveTrailingDocDays, waiveTrailing } from "@/actions/trailing-docs";
import { SubmitButton } from "@/components/submit-button";
import { deskCan, type Staff } from "@/lib/desk-roles";
import { transferNeeds, transfereeOf, type ENoteTransfer } from "@/lib/enotes";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import {
  CARRIERS,
  DEFAULT_ASSIGNMENT_DAYS,
  KIND_HINTS,
  assignmentDays,
  carrierLabel,
  daysLate,
  isOverdue,
  kindLabel,
  loanName,
  trackingUrl,
  trailingActions,
  trailingStatusLabel,
  viewerSide,
  type Side,
  type TrailingKind,
} from "@/lib/trailing-docs";
import { cn } from "@/lib/utils";
import { fundingParty } from "@/lib/vesting";

// The trailing documents on a closed closing's page: what is still to arrive, who owes it and by when, and the forms
// each side uses for its own part. lib/trailing-docs.ts holds the rules and checks every action again.

type PanelClosing = {
  id: string;
  status: string;
  deskBidId: string | null;
  buyerEntityId?: string | null;
  postCloseCompleteAt?: Date | null;
  listing: { sellerId: string; notes: { id: string; streetAddress: string; city: string; state: string }[] };
  funders: { userId: string }[];
};

type Doc = Awaited<ReturnType<typeof prisma.trailingDoc.findMany>>[number];

const TONE: Record<string, string> = { DUE: "bg-muted text-muted-foreground", SENT: "bg-link/10 text-link", RECEIVED: "bg-good/10 text-good", WAIVED: "bg-muted text-muted-foreground" };

function fromWord(doc: { kind: string; owner: string }) {
  if (doc.owner === "SERVICER") return doc.kind === "SERVICER_BOARDED" ? "The buyer's servicer" : "The seller's servicer";
  return doc.owner === "SELLER" ? "The seller" : doc.owner === "BUYER" ? "The buyer" : "The desk";
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export async function TrailingDocsPanel({ closing, buyerId, viewer }: { closing: PanelClosing; buyerId: string | null; viewer: Staff & { id: string } }) {
  if (closing.status !== "COMPLETE") return null;
  const buyerIds = [buyerId, ...closing.funders.map((funder) => funder.userId)].filter((id): id is string => Boolean(id));
  const side = viewerSide(viewer, { sellerId: closing.listing.sellerId, buyerIds });
  if (!side) return null;
  const runs = side === "desk" && deskCan(viewer, "closings");
  const docs = await prisma.trailingDoc.findMany({ where: { closingId: closing.id }, orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }] });
  if (!docs.length) {
    if (!runs) return null;
    return (
      <section id="trailing" aria-labelledby="trailing-heading" className="mt-6 scroll-mt-6 glass p-6">
        <h2 id="trailing-heading" className="eyebrow">Trailing documents</h2>
        <p className="mt-2 text-sm text-muted-foreground">This closing has no list of what arrives after the close yet. The nightly job builds it, with a week before anything is due, or build it now.</p>
        <form action={buildTrailingList} className="mt-4">
          <input type="hidden" name="closingId" value={closing.id} />
          <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Building…">Build the list</SubmitButton>
        </form>
      </section>
    );
  }
  const now = new Date();
  const fileIds = docs.map((doc) => doc.documentId).filter((id): id is string => Boolean(id));
  const [files, funding] = await Promise.all([
    fileIds.length ? prisma.closingFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, originalName: true } }) : Promise.resolve([]),
    docs.some((doc) => doc.kind === "ENOTE_CONTROL" || doc.kind === "ENOTE_LOCATION") ? fundingParty(closing) : Promise.resolve(null),
  ]);
  const fileName = new Map(files.map((file) => [file.id, file.originalName]));
  const finished = docs.filter((doc) => doc.status === "RECEIVED" || doc.status === "WAIVED").length;
  const late = docs.filter((doc) => isOverdue(doc, now)).length;
  const groups = [
    { key: "closing", title: "The closing", docs: docs.filter((doc) => !doc.noteId) },
    ...closing.listing.notes
      .map((note) => ({ key: note.id, title: loanName(closing.listing.notes, note.id) ?? "A loan", docs: docs.filter((doc) => doc.noteId === note.id) }))
      .filter((group) => group.docs.length > 0),
  ];
  const context = { closingId: closing.id, side, runs, now, fileName, custodian: funding?.custodian ?? null, docs };
  return (
    <section id="trailing" aria-labelledby="trailing-heading" className="mt-6 scroll-mt-6 glass p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="trailing-heading" className="eyebrow">Trailing documents</h2>
        <p className={cn("text-[13px] font-medium tabular-nums", late ? "text-bad" : closing.postCloseCompleteAt ? "text-good" : "text-muted-foreground")}>
          {finished} of {docs.length} in{late ? ` · ${plural(late, "item")} late` : ""}
        </p>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        What arrives after the close. Whoever owes an item records it here with its tracking, recording or transfer ID, and the other side confirms receipt. Reminders go out three days before each is due.
      </p>
      {closing.postCloseCompleteAt && <p className="mt-3 text-sm text-foreground">The post-closing file is complete as of {prettyDate(closing.postCloseCompleteAt)}.</p>}
      {groups.map((group) => (
        <div key={group.key} className="mt-5">
          {groups.length > 1 && <h3 className="text-[13px] font-medium text-foreground">{group.title}</h3>}
          <ul className="mt-1 divide-y divide-border">
            {group.docs.map((doc) => <Row key={doc.id} doc={doc} {...context} />)}
          </ul>
        </div>
      ))}
    </section>
  );
}

type RowProps = { doc: Doc; docs: Doc[]; closingId: string; side: Side; runs: boolean; now: Date; fileName: Map<string, string>; custodian: string | null };

function Row({ doc, docs, closingId, side, runs, now, fileName, custodian }: RowProps) {
  const can = trailingActions(doc, side, runs);
  const overdue = isOverdue(doc, now);
  const tracked = trackingUrl(doc.carrier, doc.trackingNumber);
  const transfer = doc.kind === "ENOTE_CONTROL" || doc.kind === "ENOTE_LOCATION";
  const orgId = transfer ? transfereeOf(doc.note) : null;
  const file = doc.documentId ? fileName.get(doc.documentId) : null;
  const status = doc.status === "DUE" && overdue ? `${plural(daysLate(doc.dueAt, now), "day")} late` : trailingStatusLabel(doc.status);
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{kindLabel(doc.kind)}</p>
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", overdue ? "bg-bad/10 text-bad" : TONE[doc.status])}>{status}</span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {fromWord(doc)} · due {prettyDate(doc.dueAt)}
        {doc.sentAt ? ` · sent ${prettyDate(doc.sentAt)}` : ""}
        {doc.receivedAt ? ` · received ${prettyDate(doc.receivedAt)}` : ""}
      </p>
      {doc.status === "DUE" && <p className="mt-0.5 text-xs text-muted-foreground">{KIND_HINTS[doc.kind as TrailingKind]}</p>}
      {(doc.trackingNumber || doc.reference || file) && (
        <p className="mt-1 text-xs text-foreground">
          {doc.trackingNumber && (
            <>
              {carrierLabel(doc.carrier)} tracking{" "}
              {tracked ? <a className="text-link" href={tracked} target="_blank" rel="noopener noreferrer">{doc.trackingNumber}</a> : doc.trackingNumber}
            </>
          )}
          {doc.trackingNumber && doc.reference ? " · " : ""}
          {doc.reference}
          {file && <> {doc.trackingNumber || doc.reference ? "· " : ""}<a className="text-link" href={`/api/closing-files/${doc.documentId}`}>{file}</a></>}
        </p>
      )}
      {doc.status === "WAIVED" && doc.waivedReason && <p className="mt-1 text-xs text-muted-foreground">Waived by the desk: {doc.waivedReason}</p>}
      {transfer && doc.status === "DUE" && (
        <p className="mt-1 text-xs text-foreground">
          {orgId ? `Transfer to MERS Org ID ${orgId}.` : side === "seller" ? "Waiting for the buyer's MERS Org ID." : transferNeeds(doc.kind as ENoteTransfer, custodian)}
        </p>
      )}
      {can.confirm && (
        <form action={confirmTrailingReceived} className="mt-2">
          <Hidden closingId={closingId} docId={doc.id} />
          <SubmitButton variant={doc.status === "SENT" ? "default" : "outline"} className="h-9 text-[13px] font-medium" pendingLabel="Saving…">Confirm received</SubmitButton>
        </form>
      )}
      {can.transferee && !orgId && (
        <form action={nameTransferee} className="mt-2 flex flex-wrap items-center gap-2">
          <Hidden closingId={closingId} docId={doc.id} />
          <input name="orgId" inputMode="numeric" required maxLength={12} placeholder="7-digit MERS Org ID" aria-label={`MERS Org ID for the ${kindLabel(doc.kind).toLowerCase()}`} className="desk-input h-9 w-full tabular-nums sm:w-48" />
          <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">Send to the seller</SubmitButton>
        </form>
      )}
      {can.send && <SendForm doc={doc} docs={docs} closingId={closingId} />}
      {can.waive && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[13px] font-medium text-link">Waive</summary>
          <form action={waiveTrailing} className="mt-2 flex flex-wrap items-center gap-2">
            <Hidden closingId={closingId} docId={doc.id} />
            <input name="reason" required minLength={5} maxLength={300} placeholder="Why it isn't needed" aria-label={`Reason to waive the ${kindLabel(doc.kind).toLowerCase()}`} className="desk-input h-9 w-full sm:w-72" />
            <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">Waive</SubmitButton>
          </form>
        </details>
      )}
    </li>
  );
}

function Hidden({ closingId, docId }: { closingId: string; docId: string }) {
  return (
    <>
      <input type="hidden" name="closingId" value={closingId} />
      <input type="hidden" name="docId" value={docId} />
    </>
  );
}

// The fields each kind records: a courier's tracking for paper, the recording for an assignment, the transfer ID for
// an eNote, and for the rest a reference, a tracking number or a file.
function SendForm({ doc, docs, closingId }: { doc: Doc; docs: Doc[]; closingId: string }) {
  const courier = doc.kind === "ORIGINAL_NOTE" || doc.kind === "ALLONGE";
  const transfer = doc.kind === "ENOTE_CONTROL" || doc.kind === "ENOTE_LOCATION";
  const allonge = doc.kind === "ORIGINAL_NOTE" && docs.some((row) => row.kind === "ALLONGE" && row.noteId === doc.noteId && row.status === "DUE");
  const label = kindLabel(doc.kind).toLowerCase();
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-[13px] font-medium text-link">{doc.status === "SENT" ? "Change what was sent" : "Record as sent"}</summary>
      <form action={recordTrailingSent} className="mt-2 space-y-2">
        <Hidden closingId={closingId} docId={doc.id} />
        {doc.kind === "RECORDED_ASSIGNMENT" ? (
          <div className="flex flex-wrap gap-2">
            <input name="instrument" placeholder="Instrument number" aria-label="Recording instrument number" className="desk-input h-9 w-full sm:w-48" />
            <span className="self-center text-xs text-muted-foreground">or</span>
            <input name="book" placeholder="Book" aria-label="Recording book" className="desk-input h-9 w-24" />
            <input name="page" placeholder="Page" aria-label="Recording page" className="desk-input h-9 w-24" />
          </div>
        ) : transfer ? (
          <input name="transferId" required placeholder="eRegistry transfer ID" aria-label={`eRegistry transfer ID for the ${label}`} className="desk-input h-9 w-full sm:w-64" />
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <select name="carrier" required={courier} defaultValue="" aria-label={`Carrier for the ${label}`} className="desk-input h-9 w-36">
                <option value="">{courier ? "Carrier" : "No carrier"}</option>
                {CARRIERS.map((carrier) => <option key={carrier.value} value={carrier.value}>{carrier.label}</option>)}
              </select>
              <input name="trackingNumber" required={courier} placeholder="Tracking number" aria-label={`Tracking number for the ${label}`} className="desk-input h-9 w-full sm:w-56" />
            </div>
            {!courier && <input name="reference" maxLength={200} placeholder="Reference, such as the date mailed or the policy number" aria-label={`Reference for the ${label}`} className="desk-input h-9" />}
          </>
        )}
        {allonge && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" name="withAllonge" defaultChecked />
            The allonge went with it, fixed to the note
          </label>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <input name="file" type="file" aria-label={`A copy of the ${label}, optional`} className="text-xs text-muted-foreground" />
          <SubmitButton className="h-9 text-[13px] font-medium" pendingLabel="Saving…">Record as sent</SubmitButton>
        </div>
      </form>
    </details>
  );
}

// On the fee schedule page: when the recorded assignment is due. Only an owner changes it.
export function TrailingDocSettings({ owns, days }: { owns: boolean; days: number | null | undefined }) {
  return (
    <form id="trailing-docs" action={saveTrailingDocDays} className="mt-8 scroll-mt-6 space-y-5 glass p-6" aria-labelledby="trailing-docs-heading">
      <div>
        <p id="trailing-docs-heading" className="eyebrow">Trailing documents</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          After a close the seller owes the recorded assignment, which waits on the county. The original note and allonge are due in 10 days, an eNote&apos;s eRegistry transfers in 2 business days, and the borrower letters on their own clocks.
        </p>
        <p className="mt-2 text-sm text-foreground">Now: the recorded assignment is due {assignmentDays(days)} days after closing.</p>
      </div>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Days after closing for the recorded assignment</span>
        {/* With no save button for other roles, a lone text field would still submit on Enter, so it reads only. */}
        <input name="trailingDocDays" inputMode="numeric" disabled={!owns} defaultValue={days ?? ""} placeholder={`${DEFAULT_ASSIGNMENT_DAYS}, the default`} className="desk-input mt-2 tabular-nums" />
        <span className="mt-1 block text-xs text-muted-foreground">From 10 to 365. Applies to closings that close from now on. Blank keeps the default.</span>
      </label>
      {owns ? <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Saving…">Save trailing documents</SubmitButton> : <p className="text-sm text-muted-foreground">Only an owner changes this.</p>}
    </form>
  );
}
