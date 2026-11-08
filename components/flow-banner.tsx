import { launchTime } from "@/lib/launch-rules";

// The listing page's line while a tranche is in its programme's first look, for everyone who can see it then.
export function FirstLookBanner({ endsAt, programName }: { endsAt: Date; programName: string }) {
  return (
    <p role="status" className="mt-3 max-w-3xl rounded-lg border border-link/30 bg-link/5 px-3 py-2 text-sm leading-relaxed text-foreground tabular-nums">
      First look for programme buyers until {launchTime(endsAt)}. This is a tranche of {programName}, and it opens to the market after that.
    </p>
  );
}
