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
