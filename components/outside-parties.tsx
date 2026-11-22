import { addGuestPass, endGuestPass } from "@/actions/guest-access";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { prettyDate } from "@/lib/format";
import { DEFAULT_GUEST_DAYS, GUEST_DAYS, GUEST_ROLES, GUEST_ROLE_LABELS, LIVE_PASS_LIMIT, outsideParties, type OutsideRow } from "@/lib/guest-access";
import type { ActingUser } from "@/lib/seats";
import { cn } from "@/lib/utils";

// Outside parties on a closing or a room: the guest links each side gave its attorney, title officer, custodian or
// auditor. A side's own links show in full, with the control to end them; the other side's show by name and role.
// lib/guest-access.ts decides who sees what and who may add or end a link.

function statusLine(row: OutsideRow) {
  const added = `Added ${prettyDate(row.createdAt)}`;
  if (row.state === "revoked") return `${added} · ended ${prettyDate(row.endedAt)}`;
  if (row.state === "expired") return `${added} · expired ${prettyDate(row.endedAt)}`;
  if (!row.own) return added;
  return `${added} · expires ${prettyDate(row.expiresAt)} · ${row.lastUsedAt ? `last used ${prettyDate(row.lastUsedAt)}` : "not opened yet"}`;
}

export async function OutsideParties({ viewer, closingId, listingId, from }: { viewer: ActingUser; closingId?: string; listingId: string; from: "closing" | "seller" | "buyer" | "broker" }) {
  const data = await outsideParties(viewer, closingId ? { closingId, listingId } : { listingId });
  if (!data) return null;
  const { rows, forms, block } = data;
  const reads = from === "closing" ? "this closing's steps, documents, trailing documents and deal log" : "the room's files";
  return (
    <section
      id="outside-parties"
      aria-labelledby="outside-parties-heading"
      className={cn("scroll-mt-6", from === "closing" ? "mt-6 glass p-6" : "mt-10 border border-border p-5 rounded-xl")}
    >
      <h2 id="outside-parties-heading" className="eyebrow">Outside parties</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        A link for an attorney, title officer, document custodian or auditor to read {reads}, without a UPB account. It opens what your side sees and nothing more: no bids, no wire instructions, no other party&apos;s identity records. Each file they take carries their name and is logged. The other side sees who you added by name and role, never the email.
      </p>
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No outside parties yet.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {rows.map((row) => (
            <li key={row.id} className={cn("border border-border p-4 rounded-xl", row.state !== "live" && "opacity-70")}>
              <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-medium text-foreground">{row.name}</p>
                  <p className="text-[13px] text-muted-foreground">
                    {row.title}
                    {from === "closing" && row.scope === "room" ? " · the data room" : ""}
                    {row.state !== "live" ? " · ended" : ""}
                  </p>
                  {row.email && <p className="break-all text-xs text-muted-foreground">{row.email}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">{statusLine(row)}</p>
                </div>
                {row.canRevoke && (
                  <form action={endGuestPass}>
                    <input type="hidden" name="passId" value={row.id} />
                    <input type="hidden" name="from" value={from} />
                    {closingId && <input type="hidden" name="closingId" value={closingId} />}
                    <input type="hidden" name="listingId" value={listingId} />
                    <SubmitButton variant="outline" pendingLabel="Ending…" className="h-10 px-3 text-[13px] font-medium">End access</SubmitButton>
                  </form>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {(forms.closing || forms.room) && (
        <form action={addGuestPass} className="mt-5 space-y-3 border-t border-border pt-4">
          <input type="hidden" name="from" value={from} />
          {closingId && <input type="hidden" name="closingId" value={closingId} />}
          <input type="hidden" name="listingId" value={listingId} />
          {/* On the closing page a side that may only open the room for a guest gets that form alone. */}
          {from === "closing" && !forms.closing && <input type="hidden" name="reads" value="room" />}
          <p className="text-[13px] font-semibold text-foreground">Add an outside party</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block min-w-0">
              <span className="text-[13px] text-muted-foreground">Name</span>
              <input name="name" required minLength={2} maxLength={120} autoComplete="off" className="desk-input mt-1" />
            </label>
            <label className="block min-w-0">
              <span className="text-[13px] text-muted-foreground">Email</span>
              <input name="email" type="email" required maxLength={200} autoComplete="off" className="desk-input mt-1" />
            </label>
            <label className="block min-w-0">
              <span className="text-[13px] text-muted-foreground">Role</span>
              <select name="role" defaultValue="ATTORNEY" className="desk-input mt-1">
                {GUEST_ROLES.map((role) => <option key={role} value={role}>{GUEST_ROLE_LABELS[role]}</option>)}
              </select>
            </label>
            <label className="block min-w-0">
              <span className="text-[13px] text-muted-foreground">The link lasts</span>
              <select name="days" defaultValue={String(DEFAULT_GUEST_DAYS)} className="desk-input mt-1">
                {GUEST_DAYS.map((days) => <option key={days} value={days}>{days} days</option>)}
              </select>
            </label>
            {from === "closing" && forms.closing && forms.room && (
              <label className="block min-w-0 sm:col-span-2">
                <span className="text-[13px] text-muted-foreground">They read</span>
                <select name="reads" defaultValue="closing" className="desk-input mt-1">
                  <option value="closing">This closing</option>
                  <option value="room">The listing&apos;s data room</option>
                </select>
              </label>
            )}
          </div>
          <p className="text-xs text-muted-foreground">The link goes to this email and works without signing in. Your side can hold {LIVE_PASS_LIMIT} live links here, and you can end any of them at any time.</p>
          <ConfirmSubmit
            title="Send this guest link?"
            consequence="The guest can read what your side sees here until the link expires or your side or the desk ends it. The other side sees their name and role."
            typed={[["Guest", "name", "text"], ["Email", "email", "text"]]}
            confirmLabel="Send the link"
            pendingLabel="Sending…"
            className="h-10 w-full text-[13px] font-medium sm:w-auto"
          >
            Send the link
          </ConfirmSubmit>
        </form>
      )}
      {block && <p className="mt-4 text-sm text-muted-foreground">{block}</p>}
    </section>
  );
}
