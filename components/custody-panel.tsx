import { clearCustodyExceptions, issueBailee, saveCustodian, saveCustodianReceipt, saveCustodyExceptions } from "@/actions/custody";
import { SubmitButton } from "@/components/submit-button";
import { Textarea } from "@/components/ui/textarea";
import {
  baileeExplainer,
  baileeNotNeeded,
  buyerWord,
  collateralShipped,
  custodianLabel,
  custodyExceptionOpen,
  custodyFiles,
  noteReceipt,
  purchaseFunded,
  selfHeld,
  SHIPPED_CHANGE,
  type CustodyFields,
} from "@/lib/custody";
import { deskCan, type Staff } from "@/lib/desk-roles";
import { isoDate, prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { viewerSide } from "@/lib/trailing-docs";
import { cn } from "@/lib/utils";

// The collateral file's custody on the closing page: who holds the file for the buyer, the bailee letter it ships
// under while the price is pending, the custodian's receipt, and its exceptions until they clear. lib/custody.ts
// holds the rules and checks every action again.

type PanelClosing = CustodyFields & {
  id: string;
  status: string;
  deskBidId: string | null;
  buyerTotalCents: number;
  fundsReceivedCents: number | null;
  depositCents?: number | null;
  depositReceivedCents?: number | null;
  prorationCents?: number | null;
  proceedsSentAt?: Date | null;
  listing: { sellerId: string };
  funders: { userId: string; status: string }[];
  steps: { key: string; status: string }[];
};

export async function CustodyPanel({ closing, buyerId, viewer }: { closing: PanelClosing; buyerId: string | null; viewer: Staff & { id: string } }) {
  const buyerIds = [buyerId, ...closing.funders.map((funder) => funder.userId)].filter((id): id is string => Boolean(id));
  const side = viewerSide(viewer, { sellerId: closing.listing.sellerId, buyerIds });
  if (!side) return null;
  const live = closing.status !== "CANCELED";
  if (!live && !closing.custodianName && !closing.baileeLetterAt && !closing.custodianReceiptAt && !closing.custodianExceptions) return null;
  const runs = side === "desk" && deskCan(viewer, "closings");
  // The buyer side keeps the custodian, its receipt and its exceptions; the seller or the desk issues the letter.
  const keeper = live && (runs || (side === "buyer" && !closing.deskBidId));
  const issuer = live && (runs || side === "seller");
  const [docs, files] = await Promise.all([
    prisma.trailingDoc.findMany({ where: { closingId: closing.id }, select: { kind: true, status: true, sentAt: true, receivedAt: true } }),
    custodyFiles(closing.id),
  ]);
  const buyer = buyerWord(closing);
  const label = custodianLabel(closing, buyer);
  const own = selfHeld(closing);
  const shipped = collateralShipped({ ...closing, trailingDocs: docs });
  const funded = purchaseFunded(closing, closing.funders);
  const notes = noteReceipt(docs);
  const open = custodyExceptionOpen(closing);
  // After the file ships only the desk changes the custodian, so the buyer's form gives way to a line saying so.
  const canName = keeper && (runs || !label || !shipped);
  const receiptDay = isoDate(closing.custodianReceiptAt) ?? isoDate(notes.suggested) ?? "";
  const summary = open
    ? { text: "Exceptions open", tone: "text-bad" }
    : closing.custodianReceiptAt
      ? { text: `Received ${prettyDate(closing.custodianReceiptAt)}`, tone: "text-good" }
      : label
        ? { text: "Custodian named", tone: "text-muted-foreground" }
        : { text: "No custodian yet", tone: "text-muted-foreground" };
  return (
    <section id="custody" aria-labelledby="custody-heading" className="mt-6 scroll-mt-6 glass p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="custody-heading" className="eyebrow">Collateral custody</h2>
        <p className={cn("text-[13px] font-medium", summary.tone)}>{summary.text}</p>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        {closing.deskBidId
          ? "Who holds the collateral file (the original notes, allonges and assignments) for UPB Capital's own book. The desk names the custodian, the seller ships the file there, and the desk records the custodian's receipt and any exceptions it finds."
          : "Who holds the collateral file (the original notes, allonges and assignments) for the buyer. The buyer names its document custodian, or says it holds the file itself, and the seller ships the file there. The buyer records the custodian's receipt and any exceptions it finds."}
      </p>

      <div className="mt-5">
        <h3 className="text-[13px] font-medium text-foreground">Custodian</h3>
        {label ? (
          <>
            <p className="mt-1 break-words text-sm text-foreground">{label}</p>
            {closing.custodianContact && <p className="mt-0.5 whitespace-pre-line break-words text-sm text-muted-foreground">{closing.custodianContact}</p>}
            {side === "seller" && <p className="mt-1 text-xs text-muted-foreground">Ship the collateral file {own ? (closing.deskBidId ? "to the desk" : "to the buyer") : "here"}.{!funded && !closing.baileeLetterAt ? ` If it goes ${closing.deskBidId ? "before the desk pays you" : "before the buyer's funds are recorded"}, issue the bailee letter below first.` : ""}</p>}
          </>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            {side === "seller" ? `${closing.deskBidId ? "The desk hasn't" : "The buyer hasn't"} named a custodian yet. Hold the collateral file until it does.` : "Not named yet."}
          </p>
        )}
        {keeper && label && shipped && !runs && <p className="mt-1 text-xs text-muted-foreground">{SHIPPED_CHANGE}</p>}
        {canName && (
          <details className="mt-1" open={!label}>
            <summary className="cursor-pointer py-2.5 text-[13px] font-medium text-link">{label ? "Change the custodian" : "Name the custodian"}</summary>
            <form action={saveCustodian} className="mt-3 space-y-3">
              <input type="hidden" name="closingId" value={closing.id} />
              <fieldset className="space-y-2">
                <legend className="text-[13px] text-muted-foreground">Who holds the file</legend>
                <label className="flex min-h-10 items-center gap-2 text-sm text-foreground">
                  <input type="radio" name="holder" value="custodian" defaultChecked={!own} />
                  A document custodian
                </label>
                <label className="flex min-h-10 items-center gap-2 text-sm text-foreground">
                  <input type="radio" name="holder" value="self" defaultChecked={own} />
                  {closing.deskBidId ? "The desk holds the file itself" : side === "desk" ? "The buyer holds the file itself" : "We hold the file ourselves"}
                </label>
              </fieldset>
              <label className="block text-[13px] text-muted-foreground">
                Custodian&apos;s name
                <input name="custodianName" maxLength={120} defaultValue={own ? "" : closing.custodianName ?? ""} className="desk-input mt-1" />
              </label>
              <label className="block text-[13px] text-muted-foreground">
                Address the file ships to, and an email or phone
                <Textarea name="custodianContact" maxLength={300} defaultValue={closing.custodianContact ?? ""} className="mt-1 min-h-20 bg-card" />
              </label>
              <p className="text-xs text-muted-foreground">Holding it yourself, leave the name blank. The seller is told where the file goes. Once it ships, only the desk can change the custodian.</p>
              <SubmitButton className="h-10 w-full text-[13px] font-medium sm:w-auto" pendingLabel="Saving…">Save custodian</SubmitButton>
            </form>
          </details>
        )}
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <h3 className="text-[13px] font-medium text-foreground">Bailee letter</h3>
        {closing.baileeLetterAt ? (
          <p className="mt-1 text-sm text-foreground">
            Issued {prettyDate(closing.baileeLetterAt)}.{" "}
            <a className="text-link" href={`/api/closings/${closing.id}/bailee-letter`}>Download the letter (PDF)</a>
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">{funded ? baileeNotNeeded(closing) : baileeExplainer(closing)}</p>
        )}
        {issuer && !funded && (
          label ? (
            <form action={issueBailee} className="mt-3">
              <input type="hidden" name="closingId" value={closing.id} />
              <SubmitButton variant={closing.baileeLetterAt ? "outline" : "default"} className="h-10 w-full text-[13px] font-medium sm:w-auto" pendingLabel="Issuing…">
                {closing.baileeLetterAt ? "Issue a new letter" : "Issue the bailee letter"}
              </SubmitButton>
              <p className="mt-2 text-xs text-muted-foreground">Addressed to {label}, listing each paper loan by city, state and loan number. The buyer side is told.</p>
            </form>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">The letter is addressed to the custodian, so it waits until one is named.</p>
          )
        )}
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <h3 className="text-[13px] font-medium text-foreground">Custodian&apos;s receipt</h3>
        <p className="mt-1 text-sm text-foreground">{closing.custodianReceiptAt ? `Received ${prettyDate(closing.custodianReceiptAt)}` : <span className="text-muted-foreground">Not recorded yet.</span>}</p>
        {files.length > 0 && (
          <ul className="mt-1 space-y-1">
            {files.map((file) => (
              <li key={file.id} className="min-w-0">
                <a className="break-all text-sm text-link" href={`/api/closing-files/${file.id}`}>{file.originalName}</a>
              </li>
            ))}
          </ul>
        )}
        {/* The trailing list's original-note item and this receipt record one delivery, so a note received there
            fills the date here. lib/custody.ts noteReceipt. */}
        {keeper && closing.custodianReceiptAt && notes.notes > 0 && notes.received < notes.notes && (
          <p className="mt-1 text-xs text-muted-foreground">The trailing list shows {notes.received} of {notes.notes} original note{notes.notes === 1 ? "" : "s"} received. Confirm each there as well, so the two records agree.</p>
        )}
        {keeper && label && (
          <details className="mt-1" open={!closing.custodianReceiptAt && Boolean(notes.suggested)}>
            <summary className="cursor-pointer py-2.5 text-[13px] font-medium text-link">{closing.custodianReceiptAt ? "Correct the receipt" : "Record the receipt"}</summary>
            <form action={saveCustodianReceipt} className="mt-3 space-y-3">
              <input type="hidden" name="closingId" value={closing.id} />
              <label className="block text-[13px] text-muted-foreground">
                Date the custodian received the file
                <input name="receivedAt" type="date" required defaultValue={receiptDay} className="desk-input mt-1" />
              </label>
              {!closing.custodianReceiptAt && notes.suggested && (
                <p className="text-xs text-muted-foreground">Filled from the trailing list, which shows the original note received {prettyDate(notes.suggested)}. Change it if the custodian&apos;s receipt gives another day.</p>
              )}
              <label className="block text-[13px] text-muted-foreground">
                The receipt or trust receipt (optional)
                <input name="file" type="file" className="mt-1 block w-full text-xs text-muted-foreground" />
              </label>
              <SubmitButton className="h-10 w-full text-[13px] font-medium sm:w-auto" pendingLabel="Saving…">Save receipt</SubmitButton>
            </form>
          </details>
        )}
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <h3 className="text-[13px] font-medium text-foreground">Exceptions</h3>
        {open ? (
          <div role="status" className="mt-2 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2">
            <p className="text-[13px] font-medium text-foreground">Open: what the custodian found missing or defective</p>
            <p className="mt-1 whitespace-pre-line break-words text-sm text-foreground">{closing.custodianExceptions}</p>
            <p className="mt-1 text-xs text-muted-foreground">The seller cures them with the custodian. The post-closing file stays open until they clear.</p>
          </div>
        ) : closing.custodianExceptions?.trim() ? (
          <div className="mt-1">
            <p className="text-sm text-foreground">Cleared {prettyDate(closing.exceptionsClearedAt)}</p>
            <p className="mt-0.5 whitespace-pre-line break-words text-xs text-muted-foreground">{closing.custodianExceptions}</p>
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">{closing.custodianReceiptAt ? "None recorded." : "The custodian lists any on its review, after it receives the file."}</p>
        )}
        {keeper && closing.custodianReceiptAt && (
          <>
            <details className="mt-1">
              <summary className="cursor-pointer py-2.5 text-[13px] font-medium text-link">{open ? "Change the exceptions" : "Record exceptions"}</summary>
              <form action={saveCustodyExceptions} className="mt-3 space-y-3">
                <input type="hidden" name="closingId" value={closing.id} />
                <label className="block text-[13px] text-muted-foreground">
                  Each missing or defective document, one to a line
                  <Textarea name="exceptions" required minLength={5} maxLength={2000} defaultValue={open ? closing.custodianExceptions ?? "" : ""} className="mt-1 min-h-24 bg-card" />
                </label>
                <p className="text-xs text-muted-foreground">The seller and the desk are told, and the post-closing file stays open until they clear.</p>
                <SubmitButton className="h-10 w-full text-[13px] font-medium sm:w-auto" pendingLabel="Saving…">Save exceptions</SubmitButton>
              </form>
            </details>
            {open && (
              <form action={clearCustodyExceptions} className="mt-3 space-y-2">
                <input type="hidden" name="closingId" value={closing.id} />
                <label className="block text-[13px] text-muted-foreground">
                  Date the custodian cleared them
                  <input name="clearedAt" type="date" required defaultValue={isoDate(new Date()) ?? ""} className="desk-input mt-1" />
                </label>
                <SubmitButton variant="outline" className="h-10 w-full text-[13px] font-medium sm:w-auto" pendingLabel="Saving…">Mark cleared</SubmitButton>
              </form>
            )}
          </>
        )}
      </div>
    </section>
  );
}
