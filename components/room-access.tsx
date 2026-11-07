import { answerRoomRequest, saveRoomApproval } from "@/actions/room-access";
import { SubmitButton } from "@/components/submit-button";
import type { Engagement } from "@/lib/access-log";
import { prettyDate } from "@/lib/format";

type RoomRequest = {
  id: string;
  userId: string;
  status: "PENDING" | "DECLINED";
  signedAt: Date;
  decidedAt: Date | null;
  entityName: string;
  entityType: string;
  verified: boolean;
  // The bidder's letter for a seller or broker, the name for the desk.
  bidder: string;
};

// The seller's hold on the room: approve each bidder after their NDA, see who took what under the same bidder
// letters as the bids, and take the full log as a spreadsheet.
export function RoomAccessPanel({
  listingId,
  from,
  roomApproval,
  editable,
  requests,
  engagement,
  readOnly = false,
}: {
  listingId: string;
  from: "seller" | "broker" | "admin" | "resale";
  roomApproval: boolean;
  // Approval can be set while the listing is filed or live.
  editable: boolean;
  requests: RoomRequest[];
  engagement: Engagement[];
  // A desk role that doesn't run sales reads the requests and answers none.
  readOnly?: boolean;
}) {
  const waiting = requests.filter((request) => request.status === "PENDING");
  const declined = requests.filter((request) => request.status === "DECLINED");
  return (
    <section id="room-access" aria-labelledby="room-access-heading" className="mt-10 scroll-mt-6 border border-border p-5 rounded-xl">
      <p id="room-access-heading" className="eyebrow">Data room access</p>
      <p className="mt-2 text-sm text-muted-foreground">
        {roomApproval
          ? `${from === "admin" ? "The seller approves" : "You approve"} each bidder. A signed NDA waits for an answer before the street, the borrower and the files open.`
          : "The room opens to a verified buyer once they sign the NDA."}
      </p>
      {editable && (
        <form action={saveRoomApproval} className="mt-3 flex flex-wrap items-center gap-3">
          <input type="hidden" name="listingId" value={listingId} />
          <input type="hidden" name="from" value={from} />
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input type="checkbox" name="roomApproval" defaultChecked={roomApproval} />
            Approve each bidder before the room opens
          </label>
          <SubmitButton variant="outline" pendingLabel="Saving…" className="h-9 px-3 text-[13px] font-medium">Save</SubmitButton>
          <p className="w-full text-xs text-muted-foreground">Bidders who already signed keep their access. Turning this off lets in anyone still waiting.</p>
        </form>
      )}
      {waiting.length > 0 && (
        <div className="mt-4">
          <p className="text-[13px] font-semibold text-foreground">Waiting for your answer</p>
          <ul className="mt-2 space-y-2">
            {waiting.map((request) => (
              <li key={request.id} className="border border-link/30 bg-link/5 p-4 rounded-xl">
                <RequestLine request={request} />
                {!readOnly && <form action={answerRoomRequest} className="mt-3 flex flex-wrap gap-2">
                  <input type="hidden" name="ndaId" value={request.id} />
                  <input type="hidden" name="from" value={from} />
                  <SubmitButton name="decision" value="APPROVED" pendingLabel="Saving…" className="h-9 px-3 text-[13px] font-medium">Approve access</SubmitButton>
                  <SubmitButton name="decision" value="DECLINED" variant="outline" pendingLabel="Saving…" className="h-9 px-3 text-[13px] font-medium">Decline</SubmitButton>
                </form>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {declined.length > 0 && (
        <div className="mt-4">
          <p className="text-[13px] font-semibold text-foreground">Declined</p>
          <ul className="mt-2 divide-y divide-border border-y border-border">
            {declined.map((request) => (
              <li key={request.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <RequestLine request={request} />
                  <p className="text-xs text-muted-foreground">Declined {prettyDate(request.decidedAt)}</p>
                </div>
                {!readOnly && (
                  <form action={answerRoomRequest}>
                    <input type="hidden" name="ndaId" value={request.id} />
                    <input type="hidden" name="from" value={from} />
                    <SubmitButton name="decision" value="APPROVED" variant="ghost" pendingLabel="Saving…" className="h-9 px-3 text-[13px] font-medium text-link">Approve after all</SubmitButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="text-[13px] font-semibold text-foreground">Bidder engagement</p>
          <a href={`/api/listings/${listingId}/access-log`} className="text-[13px] font-medium text-link">Download the access log</a>
        </div>
        {engagement.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No bidder has signed the NDA or taken a file yet.</p>
        ) : (
          <div className="mt-2 relative overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs font-medium text-muted-foreground">
                <tr>{["Bidder", "NDA", "Access", "Files taken", "Last activity", "Files destroyed"].map((heading) => <th key={heading} className="px-2 py-2 font-normal">{heading}</th>)}</tr>
              </thead>
              <tbody>
                {engagement.map((row) => (
                  <tr key={row.userId} className="border-t border-border">
                    <td className="px-2 py-2 text-foreground">{row.bidder}</td>
                    <td className="px-2 py-2 text-muted-foreground">{row.ndaSignedAt ? prettyDate(row.ndaSignedAt) : "—"}</td>
                    <td className="px-2 py-2 text-muted-foreground">{row.access}</td>
                    <td className="px-2 py-2 tabular-nums text-muted-foreground">{row.files}{row.downloads > row.files ? ` (${row.downloads} downloads)` : ""}</td>
                    <td className="px-2 py-2 text-muted-foreground">{prettyDate(row.lastActivity)}</td>
                    <td className="px-2 py-2 text-muted-foreground">{row.destroyedAt ? `Certified ${prettyDate(row.destroyedAt)}` : row.destruction || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">Bidders show by letter until a bid is awarded. Each buyer&apos;s copy of a PDF carries their name on every page.</p>
      </div>
    </section>
  );
}

function RequestLine({ request }: { request: RoomRequest }) {
  return (
    <>
      <p className="text-sm text-foreground">
        {request.bidder} · {request.entityName || "No entity on file"}{request.entityType ? ` · ${request.entityType}` : ""}
      </p>
      <p className="text-xs text-muted-foreground">
        {request.verified ? "Buyer file verified by the desk" : "Buyer file not yet verified"} · signed the NDA {prettyDate(request.signedAt)}
      </p>
    </>
  );
}
