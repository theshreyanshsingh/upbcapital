import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BID_MODES, BOOK_STATUSES, KINDS, listOf, SORTS, type BookFilters, type BookSort, type Flag } from "@/lib/filters";
import { FORECLOSURES, LIEN_POSITIONS, OCCUPANCIES, PAYMENT_STATUSES, PROPERTY_TYPES } from "@/lib/labels";
import { cn } from "@/lib/utils";

export type FlagsPresent = { modified: boolean; bankruptcy: boolean; hoaLien: boolean; taxDelinquent: boolean };

const FLAG_FIELDS: { name: keyof FlagsPresent; label: string; yes: string; no: string }[] = [
  { name: "modified", label: "Modification", yes: "Modified", no: "Not marked modified" },
  { name: "bankruptcy", label: "Bankruptcy", yes: "On the tape", no: "None on the tape" },
  { name: "hoaLien", label: "HOA lien", yes: "HOA lien marked", no: "None marked" },
  { name: "taxDelinquent", label: "Property tax", yes: "Tax delinquent", no: "None marked" },
];

const RANGES: { label: string; min: keyof BookFilters; max: keyof BookFilters; unit: string }[] = [
  { label: "UPB", min: "upbMin", max: "upbMax", unit: "$" },
  { label: "Ask", min: "priceMin", max: "priceMax", unit: "$" },
  { label: "Note rate", min: "rateMin", max: "rateMax", unit: "%" },
  { label: "Price / UPB", min: "ptuMin", max: "ptuMax", unit: "%" },
  { label: "Current yield", min: "yieldMin", max: "yieldMax", unit: "%" },
  { label: "Value", min: "valueMin", max: "valueMax", unit: "$" },
  { label: "LTV", min: "ltvMin", max: "ltvMax", unit: "%" },
];

// The book's full filter set, one labelled field for every attribute a card, a row or a listing shows.
// It submits to the address bar, so a view is a link and a saved search reads the same keys. As a panel it sits
// inline on a wide screen; in the phone's sheet it opens in full, one column, with Apply pinned to the bottom.
export function BookFiltersForm({
  filters,
  pro,
  states,
  sort,
  view,
  flagsPresent,
  resetHref,
  event,
  layout = "panel",
  className,
}: {
  filters: BookFilters;
  pro: boolean;
  states: string[];
  sort: BookSort;
  view: string;
  flagsPresent: FlagsPresent;
  resetHref: string;
  // The sale event the book is narrowed to, kept when the form is submitted.
  event?: string;
  layout?: "panel" | "sheet";
  className?: string;
}) {
  const sheet = layout === "sheet";
  const more = Object.entries(filters).filter(([key, value]) => key !== "q" && key !== "state" && value !== undefined && !(Array.isArray(value) && !value.length)).length;
  const flags = FLAG_FIELDS.filter((field) => flagsPresent[field.name] || filters[field.name]);
  return (
    <form action="/marketplace" role="search" aria-label="Filter the book" className={cn(sheet ? "px-5 pt-3" : "mt-6 glass p-4", className)}>
      {view !== "cards" && <input type="hidden" name="view" value={view} />}
      {event && <input type="hidden" name="event" value={event} />}
      <div className={cn("grid gap-3", !sheet && "sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto]")}>
        <label className="block text-xs text-muted-foreground">
          City or state
          <input name="q" defaultValue={filters.q ?? ""} placeholder="Any place" className="desk-input mt-1" />
        </label>
        <label className="block text-xs text-muted-foreground">
          State
          <select name="state" defaultValue={filters.state ?? ""} className="desk-input mt-1">
            <option value="">Any state</option>
            {states.map((state) => <option key={state}>{state}</option>)}
          </select>
        </label>
        <label className="block text-xs text-muted-foreground">
          Sort
          <select name="sort" defaultValue={sort.key} className="desk-input mt-1">
            {SORTS.filter((option) => pro || !option.pro).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        {!sheet && (
          <div className="flex items-end gap-3">
            <Button type="submit" className="h-10 px-4 text-[13px] font-medium">Apply</Button>
            <Link href={resetHref} className="inline-flex h-10 items-center text-[13px] font-medium text-muted-foreground hover:text-foreground">Reset</Link>
          </div>
        )}
      </div>
      <details open={sheet || more > 0} className="mt-4 border-t border-border pt-3">
        <summary className="cursor-pointer text-[13px] font-medium text-foreground">
          More filters{more ? ` · ${more} on` : ""}
        </summary>
        <div className={cn("mt-4 grid gap-x-6 gap-y-5", sheet ? "grid-cols-2" : "sm:grid-cols-2 xl:grid-cols-4")}>
          <Checks legend="Performance" name="paymentStatus" options={PAYMENT_STATUSES} picked={filters.paymentStatus} />
          <Checks legend="Lien" name="lienPosition" options={LIEN_POSITIONS} picked={filters.lienPosition} />
          <Checks legend="Property" name="propertyType" options={PROPERTY_TYPES} picked={filters.propertyType} />
          <Checks legend="Occupancy" name="occupancy" options={OCCUPANCIES} picked={filters.occupancy} />
          <Checks legend="Foreclosure" name="foreclosureStatus" options={FORECLOSURES} picked={filters.foreclosureStatus} />
          <Checks legend="Bid style" name="bidMode" options={BID_MODES} picked={filters.bidMode} />
          <fieldset className={cn("space-y-2", sheet && "col-span-2")}>
            <legend className="text-[13px] font-semibold text-foreground">Sale</legend>
            <Choice label="Type" name="kind" value={filters.kind} any="Notes and pools" options={KINDS} />
            <Choice label="Status" name="status" value={filters.status} any="Live and in contract" options={BOOK_STATUSES} />
            <Choice label="Deadline" name="deadline" value={filters.deadline} any="With or without" options={[{ value: "yes", label: "Dated deadline" }, { value: "no", label: "No deadline" }]} />
          </fieldset>
          <fieldset className={cn("space-y-2", sheet && "col-span-2")}>
            <legend className="text-[13px] font-semibold text-foreground">Months delinquent</legend>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-xs text-muted-foreground">
                From
                <input name="dlqMin" inputMode="numeric" defaultValue={filters.dlqMin ?? ""} className="desk-input mt-1 tabular-nums" />
              </label>
              <label className="block text-xs text-muted-foreground">
                To
                <input name="dlqMax" inputMode="numeric" defaultValue={filters.dlqMax ?? ""} className="desk-input mt-1 tabular-nums" />
              </label>
            </div>
          </fieldset>
          {flags.length > 0 && (
            <fieldset className={cn("space-y-2", sheet && "col-span-2")}>
              <legend className="text-[13px] font-semibold text-foreground">Tape flags</legend>
              {flags.map((field) => (
                <Choice key={field.name} label={field.label} name={field.name} value={filters[field.name]} any="Any" options={[{ value: "yes", label: field.yes }, { value: "no", label: field.no }]} />
              ))}
            </fieldset>
          )}
          {pro ? (
            <fieldset className={cn("space-y-2", sheet ? "col-span-2" : "sm:col-span-2")}>
              <legend className="text-[13px] font-semibold text-foreground">Figures</legend>
              <div className={cn("grid gap-2", !sheet && "sm:grid-cols-2")}>
                {RANGES.map((range) => (
                  <div key={range.label} className="grid grid-cols-2 gap-2">
                    <label className="block text-xs text-muted-foreground">
                      {range.label} from ({range.unit})
                      <input name={range.min} inputMode="decimal" defaultValue={(filters[range.min] as number | undefined) ?? ""} className="desk-input mt-1 tabular-nums" />
                    </label>
                    <label className="block text-xs text-muted-foreground">
                      {range.label} to ({range.unit})
                      <input name={range.max} inputMode="decimal" defaultValue={(filters[range.max] as number | undefined) ?? ""} className="desk-input mt-1 tabular-nums" />
                    </label>
                  </div>
                ))}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">A pool is judged on the totals of the loans still for sale. Note rate matches any one loan. LTV is UPB over the seller&apos;s estimated value.</p>
            </fieldset>
          ) : (
            <p className={cn("text-sm leading-relaxed text-muted-foreground", sheet ? "col-span-2" : "sm:col-span-2")}>
              Filters on balance, ask, rate, price to UPB, yield, value and LTV are part of Pro, along with those sorts.
            </p>
          )}
        </div>
        {!pro && (
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Occupancy, foreclosure, months delinquent and tape flags come from the loan file, so they skip listings you can&apos;t open yet.
          </p>
        )}
        {!sheet && <Button type="submit" className="mt-4 h-10 px-4 text-[13px] font-medium">Apply filters</Button>}
      </details>
      {sheet && (
        <div className="sticky bottom-0 -mx-5 mt-5 flex items-center gap-3 border-t border-border bg-popover/95 px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur">
          <Link href={resetHref} className="inline-flex h-12 items-center px-2 text-[15px] font-medium text-muted-foreground">Reset</Link>
          <Button type="submit" className="h-12 flex-1 rounded-xl text-[15px] font-semibold">Show matches</Button>
        </div>
      )}
    </form>
  );
}

function Checks({ legend, name, options, picked }: { legend: string; name: string; options: readonly { value: string; label: string }[]; picked: string | string[] | undefined }) {
  const on = new Set(listOf(picked));
  return (
    <fieldset>
      <legend className="text-[13px] font-semibold text-foreground">{legend}</legend>
      <div className="mt-2 grid gap-1.5">
        {options.map((option) => (
          <label key={option.value} className="flex min-h-6 items-center gap-2 text-sm text-foreground pointer-coarse:min-h-10 pointer-coarse:gap-2.5">
            <input type="checkbox" name={name} value={option.value} defaultChecked={on.has(option.value)} className="size-4 accent-link" />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Choice({ label, name, value, any, options }: { label: string; name: string; value: string | Flag | undefined; any: string; options: readonly { value: string; label: string }[] }) {
  return (
    <label className="block text-xs text-muted-foreground">
      {label}
      <select name={name} defaultValue={value ?? ""} className="desk-input mt-1">
        <option value="">{any}</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}
