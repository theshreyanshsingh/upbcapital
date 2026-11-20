import { SubmitButton } from "@/components/submit-button";
import {
  EXPIRY_DAYS,
  DEFAULT_EXPIRY_DAYS,
  NOTES_MAX,
  PRICE_GUIDE_LINE,
  publicRequestCounts,
  REQUEST_KINDS,
  SELLER_ANSWER_LABELS,
  TITLE_MAX,
  TITLE_MIN,
  type BoardRequest,
  type RequestCell,
  type RequestCriteria,
} from "@/lib/bids-wanted";
import type { EntityChoice } from "@/lib/buyer-entities";
import { MIN_FIRMS } from "@/lib/demand-board";
import { PROGRAM_CHOICES } from "@/lib/filters";
import { prettyDate } from "@/lib/format";
import { LIEN_POSITIONS, PAYMENT_STATUSES } from "@/lib/labels";

// Bids wanted on the page: the buyer's form, a request's terms as chips, the card sellers and brokers read, and the
// public teaser on /buying. The rules are in lib/bids-wanted.ts.

const field = (value: number | null | undefined) => (value == null ? "" : String(value));

function Checks({ legend, prefix, options, picked, hint }: { legend: string; prefix: string; options: readonly { value: string; label: string }[]; picked?: string[]; hint: string }) {
  return (
    <fieldset>
      <legend className="text-[13px] font-semibold text-foreground">{legend}</legend>
      <div className="mt-1 flex flex-wrap gap-x-4 text-sm text-foreground">
        {options.map((item) => (
          <label key={item.value} className="inline-flex min-h-10 items-center gap-2">
            <input type="checkbox" name={`${prefix}_${item.value}`} defaultChecked={picked?.includes(item.value)} className="size-4 shrink-0" />
            {item.label}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </fieldset>
  );
}

function Figure({ name, label, value, placeholder, numeric = false }: { name: string; label: string; value?: number | null; placeholder: string; numeric?: boolean }) {
  return (
    <label className="block min-w-0">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <input name={name} defaultValue={field(value)} placeholder={placeholder} inputMode={numeric ? "numeric" : "decimal"} className="desk-input mt-2" />
    </label>
  );
}

type FormRequest = { id: string; title: string; notes: string; buyerEntityId: string | null; criteria: RequestCriteria };

// The buyer's request, new or to edit. Full width on a phone, every control at least 40px tall.
export function RequestForm({
  action,
  request,
  entities,
  submitLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  request?: FormRequest;
  entities: EntityChoice[];
  submitLabel: string;
}) {
  const criteria = request?.criteria;
  return (
    <form action={action} className="space-y-5">
      {request && <input type="hidden" name="id" value={request.id} />}
      <label className="block">
        <span className="text-[13px] font-semibold text-foreground">Title</span>
        <input name="title" required minLength={TITLE_MIN} maxLength={TITLE_MAX} defaultValue={request?.title ?? ""} placeholder="VA performing firsts in Texas" className="desk-input mt-2" />
      </label>
      <fieldset>
        <legend className="text-[13px] font-semibold text-foreground">Pools or single notes</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 text-sm text-foreground">
          {REQUEST_KINDS.map((item) => (
            <label key={item.value} className="inline-flex min-h-10 items-center gap-2">
              <input type="radio" name="kind" value={item.value} defaultChecked={(criteria?.kind ?? "ANY") === item.value} className="size-4 shrink-0" />
              {item.label}
            </label>
          ))}
        </div>
      </fieldset>
      <Checks legend="Lien" prefix="lien" options={LIEN_POSITIONS} picked={criteria?.liens} hint="Leave all off for any lien." />
      <Checks legend="Payment status" prefix="status" options={PAYMENT_STATUSES} picked={criteria?.statuses} hint="Leave all off for any performance." />
      <Checks legend="Loan program" prefix="program" options={PROGRAM_CHOICES} picked={criteria?.programs} hint="Leave all off for any program." />
      <label className="block">
        <span className="text-[13px] font-semibold text-foreground">States</span>
        <input name="states" defaultValue={criteria?.states.join(", ") ?? ""} placeholder="TX, OK" autoCapitalize="characters" className="desk-input mt-2" />
        <span className="mt-1 block text-xs text-muted-foreground">Two-letter codes. Blank for any state.</span>
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Figure name="upbMin" label="UPB at least" value={criteria?.upbMin} placeholder="5M" />
        <Figure name="upbMax" label="UPB up to" value={criteria?.upbMax} placeholder="20M" />
        <Figure name="minLoans" label="Fewest loans" value={criteria?.minLoans} placeholder="10" numeric />
        <Figure name="maxLoans" label="Most loans" value={criteria?.maxLoans} placeholder="200" numeric />
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">UPB is the whole listing&apos;s. Loan counts are for pools; leave them blank for single notes.</p>
      <fieldset className="rounded-xl border border-border p-4">
        <legend className="px-1 text-[13px] font-semibold text-foreground">Price guide, optional</legend>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {PRICE_GUIDE_LINE} It is your own statement of what you pay, not a bid. Give the most you pay as a percent of UPB, a target yield, both or neither.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Figure name="priceToUpbMax" label="Most you pay, % of UPB" value={criteria?.priceToUpbMax} placeholder="85" />
          <Figure name="targetYield" label="Target yield, %" value={criteria?.targetYield} placeholder="9" />
        </div>
      </fieldset>
      <label className="block">
        <span className="text-[13px] font-semibold text-foreground">Notes, optional</span>
        <textarea name="notes" maxLength={NOTES_MAX} rows={4} defaultValue={request?.notes ?? ""} placeholder="Servicing released preferred. Can close in 30 days." className="desk-input mt-2 min-h-24 py-2" />
        <span className="mt-1 block text-xs text-muted-foreground">Up to {NOTES_MAX} characters. Sellers read them.</span>
      </label>
      {entities.length > 1 && (
        <label className="block">
          <span className="text-[13px] font-semibold text-foreground">Buying as</span>
          <select name="buyerEntityId" defaultValue={request?.buyerEntityId ?? ""} className="desk-input mt-2">
            {entities.map((entity) => (
              <option key={entity.id || "main"} value={entity.id}>{entity.name} · {entity.kind}</option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-muted-foreground">Sellers see this entity&apos;s type, never its name.</span>
        </label>
      )}
      <label className="block">
        <span className="text-[13px] font-semibold text-foreground">Runs for</span>
        <select name="expiryDays" defaultValue={String(DEFAULT_EXPIRY_DAYS)} className="desk-input mt-2">
          {EXPIRY_DAYS.map((days) => (
            <option key={days} value={days}>{days} days</option>
          ))}
        </select>
        {request && <span className="mt-1 block text-xs text-muted-foreground">Counts from when you save.</span>}
      </label>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Sellers and brokers see your firm only as a type, such as Fund or Bank, with your record of closings on UPB. Leave names, emails and phone numbers out of the title and notes.
      </p>
      <SubmitButton pendingLabel="Saving…" className="h-11 w-full px-4 text-[13px] font-medium sm:w-auto">{submitLabel}</SubmitButton>
    </form>
  );
}

// A request's terms as chips that wrap on a phone.
export function CriteriaList({ lines }: { lines: string[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="What the buyer wants">
      {lines.map((line) => (
        <li key={line} className="max-w-full rounded-full border border-border px-2.5 py-1 text-xs break-words text-foreground">{line}</li>
      ))}
    </ul>
  );
}

// A request as sellers, brokers and the desk's board read it: the buyer as a type and a factual record, never a name.
export function RequestBoardCard({ request, action }: { request: BoardRequest; action?: React.ReactNode }) {
  return (
    <article className="glass p-5" aria-labelledby={`wanted-${request.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">{request.buyerType}</p>
          <h2 id={`wanted-${request.id}`} className="mt-1 text-lg font-semibold break-words text-foreground">{request.title}</h2>
        </div>
        {action}
      </div>
      {request.track.length > 0 && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">On UPB: {request.track.join(" · ")}</p>}
      <CriteriaList lines={request.criteria} />
      {request.notes && <p className="mt-3 text-sm leading-relaxed whitespace-pre-line break-words text-foreground">{request.notes}</p>}
      <p className="mt-3 text-xs text-muted-foreground tabular-nums">
        Posted {prettyDate(request.postedAt)}
        {request.expiresAt ? ` · runs until ${prettyDate(request.expiresAt)}` : ""}
      </p>
      {request.answers.length > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="text-[13px] font-semibold text-foreground">You sent</p>
          <ul className="mt-1 space-y-1">
            {request.answers.map((answer) => (
              <li key={answer.id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
                <span className="min-w-0 break-words text-foreground">{answer.title}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{SELLER_ANSWER_LABELS[answer.status] ?? answer.status} · {prettyDate(answer.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function countLine(cells: RequestCell[]) {
  return cells.map((cell) => `${cell.label}: ${cell.requests == null ? `fewer than ${MIN_FIRMS} buyers` : cell.requests}`).join(" · ");
}

// The public line on /buying: open requests by lien and by performance. Counts only, under the board's minimum of
// firms (lib/demand-board.ts). No title, term, price or buyer.
export async function RequestTeaser() {
  const counts = await publicRequestCounts();
  return (
    <section className="glass p-5 md:p-6" aria-labelledby="requests-heading">
      <h2 id="requests-heading" className="eyebrow">Open buyer requests</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Approved buyers post what they want to buy, and sellers and brokers on UPB answer with a listing. These are counts of open requests only, never what a request says or who posted it.
      </p>
      {counts.total == null ? (
        <p className="mt-3 text-sm text-foreground">Fewer than {MIN_FIRMS} buyers have a request open, so no counts show yet.</p>
      ) : (
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-[13px] text-muted-foreground">By lien, of {counts.total} open</dt>
            <dd className="mt-1 text-sm break-words text-foreground tabular-nums">{countLine(counts.liens)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[13px] text-muted-foreground">By performance</dt>
            <dd className="mt-1 text-sm break-words text-foreground tabular-nums">{countLine(counts.statuses)}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
