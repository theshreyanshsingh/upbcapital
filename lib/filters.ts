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
