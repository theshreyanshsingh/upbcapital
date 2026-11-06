import { cn } from "cn"

// A placeholder block in the shape of what's loading. It pulses unless reduced motion is set.
function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden data-slot="skeleton" className={cn("animate-pulse rounded-md bg-muted", className)} />
}

// The page header every desk page opens with: the eyebrow, the title and a line of lede.
function IntroSkeleton() {
  return (
    <div className="mb-6 max-w-3xl sm:mb-8">
      <Skeleton className="h-3.5 w-24" />
      <Skeleton className="mt-3 h-8 w-3/4 max-w-md rounded-lg" />
      <Skeleton className="mt-4 h-4 w-full max-w-xl" />
      <Skeleton className="mt-2 h-4 w-2/3 max-w-sm" />
    </div>
  )
}

// Announces the wait to a screen reader once; the shapes themselves are hidden from it.
function Loading({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading</span>
      {children}
    </div>
  )
}

export { IntroSkeleton, Loading, Skeleton }
