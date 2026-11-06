export type MetricInput = {
  upb: number;
  askingPrice: number;
  estimatedValue: number;
  monthlyPi: number;
  interestRate: number;
  paymentStatus: string;
};

export type NoteMetrics = {
  priceToUpb: number | null;
  priceToValue: number | null;
  ltv: number | null;
  currentYield: number | null;
  noteRate: number;
  equityCushion: number | null;
};

function ratio(part: number, whole: number) {
  if (!whole) return null;
  return (part / whole) * 100;
}

export function noteMetrics(note: MetricInput): NoteMetrics {
  const currentYield =
    note.paymentStatus === "PERFORMING" && note.askingPrice > 0
      ? ((note.monthlyPi * 12) / note.askingPrice) * 100
      : null;
  return {
    priceToUpb: ratio(note.askingPrice, note.upb),
    priceToValue: ratio(note.askingPrice, note.estimatedValue),
    ltv: ratio(note.upb, note.estimatedValue),
    currentYield,
    noteRate: note.interestRate,
    equityCushion: note.estimatedValue > 0 ? note.estimatedValue - note.upb : null,
  };
}

export function poolMetrics(notes: MetricInput[]) {
  const totalUpb = notes.reduce((sum, note) => sum + note.upb, 0);
  const totalAsk = notes.reduce((sum, note) => sum + note.askingPrice, 0);
  const totalValue = notes.reduce((sum, note) => sum + note.estimatedValue, 0);
  const performing = notes.filter((note) => note.paymentStatus === "PERFORMING");
  const performingAsk = performing.reduce((sum, note) => sum + note.askingPrice, 0);
  const performingDebt = performing.reduce((sum, note) => sum + note.monthlyPi * 12, 0);
  const weightedRate =
    totalUpb > 0 ? notes.reduce((sum, note) => sum + note.interestRate * note.upb, 0) / totalUpb : 0;
  return {
    totalUpb,
    totalAsk,
    totalValue,
    loanCount: notes.length,
    priceToUpb: ratio(totalAsk, totalUpb),
    priceToValue: ratio(totalAsk, totalValue),
    ltv: ratio(totalUpb, totalValue),
    currentYield: performingAsk > 0 ? (performingDebt / performingAsk) * 100 : null,
    noteRate: weightedRate,
    performingUpb: performing.reduce((sum, note) => sum + note.upb, 0),
    subUpb: notes
      .filter((note) => note.paymentStatus === "SUB_PERFORMING")
      .reduce((sum, note) => sum + note.upb, 0),
    nplUpb: notes
      .filter((note) => note.paymentStatus === "NON_PERFORMING")
      .reduce((sum, note) => sum + note.upb, 0),
  };
}

// The loans a book row prices. A live pool shows only the loans still for sale; sold paper keeps its whole tape.
export function loansForSale<T extends { tradeStatus: string }>(listingStatus: string, notes: T[]): T[] {
  return listingStatus !== "SOLD" && notes.some((note) => note.tradeStatus === "AVAILABLE")
    ? notes.filter((note) => note.tradeStatus === "AVAILABLE")
    : notes;
}

export type ListingFigures = {
  upb: number;
  asking: number;
  value: number;
  priceToUpb: number | null;
  priceToValue: number | null;
  ltv: number | null;
  yield: number | null;
  noteRate: number;
  loanCount: number;
  performingCount: number;
};

// One set of figures for a book row, a compare column or a filter: a pool's totals, or its one note's.
export function listingFigures(kind: string, notes: MetricInput[]): ListingFigures {
  const performingCount = notes.filter((note) => note.paymentStatus === "PERFORMING").length;
  if (kind === "POOL") {
    const pool = poolMetrics(notes);
    return {
      upb: pool.totalUpb,
      asking: pool.totalAsk,
      value: pool.totalValue,
      priceToUpb: pool.priceToUpb,
      priceToValue: pool.priceToValue,
      ltv: pool.ltv,
      yield: pool.currentYield,
      noteRate: pool.noteRate,
      loanCount: notes.length,
      performingCount,
    };
  }
  const note = notes[0];
  if (!note) {
    return { upb: 0, asking: 0, value: 0, priceToUpb: null, priceToValue: null, ltv: null, yield: null, noteRate: 0, loanCount: 0, performingCount: 0 };
  }
  const metrics = noteMetrics(note);
  return {
    upb: note.upb,
    asking: note.askingPrice,
    value: note.estimatedValue,
    priceToUpb: metrics.priceToUpb,
    priceToValue: metrics.priceToValue,
    ltv: metrics.ltv,
    yield: metrics.currentYield,
    noteRate: note.interestRate,
    loanCount: 1,
    performingCount,
  };
}

// The same annual P&I over the ask plus the buyer premium, so the yield a buyer actually pays for.
export function allInYield(currentYield: number | null, premiumBps: number) {
  if (currentYield == null || !Number.isFinite(currentYield)) return null;
  return currentYield / (1 + premiumBps / 10000);
}

export type Hold = "early" | "limit" | null;

// What the book shows one viewer of one listing. A free member sees no figures, and a listing they can't open is
// held as early access or as beyond the free slice. Sold paper is never held. Cards, table rows and compare
// columns all read this, so none of them can show more than another.
export function bookVeil(input: { sold: boolean; pro: boolean; early: boolean; openable: boolean }) {
  const early = !input.sold && input.early && !input.pro;
  const limited = !input.sold && !input.pro && !early && !input.openable;
  const hold: Hold = early ? "early" : limited ? "limit" : null;
  return { hold, figures: input.pro && !early };
}

// A value every loan shares, or null when the loans differ.
export function common(values: string[]) {
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : null;
}

// Four side by side is the most a page can show and still read.
export const COMPARE_LIMIT = 4;

export type CompareNote = MetricInput & {
  tradeStatus: string;
  city: string;
  state: string;
  lienPosition: string;
  propertyType: string;
  occupancy: string;
  foreclosureStatus: string;
  monthsDelinquent: number;
  modified?: boolean | null;
  bankruptcyChapter?: string | null;
  bankruptcyFiledAt?: Date | string | null;
  hoaLien?: boolean | null;
  taxDelinquent?: boolean | null;
};

export type CompareListing = {
  id: string;
  title: string;
  kind: string;
  status: string;
  bidMode: string;
  bidDeadline: Date | null;
  notes: CompareNote[];
};

export type CompareAccess = { ok: true } | { ok: false; reason: string };

// A tape flag across the loans for sale: how many carry it, or null when no loan's tape says either way.
export type FlagCount = { flagged: number; of: number } | null;

export type CompareColumn = {
  id: string;
  // Off the open book, or not for this account: nothing shows, not even the title.
  hidden: boolean;
  hold: "early" | "limit" | null;
  title: string;
  card: {
    kind: string;
    status: string;
    city: string;
    states: string[];
    lien: string | null;
    performance: string | null;
    property: string | null;
    loanCount: number;
    bidMode: string;
    deadline: string | null;
  } | null;
  file: {
    occupancy: string | null;
    foreclosure: string | null;
    monthsDelinquent: [number, number];
    modified: FlagCount;
    bankruptcy: FlagCount;
    hoaLien: FlagCount;
    taxDelinquent: FlagCount;
  } | null;
  figures: ListingFigures | null;
};

function flagCount(notes: CompareNote[], read: (note: CompareNote) => boolean | null) {
  const known = notes.map(read).filter((value): value is boolean => value != null);
  return known.length ? { flagged: known.filter(Boolean).length, of: notes.length } : null;
}

// One listing's column on the compare page, under the same holds and veils as its card and its own page. A held
// listing shows what its card shows and nothing from its file; figures need Pro.
export function compareColumn(listing: CompareListing, access: CompareAccess, pro: boolean): CompareColumn {
  const hold = !access.ok && (access.reason === "early" || access.reason === "limit") ? access.reason : null;
  if (!access.ok && !hold) return { id: listing.id, hidden: true, hold: null, title: "", card: null, file: null, figures: null };
  const notes = loansForSale(listing.status, listing.notes);
  const card = {
    kind: listing.kind,
    status: listing.status,
    city: notes[0]?.city ?? "",
    states: [...new Set(notes.map((note) => note.state))].sort(),
    lien: common(notes.map((note) => note.lienPosition)),
    performance: common(notes.map((note) => note.paymentStatus)),
    property: common(notes.map((note) => note.propertyType)),
    loanCount: notes.length,
    bidMode: listing.bidMode,
    deadline: listing.bidMode !== "NONE" && listing.bidDeadline ? listing.bidDeadline.toISOString() : null,
  };
  if (hold) return { id: listing.id, hidden: false, hold, title: listing.title, card, file: null, figures: null };
  const late = notes.map((note) => note.monthsDelinquent);
  return {
    id: listing.id,
    hidden: false,
    hold: null,
    title: listing.title,
    card,
    file: {
      occupancy: common(notes.map((note) => note.occupancy)),
      foreclosure: common(notes.map((note) => note.foreclosureStatus)),
      monthsDelinquent: late.length ? [Math.min(...late), Math.max(...late)] : [0, 0],
      modified: flagCount(notes, (note) => note.modified ?? null),
      bankruptcy: flagCount(notes, (note) => (note.bankruptcyChapter || note.bankruptcyFiledAt ? true : null)) ?? { flagged: 0, of: notes.length },
      hoaLien: flagCount(notes, (note) => note.hoaLien ?? null),
      taxDelinquent: flagCount(notes, (note) => note.taxDelinquent ?? null),
    },
    figures: pro ? listingFigures(listing.kind, notes) : null,
  };
}
