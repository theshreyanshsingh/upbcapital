export type Comp = { state: string; paymentStatus: string; upb: number; askingPrice: number };

export function suggestedPrice(subject: Comp, book: Comp[]) {
  const peers = book.filter(
    (row) =>
      row !== subject &&
      row.state === subject.state &&
      row.paymentStatus === subject.paymentStatus &&
      row.upb > 0 &&
      row.askingPrice > 0 &&
      row.upb >= subject.upb * 0.6 &&
      row.upb <= subject.upb * 1.4,
  );
  if (peers.length < 2 || subject.upb <= 0) return null;
  const ratios = peers.map((row) => row.askingPrice / row.upb).sort((a, b) => a - b);
  const mid = ratios[Math.floor(ratios.length / 2)];
  return { price: Math.round(subject.upb * mid), sample: peers.length, priceToUpb: mid * 100 };
}
