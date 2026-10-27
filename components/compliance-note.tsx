import { DODD_FRANK, SAFE_ACT, showsOriginationReminder } from "@/lib/compliance";
import { prisma } from "@/lib/prisma";

export async function ComplianceNote({
  states,
  sellerFinanced,
  sellerRole,
}: {
  states: string[];
  sellerFinanced: boolean;
  sellerRole: string;
}) {
  const unique = [...new Set(states.map((state) => state.toUpperCase()).filter(Boolean))];
  const rows = unique.length ? await prisma.stateDisclosure.findMany({ where: { state: { in: unique } } }) : [];
  const origin = showsOriginationReminder({ sellerFinanced, sellerRole });
  if (!rows.length && !origin) return null;
  return (
    <section className="mt-8 border border-border p-5 rounded-xl">
      <p className="eyebrow">Disclosures</p>
      <div className="mt-4 space-y-4 text-sm leading-relaxed text-muted-foreground">
        {rows.map((row) => (
          <div key={row.state}>
            <p className="text-[13px] font-semibold text-foreground">{row.state}{row.license ? ` · ${row.license}` : ""}</p>
            <p className="mt-2">{row.body}</p>
          </div>
        ))}
        {origin && (
          <>
            <p>{DODD_FRANK}</p>
            <p>{SAFE_ACT}</p>
          </>
        )}
      </div>
    </section>
  );
}
