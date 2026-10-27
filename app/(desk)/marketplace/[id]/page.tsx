import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CapitalStack, Donut, HorizontalBars, LockedStat, RatioRing } from "@/components/charts";
import { ComplianceNote } from "@/components/compliance-note";
import { Countdown } from "@/components/countdown";
import { DealAnalyzer } from "@/components/deal-analyzer";
import { LoanBid } from "@/components/loan-bid";
import { NdaDialog } from "@/components/nda-dialog";
import { Notice } from "@/components/notice";
import { GroupPanel } from "@/components/group-panel";
import { OfferPanel } from "@/components/offer-panel";
import { StatusPill } from "@/components/status-pill";
import { StrataPanel } from "@/components/strata-panel";
import { UsMap } from "@/components/us-map";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isPrivateDocument } from "@/lib/acl";
import { requireUser } from "@/lib/auth";
import { canOpenListing, openableListingIds } from "@/lib/access";
import { enrichListing, notifyIfAuctionClosed, rememberView } from "@/lib/listing-intel";
import { stratify } from "@/lib/strata";
import { money, num, pct, prettyDate, q } from "@/lib/format";
import { docLabel, labelOf } from "@/lib/labels";
import { noteMetrics, poolMetrics } from "@/lib/metrics";
import { bpsToPercent } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { getSettings, isPro } from "@/lib/settings";
import { canSubmitOffer } from "@/lib/verification";

export const metadata = { title: "Listing" };

export default async function ListingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const user = await requireUser();
  if (user.role === "BUYER" && user.accountStatus !== "APPROVED") redirect("/buyer/pending");
  await enrichListing(id);
  await notifyIfAuctionClosed(id);
  const [listing, settings, live] = await Promise.all([
    prisma.listing.findUnique({
      where: { id },
      include: { notes: true, documents: true, seller: true, broker: true, ndas: { where: { userId: user.id } } },
    }),
    getSettings(),
    prisma.listing.findMany({
      where: { status: { in: ["APPROVED", "PENDING"] } },
      select: { id: true, status: true, approvedAt: true },
    }),
  ]);
  if (!listing) notFound();
  const openable = openableListingIds(live, settings.earlyAccessHours, settings.freeBrowseLimit);
  const access = canOpenListing({
    viewer: user,
    status: listing.status,
    approvedAt: listing.approvedAt,
    earlyAccessHours: settings.earlyAccessHours,
    openableIds: openable,
    listingId: listing.id,
    sellerId: listing.sellerId,
    brokerId: listing.brokerId,
  });
  if (listing.sellerId !== user.id) await rememberView(listing.id, user.id);
  if (!access.ok) {
    const copy = access.reason === "early"
      ? `This listing is inside the ${settings.earlyAccessHours}-hour early-access window.`
      : access.reason === "limit"
        ? `Free membership opens ${settings.freeBrowseLimit} listings. This one sits outside that slice.`
        : "This listing is not on the open book.";
    return (
      <div className="max-w-xl">
        <p className="eyebrow">Held</p>
        <h1 className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">{listing.title}</h1>
        <p className="mt-4 text-muted-foreground">{copy}</p>
        <Link href="/buyer/subscription" className="mt-6 inline-flex h-11 items-center bg-primary px-5 text-[13px] font-medium text-primary-foreground rounded-lg">See Pro</Link>
      </div>
    );
  }

  const pro = user.role === "ADMIN" || isPro(user);
  const profile = user.role === "BUYER" ? await prisma.buyerProfile.findUnique({ where: { userId: user.id } }) : null;
  const verified = canSubmitOffer({
    role: user.role,
    accountStatus: user.accountStatus,
    verificationStatus: profile?.status ?? null,
  }).ok;
  const unlocked = user.role === "ADMIN" || listing.ndas.length > 0;
  const ownNdaId = listing.ndas[0]?.documentId;
  const dataRoom = listing.documents.filter((document) => document.id === ownNdaId || !isPrivateDocument(document, listing));
  const notes = listing.notes.map((note) => ({
    id: note.id,
    streetAddress: unlocked ? note.streetAddress : "",
    city: note.city,
    state: note.state,
    zip: unlocked ? note.zip : "",
    propertyType: note.propertyType,
    occupancy: note.occupancy,
    estimatedValue: num(note.estimatedValue),
    lienPosition: note.lienPosition,
    upb: num(note.upb),
    interestRate: num(note.interestRate),
    monthlyPi: num(note.monthlyPi),
    paymentStatus: note.paymentStatus,
    monthsDelinquent: note.monthsDelinquent,
    lastPaidDate: note.lastPaidDate?.toISOString() ?? null,
    originationDate: note.originationDate?.toISOString() ?? null,
    maturityDate: note.maturityDate?.toISOString() ?? null,
    askingPrice: num(note.askingPrice),
    foreclosureStatus: note.foreclosureStatus,
    borrowerName: unlocked ? note.borrowerName : "",
    memo: note.memo,
    tradeStatus: note.tradeStatus,
    latitude: note.latitude,
    longitude: note.longitude,
    avm: note.avmValue == null ? null : num(note.avmValue),
  }));
  const economics = listing.kind === "POOL" ? poolMetrics(notes) : noteMetrics(notes[0]);
  const asking = listing.kind === "POOL" ? poolMetrics(notes).totalAsk : notes[0].askingPrice;
  const liveGroup = await prisma.groupBuy.findFirst({
    where: { listingId: listing.id, status: { in: ["GATHERING", "OFFERED", "COUNTERED", "CLOSING"] } },
    include: { positions: { include: { user: true }, orderBy: { seat: "asc" } } },
  });
  const premium = (asking * settings.buyerPremiumBps) / 10000;
  const lead = notes[0];
  const stateCounts = countBy(notes.map((note) => note.state));
  const performingSlice = sliceForAnalyzer(notes);
  const poolStrata = stratify(notes.map((note) => ({
    state: note.state,
    lien: note.lienPosition,
    status: note.paymentStatus,
    upb: note.upb,
    value: note.estimatedValue,
    rate: note.interestRate,
    monthsDelinquent: note.monthsDelinquent,
  })));

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div>
        <Notice notice={q(query, "notice")} error={q(query, "error")} />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="eyebrow">{lead?.state} · {listing.kind === "POOL" ? "Pool" : labelOf("lien", lead.lienPosition)}</p>
          <StatusPill status={listing.status} />
        </div>
        <h1 className="mt-4 font-semibold tracking-tight text-[28px] leading-none text-foreground">{listing.title}</h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">{listing.summary || "No narrative from the seller."}</p>
        {listing.broker && (
          <p className="mt-3 text-sm text-foreground">
            {listing.brokerRole === "AFFILIATE" ? "Referring affiliate" : "Seller's broker"} {listing.broker.name}
            {listing.broker.companyName ? ` · ${listing.broker.companyName}` : ""}
          </p>
        )}
        <ComplianceNote states={notes.map((note) => note.state)} sellerFinanced={listing.sellerFinanced} sellerRole={listing.seller.role} />
        {!pro && (
          <p className="mt-6 border border-link/30 bg-link/5 px-4 py-3 text-sm text-foreground rounded-xl">
            You are on the free desk. Ratios, balances, and the data room open with Pro.
          </p>
        )}
        {pro ? (
          <div className="mt-8 grid gap-4 md:grid-cols-2">
            <RatioRing label="Price / UPB" value={"priceToUpb" in economics ? economics.priceToUpb : null} caption="Asking price as a percent of unpaid principal." />
            <RatioRing label="Price / value" value={"priceToValue" in economics ? economics.priceToValue : null} caption="Asking price as a percent of estimated property value." />
            <RatioRing label="LTV" value={economics.ltv} caption="Unpaid principal divided by estimated value." />
            <RatioRing label="Est. yield" value={economics.currentYield} caption={economics.currentYield == null ? "Shown on performing paper only." : "Annual payments divided by asking price."} />
          </div>
        ) : (
          <div className="mt-8 grid gap-4 md:grid-cols-2">
            <LockedStat label="Price / UPB" />
            <LockedStat label="Price / value" />
            <LockedStat label="LTV" />
            <LockedStat label="Estimated yield" />
          </div>
        )}

        <section className="mt-10 glass p-6">
          <p className="eyebrow">Collateral</p>
          {listing.kind === "SINGLE" ? (
            <>
              <p className="mt-3 font-semibold tracking-tight text-3xl text-foreground">{unlocked ? lead.streetAddress : "Street withheld"}</p>
              <p className="mt-2 text-muted-foreground">{lead.city}, {lead.state}{unlocked && lead.zip ? ` ${lead.zip}` : ""}</p>
              <p className="mt-4 text-sm text-muted-foreground">Borrower: {unlocked ? lead.borrowerName || "Not provided" : "Withheld until confidentiality"}</p>
              {!unlocked && user.role === "BUYER" && <div className="mt-5"><NdaDialog listingId={listing.id} listingTitle={listing.title} /></div>}
              {unlocked && listing.ndas[0]?.signerName && (
                <p className="mt-4 text-sm text-muted-foreground">Signed by {listing.ndas[0].signerName} on {prettyDate(listing.ndas[0].acknowledgedAt)}.</p>
              )}
            </>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">{notes.length} loans. {unlocked ? "Addresses are open." : "Street addresses open after confidentiality."}</p>
          )}
          {listing.kind === "SINGLE" && !unlocked && user.role === "ADMIN" ? null : null}
          {listing.kind === "POOL" && !unlocked && user.role === "BUYER" && <div className="mt-5"><NdaDialog listingId={listing.id} listingTitle={listing.title} /></div>}
          {pro && lead.avm != null && (
            <p className="mt-4 text-sm text-muted-foreground">Value estimate {money(lead.avm)} · {listing.notes[0]?.avmProvider || "mock"}</p>
          )}
          <div className="mt-5">
            <UsMap
              label={`Map for ${listing.title}`}
              pins={notes.filter((note) => note.latitude != null && note.longitude != null).map((note) => ({
                id: note.id,
                title: `${note.city}, ${note.state}`,
                latitude: note.latitude as number,
                longitude: note.longitude as number,
              }))}
            />
          </div>
        </section>

        {pro && (
          <section className="mt-8 glass p-6">
            <p className="eyebrow">Capital stack</p>
            <div className="mt-5">
              <CapitalStack
                value={listing.kind === "POOL" ? poolMetrics(notes).totalValue : lead.estimatedValue}
                upb={listing.kind === "POOL" ? poolMetrics(notes).totalUpb : lead.upb}
                price={asking}
              />
            </div>
          </section>
        )}

        {listing.kind === "POOL" && pro && (
          <StrataPanel
            count={poolStrata.count}
            totalUpb={poolStrata.totalUpb}
            wac={poolStrata.wac}
            waltv={poolStrata.waltv}
            weightedDelinquency={poolStrata.weightedDelinquency}
            exportBase={`/api/listings/${listing.id}/export`}
            groups={[
              { title: "State", rows: poolStrata.byState },
              { title: "Lien", rows: poolStrata.byLien },
              { title: "Status", rows: poolStrata.byStatus },
              { title: "UPB", rows: poolStrata.byUpb },
              { title: "LTV", rows: poolStrata.byLtv },
              { title: "Coupon", rows: poolStrata.byCoupon },
            ]}
          />
        )}

        {pro ? (
          <DealAnalyzer
            listingId={listing.id}
            title={performingSlice.performing ? "Performing case" : "Resolution cases"}
            performing={performingSlice.performing}
            upb={performingSlice.upb}
            annualRate={performingSlice.rate}
            monthlyPi={performingSlice.monthlyPi}
            termMonths={performingSlice.term}
            value={performingSlice.value}
            monthsDelinquent={performingSlice.monthsDelinquent}
            state={lead.state}
            defaultBid={performingSlice.ask || asking}
          />
        ) : (
          <section className="mt-8 glass p-6">
            <p className="eyebrow">Deal analyzer</p>
            <p className="mt-3 text-sm text-muted-foreground">Yield, IRR, cash-on-cash, payback, and non-performing resolutions open with Pro.</p>
          </section>
        )}

        {listing.kind === "POOL" && pro && (
          <section className="mt-8 grid gap-4 md:grid-cols-2">
            <div className="glass p-6">
              <p className="eyebrow">Performance mix</p>
              <div className="mt-4">
                <Donut slices={[
                  { label: "Performing", value: poolMetrics(notes).performingUpb, color: "var(--chart-1)" },
                  { label: "Sub-performing", value: poolMetrics(notes).subUpb, color: "var(--warn)" },
                  { label: "Non-performing", value: poolMetrics(notes).nplUpb, color: "var(--bad)" },
                ]} />
              </div>
            </div>
            <div className="glass p-6">
              <p className="eyebrow">By state</p>
              <div className="mt-4">
                <HorizontalBars rows={stateCounts} />
              </div>
            </div>
          </section>
        )}

        {listing.kind === "SINGLE" ? (
          <Facts note={lead} showMetrics={pro} />
        ) : (
          <div className="mt-8">
            <Tabs defaultValue="tape">
              <TabsList variant="line">
                <TabsTrigger value="tape">Loan tape</TabsTrigger>
                <TabsTrigger value="story">Seller notes</TabsTrigger>
              </TabsList>
              <TabsContent value="tape" className="mt-4 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="text-xs font-medium text-muted-foreground">
                    <tr>
                      {["Collateral", "Lien", "Status", "UPB", "Ask", "Value", "Trade"].concat(user.role === "BUYER" ? ["Bid"] : []).map((heading) => <th key={heading} className="px-3 py-2 font-normal">{heading}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {notes.map((note) => (
                      <tr key={note.id} className="border-t border-border">
                        <td className="px-3 py-3 text-foreground">{unlocked ? note.streetAddress : "Withheld"}<span className="block text-xs text-muted-foreground">{note.city}, {note.state}</span></td>
                        <td className="px-3 py-3">{labelOf("lien", note.lienPosition)}</td>
                        <td className="px-3 py-3">{labelOf("payment", note.paymentStatus)}</td>
                        <td className="px-3 py-3">{pro ? money(note.upb) : "—"}</td>
                        <td className="px-3 py-3">{pro ? money(note.askingPrice) : "—"}</td>
                        <td className="px-3 py-3">{pro ? money(note.estimatedValue) : "—"}</td>
                        <td className="px-3 py-3 text-[13px] font-medium text-muted-foreground">{note.tradeStatus.replaceAll("_", " ").toLowerCase()}</td>
                        {user.role === "BUYER" && (
                          <td className="px-3 py-3">
                            <LoanBid
                              listingId={listing.id}
                              noteId={note.id}
                              premiumBps={settings.buyerPremiumBps}
                              verified={verified}
                              closed={listing.status !== "APPROVED" || note.tradeStatus !== "AVAILABLE"}
                            />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TabsContent>
              <TabsContent value="story" className="mt-4 text-sm leading-relaxed text-muted-foreground">{listing.summary}</TabsContent>
            </Tabs>
          </div>
        )}

        <section className="mt-10">
          <p className="eyebrow">Data room</p>
          <ul className="mt-4 divide-y divide-border border border-border rounded-xl">
            {dataRoom.length === 0 && <li className="px-4 py-4 text-sm text-muted-foreground">No documents uploaded.</li>}
            {dataRoom.map((document) => (
              <li key={document.id} className="flex items-center justify-between gap-3 px-4 py-4">
                <div>
                  <p className="text-sm text-foreground">{document.originalName}</p>
                  <p className="text-[13px] font-medium text-muted-foreground">{docLabel(document.type)}</p>
                </div>
                {(pro && unlocked) || document.id === ownNdaId ? (
                  <a className="text-[13px] font-medium text-link" href={`/api/documents/${document.id}`}>Download</a>
                ) : (
                  <span className="text-[13px] font-medium text-muted-foreground">{pro ? "NDA required" : "Pro"}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <aside className="space-y-4 lg:sticky lg:top-8 lg:self-start">
        <div className="glass p-6">
          <p className="eyebrow">Buyer economics</p>
          {pro ? (
            <>
              <p className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">{money(asking)}</p>
              <p className="text-[13px] font-medium text-muted-foreground">Asking price</p>
              {listing.bidMode !== "NONE" && listing.bidDeadline && (
                <div className="mt-4">
                  <Countdown deadline={listing.bidDeadline.toISOString()} mode={listing.bidMode} />
                </div>
              )}
              <dl className="mt-5 space-y-2 text-sm">
                <Line k={`Premium ${bpsToPercent(settings.buyerPremiumBps).toFixed(2)}%`} v={money(premium)} />
                <Line k="All-in if accepted here" v={money(asking + premium)} />
                {listing.salePrice && <Line k="Settled price" v={money(num(listing.salePrice))} />}
              </dl>
            </>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">The ask, the premium, and the all-in price are visible on Pro.</p>
          )}
        </div>
        <GroupPanel
          listingId={listing.id}
          asking={asking}
          canStart={listing.status === "APPROVED" && (user.role === "ADMIN" || (user.role === "BUYER" && verified && unlocked))}
          viewer={{ id: user.id, role: user.role }}
          group={liveGroup ? {
            id: liveGroup.id,
            status: liveGroup.status,
            targetAmount: Number(liveGroup.targetAmount),
            deadline: liveGroup.deadline,
            positions: liveGroup.positions.map((seat) => ({
              id: seat.id,
              userId: seat.userId,
              seat: seat.seat,
              amount: Number(seat.amount),
              percent: Number(seat.percent),
              slice: seat.slice,
              status: seat.status,
              name: seat.user.name,
            })),
          } : null}
        />
        <OfferPanel
          listingId={listing.id}
          premiumBps={settings.buyerPremiumBps}
          canOffer={listing.status === "APPROVED" && user.role === "BUYER"}
          pro={pro}
          verified={verified}
          heading={listing.kind === "POOL" ? "Bid the whole pool" : undefined}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">Listed by {listing.seller.companyName || listing.seller.name}. An accepted bid opens a closing checklist with the premium and commission on the all-in total.</p>
      </aside>
    </div>
  );
}

function Facts({ note, showMetrics }: { note: { propertyType: string; occupancy: string; lienPosition: string; paymentStatus: string; monthsDelinquent: number; foreclosureStatus: string; interestRate: number; monthlyPi: number; upb: number; estimatedValue: number; lastPaidDate: string | null; originationDate: string | null; maturityDate: string | null; memo: string }; showMetrics: boolean }) {
  const rows = [
    ["Property", labelOf("property", note.propertyType)],
    ["Occupancy", labelOf("occupancy", note.occupancy)],
    ["Lien", labelOf("lien", note.lienPosition)],
    ["Performance", labelOf("payment", note.paymentStatus)],
    ["Months delinquent", String(note.monthsDelinquent)],
    ["Foreclosure", labelOf("foreclosure", note.foreclosureStatus)],
    ["Note rate", showMetrics ? pct(note.interestRate, 3) : "—"],
    ["Monthly P&I", showMetrics ? money(note.monthlyPi) : "—"],
    ["UPB", showMetrics ? money(note.upb) : "—"],
    ["Estimated value", showMetrics ? money(note.estimatedValue) : "—"],
    ["Last paid", prettyDate(note.lastPaidDate)],
    ["Origination", prettyDate(note.originationDate)],
    ["Maturity", prettyDate(note.maturityDate)],
  ];
  return (
    <section className="mt-8">
      <p className="eyebrow">The note</p>
      <dl className="mt-4 grid gap-px bg-muted sm:grid-cols-2">
        {rows.map(([key, value]) => (
          <div key={key} className="bg-card/80 px-4 py-3">
            <dt className="text-xs font-medium text-muted-foreground">{key}</dt>
            <dd className="mt-1 text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      {note.memo && <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{note.memo}</p>}
    </section>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border py-2">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-foreground">{v}</dd>
    </div>
  );
}

function sliceForAnalyzer(notes: { upb: number; askingPrice: number; interestRate: number; monthlyPi: number; estimatedValue: number; paymentStatus: string; monthsDelinquent: number; maturityDate: string | null }[]) {
  const scope = notes.every((note) => note.paymentStatus === "PERFORMING")
    ? notes
    : notes.filter((note) => note.paymentStatus !== "PERFORMING");
  const rows = scope.length ? scope : notes;
  const upb = rows.reduce((sum, note) => sum + note.upb, 0);
  const rate = upb > 0 ? rows.reduce((sum, note) => sum + note.interestRate * note.upb, 0) / upb : 0;
  const maturity = rows.map((note) => note.maturityDate).find(Boolean);
  const term = maturity
    ? Math.max(1, Math.min(480, Math.round((new Date(maturity).getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30.44))))
    : 360;
  return {
    performing: rows.every((note) => note.paymentStatus === "PERFORMING"),
    upb,
    rate,
    ask: rows.reduce((sum, note) => sum + note.askingPrice, 0),
    monthlyPi: rows.reduce((sum, note) => sum + note.monthlyPi, 0),
    value: rows.reduce((sum, note) => sum + note.estimatedValue, 0),
    monthsDelinquent: upb > 0 ? rows.reduce((sum, note) => sum + note.monthsDelinquent * note.upb, 0) / upb : 0,
    term,
  };
}

function countBy(values: string[]) {
  const map = new Map<string, number>();
  values.forEach((value) => map.set(value, (map.get(value) ?? 0) + 1));
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
}
