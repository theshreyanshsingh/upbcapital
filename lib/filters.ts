export type BookFilters = {
  state?: string;
  paymentStatus?: string;
  lienPosition?: string;
  propertyType?: string;
  upbMin?: number;
  upbMax?: number;
  priceMin?: number;
  priceMax?: number;
  kind?: string;
  q?: string;
};

export function parseFilters(input: {
  state?: string;
  paymentStatus?: string;
  lienPosition?: string;
  propertyType?: string;
  upbMin?: string;
  upbMax?: string;
  priceMin?: string;
  priceMax?: string;
  kind?: string;
  q?: string;
}): BookFilters {
  const num = (value?: string) => {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  return {
    state: input.state || undefined,
    paymentStatus: input.paymentStatus || undefined,
    lienPosition: input.lienPosition || undefined,
    propertyType: input.propertyType || undefined,
    upbMin: num(input.upbMin),
    upbMax: num(input.upbMax),
    priceMin: num(input.priceMin),
    priceMax: num(input.priceMax),
    kind: input.kind || undefined,
    q: input.q?.trim() || undefined,
  };
}

export function filtersActive(filters: BookFilters) {
  return Object.values(filters).some(Boolean);
}

export function noteMatches(
  note: {
    city: string;
    state: string;
    paymentStatus: string;
    lienPosition: string;
    propertyType: string;
    upb: number;
    askingPrice: number;
  },
  filters: BookFilters,
) {
  if (filters.state && note.state !== filters.state) return false;
  if (filters.paymentStatus && note.paymentStatus !== filters.paymentStatus) return false;
  if (filters.lienPosition && note.lienPosition !== filters.lienPosition) return false;
  if (filters.propertyType && note.propertyType !== filters.propertyType) return false;
  if (filters.upbMin && note.upb < filters.upbMin) return false;
  if (filters.upbMax && note.upb > filters.upbMax) return false;
  if (filters.priceMin && note.askingPrice < filters.priceMin) return false;
  if (filters.priceMax && note.askingPrice > filters.priceMax) return false;
  if (filters.q && !`${note.city} ${note.state}`.toLowerCase().includes(filters.q.toLowerCase())) return false;
  return true;
}

type MatchNote = Parameters<typeof noteMatches>[0] & { tradeStatus?: string };

// A listing is judged on what its card shows. A pool's balance and price are the totals of the loans still for
// sale, while place, performance, lien and property can match any one of those loans.
export function listingMatches(listing: { kind: string; notes: MatchNote[] }, filters: BookFilters) {
  if (filters.kind && listing.kind !== filters.kind) return false;
  const open = listing.notes.filter((note) => !note.tradeStatus || note.tradeStatus === "AVAILABLE");
  const notes = open.length ? open : listing.notes;
  if (listing.kind !== "POOL") return notes.some((note) => noteMatches(note, filters));
  const { upbMin, upbMax, priceMin, priceMax, ...rest } = filters;
  const upb = notes.reduce((sum, note) => sum + note.upb, 0);
  const price = notes.reduce((sum, note) => sum + note.askingPrice, 0);
  if ((upbMin && upb < upbMin) || (upbMax && upb > upbMax) || (priceMin && price < priceMin) || (priceMax && price > priceMax)) return false;
  return notes.some((note) => noteMatches(note, rest));
}

// Balance and price filters would reveal the figures free members see veiled, so they apply on Pro only.
export function filtersFor(filters: BookFilters, pro: boolean): BookFilters {
  return pro ? filters : { ...filters, upbMin: undefined, upbMax: undefined, priceMin: undefined, priceMax: undefined };
}
