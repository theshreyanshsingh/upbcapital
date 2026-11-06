import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

// One primary (ink) per panel, outline for the rest, destructive for what can't be undone. Focus is the
// global 2px accent ring from globals.css; the press is a 1px settle at the feedback speed. On a touch screen
// every size grows to at least a finger's height; a minimum, so a button set taller by its caller stays taller.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,opacity,translate] duration-(--dur-1) ease-(--ease-standard) outline-none select-none active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-card hover:bg-primary/88",
        outline:
          "border-border bg-card text-foreground shadow-card hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-active aria-expanded:bg-active aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/15 dark:bg-destructive/15 dark:hover:bg-destructive/20",
        link: "text-link underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-3 pointer-coarse:min-h-10 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 pointer-coarse:min-h-8 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 pointer-coarse:min-h-9 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8125rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 pointer-coarse:min-h-11 gap-1.5 px-3.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-8 pointer-coarse:min-h-10 pointer-coarse:min-w-10",
        "icon-xs":
          "size-6 pointer-coarse:min-h-8 pointer-coarse:min-w-8 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 pointer-coarse:min-h-9 pointer-coarse:min-w-9 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
