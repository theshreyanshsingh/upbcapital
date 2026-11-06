import * as React from "react"
import { cn } from "cn"

// One headline figure with its label and its basis ("as of", "before fees"). A change carries a sign
// and an arrow, never colour alone, and stays neutral unless the caller says which way is good.

type Change = { text: string; direction: "up" | "down" | "flat"; tone?: "good" | "bad" | "neutral" }

const arrows = { up: "▲", down: "▼", flat: "▬" } as const
const tones = { good: "text-good", bad: "text-bad", neutral: "text-muted-foreground" } as const

function Stat({
  label,
  value,
  basis,
  change,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  label: React.ReactNode
  value: React.ReactNode
  basis?: React.ReactNode
  change?: Change
}) {
  return (
    <div data-slot="stat" className={cn("glass p-5", className)} {...props}>
      <p className="eyebrow">{label}</p>
      <p data-figure className="mt-2 text-[1.75rem] leading-tight font-semibold tracking-[-0.02em] text-foreground">{value}</p>
      {change && (
        <p className={cn("figure mt-1.5 inline-flex items-center gap-1 text-[0.8125rem] font-medium", tones[change.tone ?? "neutral"])}>
          <span aria-hidden className="text-[0.625rem]">{arrows[change.direction]}</span>
          {change.text}
        </p>
      )}
      {basis && <p className="mt-1.5 text-[0.8125rem] leading-5 text-muted-foreground">{basis}</p>}
    </div>
  )
}

export { Stat }
