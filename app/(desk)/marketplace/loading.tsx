import { IntroSkeleton, Loading as Wait, Skeleton } from "@/components/ui/skeleton";

// The book while it loads: the filter bar, a row of chips and listing cards where the cards will be.
export default function Loading() {
  return (
    <Wait>
      <IntroSkeleton />
      <Skeleton className="h-13 w-full rounded-xl md:h-36" />
      <div className="mt-4 flex gap-2 overflow-hidden">
        {[0, 1, 2, 3].map((chip) => (
          <Skeleton key={chip} className="h-9 w-28 shrink-0 rounded-full" />
        ))}
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((card) => (
          <div key={card} className="glass p-5 sm:p-6">
            <div className="flex justify-between">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-5 w-12 rounded-full" />
            </div>
            <Skeleton className="mt-4 h-5 w-3/4" />
            <Skeleton className="mt-3 h-3.5 w-2/3" />
            <div className="mt-6 flex items-end justify-between border-t border-border pt-4">
              <Skeleton className="h-8 w-16" />
              <Skeleton className="h-3.5 w-24" />
            </div>
          </div>
        ))}
      </div>
    </Wait>
  );
}
