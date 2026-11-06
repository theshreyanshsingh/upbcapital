import { Loading as Wait, Skeleton } from "@/components/ui/skeleton";

// A listing while it loads: the title, the buyer economics panel and the section tabs.
export default function Loading() {
  return (
    <Wait>
      <Skeleton className="h-3.5 w-40" />
      <Skeleton className="mt-3 h-8 w-4/5 max-w-lg rounded-lg" />
      <Skeleton className="mt-4 h-4 w-full max-w-xl" />
      <div className="glass mt-6 grid max-w-3xl grid-cols-2 gap-x-6 gap-y-5 p-5 sm:p-6">
        {[0, 1, 2, 3].map((figure) => (
          <div key={figure}>
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="mt-2 h-6 w-24" />
          </div>
        ))}
      </div>
      <div className="mt-8 flex gap-5 border-b border-border pb-3">
        {[0, 1, 2].map((tab) => (
          <Skeleton key={tab} className="h-4 w-20" />
        ))}
      </div>
    </Wait>
  );
}
