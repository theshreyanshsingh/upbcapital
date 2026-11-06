import * as React from "react"
import { cn } from "cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-field px-2.5 py-2 text-base leading-relaxed transition-colors outline-none placeholder:text-faint hover:not-focus:border-[color-mix(in_oklab,var(--input),var(--foreground)_22%)] focus-visible:border-ring disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:pointer-fine:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
