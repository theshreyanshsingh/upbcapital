export type FunnelInput = {
  visits: number;
  signups: number;
  verified: number;
  offers: number;
  closings: number;
  closed: number;
};

export function funnelSteps(input: FunnelInput) {
  const steps = [
    { key: "visits", label: "Visits", value: input.visits },
    { key: "signups", label: "Signups", value: input.signups },
    { key: "verified", label: "Verified buyers", value: input.verified },
    { key: "offers", label: "Offers", value: input.offers },
    { key: "closings", label: "Closings", value: input.closings },
    { key: "closed", label: "Closed", value: input.closed },
  ];
  return steps.map((step, index) => {
    const prior = index === 0 ? null : steps[index - 1].value;
    const rate = prior && prior > 0 ? (step.value / prior) * 100 : null;
    return { ...step, rate };
  });
}

export function daysBetween(start: Date, end: Date) {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86400000));
}

export function average(values: number[]) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
