export function StepChrome({
  step,
  total,
  kicker,
  title,
  lede,
  children,
}: {
  step: number;
  total: number;
  kicker: string;
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-xl pb-24 md:pb-0">
      <div className="flex items-center gap-3">
        <p className="eyebrow">{kicker}</p>
        <div className="h-px flex-1 bg-muted" />
        <p className="text-[13px] font-medium text-muted-foreground">{step} of {total}</p>
      </div>
      <div className="mt-3 h-1 overflow-hidden bg-muted" aria-hidden>
        <div className="step-bar h-full bg-primary rounded-lg" style={{ width: `${Math.max(8, (step / total) * 100)}%` }} />
      </div>
      <h1 className="rise mt-8 font-semibold tracking-tight text-3xl leading-none text-foreground">{title}</h1>
      <p className="mt-4 text-sm leading-relaxed text-muted-foreground sm:text-base">{lede}</p>
      <div className="mt-8">{children}</div>
    </div>
  );
}

export function ChoiceCard({
  selected,
  title,
  lede,
  onSelect,
}: {
  selected: boolean;
  title: string;
  lede: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`min-h-24 w-full border p-4 text-left transition ${selected ? "border-link bg-link/10" : "border-border hover:border-link/40"}`}
    >
      <span className="block font-semibold tracking-tight text-2xl text-foreground">{title}</span>
      <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{lede}</span>
    </button>
  );
}

export function FieldLabel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="mt-2 block">{children}</span>
    </label>
  );
}
