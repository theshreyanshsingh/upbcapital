// The page title is the one display moment on a desk page: an Inter eyebrow, the title in the serif,
// and the lede at reading size.
export function PageIntro({
  eyebrow,
  title,
  lede,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
}) {
  return (
    <header className="mb-6 max-w-3xl sm:mb-8">
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="mt-1.5 type-display font-semibold text-balance text-foreground">{title}</h1>
      {lede && <p className="mt-3 max-w-2xl type-body text-pretty text-muted-foreground">{lede}</p>}
    </header>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="type-label font-medium text-foreground">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint && <span className="mt-1.5 block type-label text-pretty text-muted-foreground">{hint}</span>}
    </label>
  );
}
