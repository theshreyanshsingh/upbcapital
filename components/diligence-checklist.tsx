import { CircleCheck, CircleAlert, CircleMinus } from "lucide-react";
import { clearDiligenceItemWaiver, waiveDiligenceItem } from "@/actions/diligence";
import { SubmitButton } from "@/components/submit-button";
import { buyerDiligence, diligenceGateMessage, loadDiligence, waiverKey, type DiligenceLine } from "@/lib/diligence-checklist";
import { deskIntakeHold } from "@/lib/desk-intake";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { deskCan, type Staff } from "@/lib/staff";

// The diligence set on the desk's listing page, the seller's, and the buyer's. Each loads what it shows, so a
// shared page needs one line for it. lib/diligence-checklist.ts decides what is on file.

const SHOWN = 8;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function stateText(line: DiligenceLine, pool: boolean) {
  if (line.state === "not_required") return "Not asked for these loans";
  if (line.scope === "listing" || !pool) {
    return line.state === "complete" ? "On file" : line.state === "waived" ? "Waived" : "Missing";
  }
  const parts = [`On file for ${line.onFile} of ${line.required}`];
  if (line.waived.length) parts.push(`waived on ${plural(line.waived.length, "loan")}`);
  if (line.missing.length) parts.push(`missing on ${plural(line.missing.length, "loan")}`);
  return parts.join(" · ");
}

function StateIcon({ state }: { state: DiligenceLine["state"] }) {
  if (state === "complete") return <CircleCheck className="mt-0.5 size-4 shrink-0 text-good" aria-hidden />;
  if (state === "missing") return <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />;
  return <CircleMinus className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />;
}

function Gaps({ line, pool }: { line: DiligenceLine; pool: boolean }) {
  if (!pool || line.scope === "listing" || !line.missing.length) return null;
  const more = line.missing.length - SHOWN;
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      Missing: {line.missing.slice(0, SHOWN).map((gap) => gap.label).join("; ")}
      {more > 0 ? `; and ${more} more` : ""}
    </p>
  );
}

// On the desk's listing page: the set, the seller's confirmation of a desk-filed tape, and compliance's waivers.
export async function DeskDiligence({ listingId, viewer }: { listingId: string; viewer: Staff }) {
  const [loaded, intake] = await Promise.all([
    loadDiligence(listingId),
    prisma.listing.findUnique({ where: { id: listingId }, select: { filedByDeskId: true, sellerConfirmedAt: true, sellerConfirmedById: true } }),
  ]);
  if (!loaded || !intake) return null;
  const { diligence, listing } = loaded;
  const pool = listing.kind === "POOL";
  const waivers = diligence.lines.flatMap((line) => line.waived.map((row) => ({ ...row, line })));
  const deciders = [...new Set([intake.filedByDeskId, ...waivers.map((row) => row.waiver.by)].filter((id): id is string => Boolean(id)))];
  const names = deciders.length
    ? new Map((await prisma.user.findMany({ where: { id: { in: deciders } }, select: { id: true, name: true } })).map((person) => [person.id, person.name]))
    : new Map<string, string>();
  const gate = diligenceGateMessage(diligence, listing.kind);
  const intakeHold = deskIntakeHold(intake);
  const compliance = deskCan(viewer, "compliance");
  // One entry per whole-item waiver, however many loans it covers.
  const shownWaivers = waivers.filter((row, index) => !row.whole || waivers.findIndex((other) => other.whole && other.line.key === row.line.key) === index);
  const open = diligence.lines.filter((line) => line.missing.length);
  return (
    <section id="diligence" aria-labelledby="diligence-heading" className="mt-8 scroll-mt-6 border border-border p-5 rounded-xl">
      <h2 id="diligence-heading" className="eyebrow">Diligence set</h2>
      {intake.filedByDeskId && (
        <p className={`mt-2 text-sm ${intakeHold ? "text-warn" : "text-foreground"}`}>
          Filed by the desk{names.get(intake.filedByDeskId) ? ` (${names.get(intake.filedByDeskId)})` : ""} for the seller.{" "}
          {intake.sellerConfirmedAt ? `The seller confirmed the tape on ${prettyDate(intake.sellerConfirmedAt)}.` : "Approval waits for the seller to confirm the tape is theirs and correct."}
        </p>
      )}
      <p className={`mt-2 text-sm ${gate ? "text-warn" : "text-foreground"}`}>
        {gate ?? (diligence.waived ? "Complete, with waivers. Buyers see each waived item and its reason." : "Complete. Buyers see that the diligence set is complete.")}
      </p>
      <ul className="mt-4 divide-y divide-border border border-border rounded-lg">
        {diligence.lines.map((line) => (
          <li key={line.key} className="flex gap-3 px-3 py-3">
            <StateIcon state={line.state} />
            <div className="min-w-0">
              <p className="text-sm text-foreground">{line.label} <span className="text-muted-foreground">· {stateText(line, pool)}</span></p>
              <p className="text-xs text-muted-foreground">{line.hint}</p>
              <Gaps line={line} pool={pool} />
            </div>
          </li>
        ))}
      </ul>
      {shownWaivers.length > 0 && (
        <div className="mt-4">
          <h3 className="text-[13px] font-medium text-foreground">Waivers</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {shownWaivers.map((row) => {
              const key = row.whole ? row.line.key : waiverKey(row.line.key, row.noteId);
              return (
                <li key={key} className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 text-foreground">
                    {row.line.label}
                    {row.whole ? (row.line.scope === "loan" && pool ? " · every loan missing it" : "") : ` · ${row.label}`} · {row.waiver.reason}
                    <span className="block text-xs text-muted-foreground">{names.get(row.waiver.by) ?? "The desk"} · {prettyDate(row.waiver.at)}</span>
                  </p>
                  {compliance && (
                    <form action={clearDiligenceItemWaiver}>
                      <input type="hidden" name="listingId" value={listingId} />
                      <input type="hidden" name="key" value={key} />
                      <SubmitButton variant="ghost" className="h-8 px-2 text-[13px] font-medium text-link" pendingLabel="Withdrawing…">Withdraw</SubmitButton>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {open.length > 0 && (compliance ? (
        <form action={waiveDiligenceItem} className="mt-4 grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
          <input type="hidden" name="listingId" value={listingId} />
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Waive</span>
            <select name="target" required defaultValue="" className="desk-input mt-2">
              <option value="" disabled>Choose an item</option>
              {open.map((line) => (
                <optgroup key={line.key} label={line.label}>
                  <option value={line.key}>{pool && line.scope === "loan" ? `Every loan missing it (${line.missing.length})` : line.label}</option>
                  {pool && line.scope === "loan" && line.missing.slice(0, 200).map((gap) => <option key={gap.noteId} value={waiverKey(line.key, gap.noteId)}>{gap.label}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Reason</span>
            <input name="reason" required minLength={3} maxLength={300} className="desk-input mt-2" autoComplete="off" />
          </label>
          <p className="text-xs text-muted-foreground sm:col-span-2">Buyers see the item and the reason. Leave out names and addresses.</p>
          <div className="sm:col-span-2"><SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Saving…">Waive the item</SubmitButton></div>
        </form>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">Compliance can waive a missing item with a reason.</p>
      ))}
    </section>
  );
}

// On the seller's listing page: what the desk needs before go-live, read-only.
export async function SellerDiligence({ listingId }: { listingId: string }) {
  const loaded = await loadDiligence(listingId);
  if (!loaded) return null;
  const { diligence, listing } = loaded;
  if (!["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED"].includes(listing.status)) return null;
  const pool = listing.kind === "POOL";
  return (
    <section id="diligence" aria-labelledby="diligence-heading" className="mt-8 scroll-mt-6 border border-border p-5 rounded-xl">
      <h2 id="diligence-heading" className="eyebrow">Diligence set</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {diligence.complete
          ? "Everything the desk asks for before go-live is on file or waived."
          : "The desk needs these before the listing goes live. Add a missing file to the data room, or send it to the desk."}
      </p>
      <ul className="mt-4 divide-y divide-border border border-border rounded-lg">
        {diligence.lines.filter((line) => line.state !== "not_required").map((line) => (
          <li key={line.key} className="flex gap-3 px-3 py-3">
            <StateIcon state={line.state} />
            <div className="min-w-0">
              <p className="text-sm text-foreground">{line.label} <span className="text-muted-foreground">· {stateText(line, pool)}</span></p>
              <Gaps line={line} pool={pool} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// On the buyer's listing page: one line, and the waived items with their reasons when there are any.
export async function BuyerDiligenceLine({ listingId }: { listingId: string }) {
  const loaded = await loadDiligence(listingId);
  if (!loaded) return null;
  const view = buyerDiligence(loaded.diligence);
  const count = (loans: number) => (loans && loaded.listing.kind === "POOL" ? ` on ${plural(loans, "loan")}` : "");
  if (view.complete) {
    return (
      <p className="mt-4 flex items-center gap-2 text-sm text-foreground">
        <CircleCheck className="size-4 text-good" aria-hidden />
        Diligence set complete
      </p>
    );
  }
  return (
    <div className="mt-4 text-sm">
      <p className="flex items-center gap-2 text-foreground">
        <CircleMinus className="size-4 text-muted-foreground" aria-hidden />
        {view.missing.length ? "Diligence set incomplete" : "Diligence set complete, with waivers"}
      </p>
      <ul className="mt-1 space-y-1 pl-6 text-muted-foreground">
        {view.waived.map((row) => <li key={row.key}>Waived: {row.label}{count(row.loans)} · {row.reasons.join("; ")}</li>)}
        {view.missing.map((row) => <li key={row.key}>Not on file: {row.label}{count(row.loans)}</li>)}
      </ul>
    </div>
  );
}
