import { IntroSkeleton, Loading as Wait, Skeleton } from "@/components/ui/skeleton";

// Shown the moment a desk link or tab is tapped, in the shape of a desk page: the header, then a list.
export default function Loading() {
  return (
    <Wait>
      <IntroSkeleton />
      <div className="glass divide-y divide-border">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex items-start gap-3 p-4 sm:p-5">
            <Skeleton className="mt-1 size-8 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="mt-2.5 h-3.5 w-4/5" />
            </div>
          </div>
        ))}
      </div>
    </Wait>
  );
}
