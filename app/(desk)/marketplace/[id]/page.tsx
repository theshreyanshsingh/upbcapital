import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { acknowledgeRoadNotice } from "@/actions/buyer";
import { AccessLadder } from "@/components/access-ladder";
import { BidBar } from "@/components/bid-bar";
import { ComingSoonCard } from "@/components/coming-soon-card";
import { CapitalStack, Donut, HorizontalBars } from "@/components/charts";
import { CollateralPanel } from "@/components/collateral-panel";
import { ComplianceNote } from "@/components/compliance-note";
import { CompsPanel } from "@/components/comps-panel";
import { IndicativePrice } from "@/components/indicative-price";
import { DataRoomList } from "@/components/data-room-list";
import { QuestionBoard } from "@/components/listing-questions";
import { DealAnalyzer } from "@/components/deal-analyzer";
import { GroupPanel } from "@/components/group-panel";
import { ListingEconomics } from "@/components/listing-economics";
import { ListingTabs } from "@/components/listing-tabs";
import { bidModeLabel, ListingTimeline } from "@/components/listing-timeline";
import { LoanFacts, LoanFileView } from "@/components/loan-file-view";
import { Notice } from "@/components/notice";
import { OfferPanel } from "@/components/offer-panel";
import { ListingPhotos } from "@/components/photo-manager";
import { PoolTape } from "@/components/pool-tape";
import { StatusPill } from "@/components/status-pill";
import { SellerVerifiedBadge } from "@/components/seller-identity";
import { StrataPanel } from "@/components/strata-panel";
import { SubmitButton } from "@/components/submit-button";
import { TabsContent } from "@/components/ui/tabs";
import { canManageRoom, canReadDocument, dataRoomOpenTo, isPrivateDocument, loanFileAccess, loanOpenTo, ndaOpensRoom } from "@/lib/acl";
import { dealAccess } from "@/lib/data-room";
import { requireUser } from "@/lib/auth";
import { canOpenListing, openableListingIds } from "@/lib/access";
import { buyNowOffer } from "@/lib/buy-now";
import {
  acknowledgementMissing,
  confirmNotices,
  eligibilityFor,
  MARYLAND_HEADING,
  MARYLAND_PROMPT,
  ROAD_HEADING,
  ROAD_NOTICE,
  ROAD_RENT,
  ROAD_UNANSWERED,
  roadAcknowledgement,
  type Eligibility,
} from "@/lib/eligibility";
import { bidStanding, roadAcknowledgedAt } from "@/lib/inquiry";
import { bidEntities } from "@/lib/buyer-entities";
import { compsFor, loadClosedTrades } from "@/lib/comps";
import { loadIndicative } from "@/lib/indicative";
import { enrichListing, notifyIfAuctionClosed, rememberView } from "@/lib/listing-intel";
import { stratify } from "@/lib/strata";
import { num, prettyDate, q } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import { comingSoonCard, launchPending, launchTime } from "@/lib/launch-rules";
import { completeness, fieldState, groupByNote } from "@/lib/loan-file";
import { depositTerms } from "@/lib/closing-clock";
import { diligenceDays } from "@/lib/closing-service";
import { allInYield, noteMetrics, poolMetrics } from "@/lib/metrics";
import { prisma } from "@/lib/prisma";
import { publishedQuestions, questionsAskedBy } from "@/lib/questions";
import { deskWalled, eventSetsTerms } from "@/lib/auction";
import { currentSaleEvent, qaClosed, qaClosedText, roundText, when } from "@/lib/sale-events";
import { EventPaperLinks } from "@/components/event-papers";
import { chargeFees, effectiveBps, feeTerms } from "@/lib/fee-schedule";
import { getSettings, isPro } from "@/lib/settings";
import { canSubmitOffer } from "@/lib/verification";
import { mapPoint, showableAvm } from "@/lib/enrichment";

export const metadata = { title: "Listing" };

const TABS = ["overview", "file", "room", "analysis", "activity"] as const;

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
  const [listing, settings, live] = await Promise.all([
    prisma.listing.findUnique({
      where: { id },
      // Photos aren't data-room files: they show in the gallery, under the street address rule, and nowhere else.
      include: { notes: true, documents: { where: { type: { not: "PHOTO" } } }, seller: true, broker: true, ndas: { where: { userId: user.id } } },
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
    launchAt: listing.launchAt,
  });
  // A coming-soon listing shows buyers its teaser and a save button. Its file, room and bids wait for the launch.
  if (!access.ok && access.reason === "coming" && listing.launchAt) {
    const card = comingSoonCard({ ...listing, launchAt: listing.launchAt });
    const saved = user.role === "BUYER" ? (await prisma.favorite.count({ where: { userId: user.id, listingId: listing.id } })) > 0 : false;
    return (
      <div className="max-w-2xl">
        <Notice notice={q(query, "notice")} error={q(query, "error")} />
        <p className="eyebrow mt-4">Coming soon</p>
        <h1 className="mt-3 font-semibold tracking-tight text-[28px] leading-tight text-foreground">{listing.title}</h1>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          The desk approved this listing to go live on {card.launchLabel}. The confidentiality agreement, the data room and bids open then.
          {user.role === "BUYER" ? " Save it and you'll hear the moment it goes live." : ""}
        </p>
        <div className="mt-6">
          <ComingSoonCard card={card} favorited={saved} canFavorite={user.role === "BUYER"} />
        </div>
      </div>
    );
  }
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

  // The sale event this listing trades in. A round whose date passed moves first, so the line below and the bid
  // form agree on which round is open.
  const saleEvent = listing.saleEventId ? await currentSaleEvent(listing.saleEventId).catch(() => null) : null;
  if (saleEvent?.moved) {
    const terms = await prisma.listing.findUnique({ where: { id: listing.id }, select: { bidMode: true, bidDeadline: true } });
    if (terms) Object.assign(listing, terms);
  }
  // A closed event still names the listing while its terms are the event's, so the dates stay on the page.
  const event = saleEvent?.event && (eventSetsTerms(saleEvent.event.status) || (saleEvent.event.status === "CLOSED" && listing.bidDeadline?.getTime() === saleEvent.event.bestFinalAt.getTime()))
    ? saleEvent.event
    : null;

  // Everything below runs only for someone the access check let in, side by side so the first view comes sooner.
  const [, enriched] = await Promise.all([
    // Desk opens are not buyer interest, and a refused open isn't a view, so neither reaches the seller's counts.
    listing.sellerId !== user.id && user.role !== "ADMIN" ? rememberView(listing.id, user.id) : null,
    // Valuations run only for someone who can open the listing, so a held listing's streets never go to a vendor.
    enrichListing(listing.id),
    notifyIfAuctionClosed(listing.id),
  ]);
  if (enriched) listing.notes = await prisma.note.findMany({ where: { listingId: listing.id } });

  const pro = user.role === "ADMIN" || isPro(user);
  const noteIds = listing.notes.map((note) => note.id);
  const [profile, deal, liveGroup, collateralRows, riskRows, mine, trades, indicative] = await Promise.all([
    user.role === "BUYER" ? prisma.buyerProfile.findUnique({ where: { userId: user.id } }) : null,
    user.role === "BUYER" ? dealAccess(listing.id, user.id) : { whole: false, loans: new Set<string>() },
    prisma.groupBuy.findFirst({
      where: { listingId: listing.id, status: { in: ["GATHERING", "OFFERED", "COUNTERED", "CLOSING"] } },
      include: { positions: { include: { user: true }, orderBy: { seat: "asc" } } },
    }),
    // The verified loan file, one loan at a time. A pool's table carries each loan's summary and links to it.
    prisma.collateralItem.findMany({ where: { noteId: { in: noteIds } }, orderBy: [{ sequence: "asc" }, { createdAt: "asc" }] }),
    prisma.riskCheck.findMany({ where: { noteId: { in: noteIds } }, orderBy: { checkedAt: "desc" } }),
    // A buyer's own bids and requests here. Nobody else's show.
    user.role === "BUYER"
      ? prisma.inquiry.findMany({ where: { listingId: listing.id, buyerId: user.id }, orderBy: { createdAt: "desc" }, take: 20 })
      : Promise.resolve(null),
    // Closed-trade prices are veiled on the free desk like every other price. A failed read shows no panel,
    // rather than an empty one that would read as "no trades".
    pro ? loadClosedTrades().catch(() => null) : Promise.resolve(null),
    // The indicative range is a price, so it is veiled like the ask. A failed read shows nothing rather than a guess.
    // Its standing-bid point is a bid amount, so a desk role behind the sealed-bid wall gets the range without it.
    pro ? loadIndicative(listing.id, undefined, { standing: !deskWalled(listing, user) }).catch(() => null) : Promise.resolve(null),
  ]);
  const verified = canSubmitOffer({
    role: user.role,
    accountStatus: user.accountStatus,
    verificationStatus: profile?.status ?? null,
  }).ok;
  const closingParty = deal.whole || deal.loans.size > 0;
  // An NDA opens the room only once the seller approves it, where they approve each bidder.
  const roomNda = ndaOpensRoom(listing.ndas[0]);
  const unlocked = user.role === "ADMIN" || dataRoomOpenTo({ listingStatus: listing.status, signedNda: roomNda, closingParty });
  const accessWaiting = user.role === "BUYER" && !unlocked && listing.status === "APPROVED" && listing.ndas[0] && !roomNda
    ? listing.ndas[0].accessStatus === "DECLINED" ? "The seller didn't approve your access to this room." : "Waiting for the seller to approve your access."
    : null;
  // A buyer who signed but didn't win sees the room as closed, not an NDA prompt they can no longer use.
  const roomClosed = user.role === "BUYER" && !unlocked && listing.status !== "APPROVED";
  const ownNdaId = listing.ndas[0]?.documentId;
  const dataRoom = listing.documents.filter((document) => document.id === ownNdaId || !isPrivateDocument(document, listing));
  // Street and borrower are decided per loan: one sold out of a pool closes to everyone but its buyer.
  const loanOpen = (note: { id: string; tradeStatus: string }) =>
    user.role === "ADMIN" ||
    loanOpenTo({ tradeStatus: note.tradeStatus, listingStatus: listing.status, signedNda: roomNda, wholeParty: deal.whole, loanParty: deal.loans.has(note.id) });
  const notes = listing.notes.map((note) => ({
    id: note.id,
    open: loanOpen(note),
    streetAddress: loanOpen(note) ? note.streetAddress : "",
    city: note.city,
    state: note.state,
    zip: loanOpen(note) ? note.zip : "",
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
    borrowerName: loanOpen(note) ? note.borrowerName : "",
    memo: loanOpen(note) ? note.memo : "",
    tradeStatus: note.tradeStatus,
    ...mapPoint(note.latitude, note.longitude),
    avm: showableAvm({ avmValue: note.avmValue == null ? null : num(note.avmValue), avmProvider: note.avmProvider }),
  }));
  // A pool sold loan by loan prices only what's left, and can't be bid whole once any loan has traded.
  const forSale = listing.kind === "POOL" && notes.some((note) => note.tradeStatus === "AVAILABLE") ? notes.filter((note) => note.tradeStatus === "AVAILABLE") : notes;
  const wholeOpen = forSale.length === notes.length;
  const pool = poolMetrics(forSale);
  const economics = listing.kind === "POOL" ? pool : noteMetrics(notes[0]);
  const asking = listing.kind === "POOL" ? pool.totalAsk : notes[0].askingPrice;
  const avms = forSale.map((note) => note.avm).filter((value): value is number => value != null);
  // The fees the listing went live with, which the closing will charge. A graded schedule prices the premium on the
  // ask here, and the bid forms price it on the figure the buyer types; premiumBps is the rate it comes to at the ask.
  const listingFees = feeTerms(listing, settings);
  const atAsk = chargeFees(listingFees, asking);
  const premium = atAsk.premiumCents / 100;
  const fees = { premiumBps: effectiveBps(atAsk) };
  // What a winning bidder owes, for the bid confirmation. A 0% deposit says nothing.
  const terms = depositTerms(settings);
  const deposit: [number, number] | undefined = terms.bps > 0 ? [terms.bps / 100, terms.days] : undefined;
  const diligence = diligenceDays(settings.diligenceDays) || undefined;
  const lead = notes[0];
  const stateCounts = countBy(notes.map((note) => note.state));
  const performingSlice = sliceForAnalyzer(forSale);
  const collateralByNote = groupByNote(collateralRows);
  const risksByNote = groupByNote(riskRows);
  const holder = listing.clientSellerName || listing.seller.companyName || listing.seller.name || null;
  const fileNote = listing.notes.find((note) => note.id === q(query, "loan")) ?? listing.notes[0];
  const filePosition = listing.notes.findIndex((note) => note.id === fileNote.id);
  const fileOpen = notes[filePosition]?.open ?? false;
  // The same rule the download route applies to a loan's own files.
  const fileDocsOpen = canReadDocument({
    owner: listing.sellerId === user.id,
    admin: user.role === "ADMIN",
    ownNda: false,
    privateFile: true,
    proBuyer: user.role === "BUYER" && isPro(user),
    signedNda: roomNda,
    listingStatus: listing.status,
    closingParty,
    loan: loanFileAccess({ note: fileNote, listingId: listing.id, listingStatus: listing.status, signedNda: roomNda, wholeParty: deal.whole, loanIds: deal.loans }),
  });
  const loanFileHref = (noteId: string) => `/marketplace/${listing.id}?loan=${noteId}&tab=file#loan-file`;
  const fileHref = (index: number) => (index >= 0 && index < listing.notes.length ? loanFileHref(listing.notes[index].id) : null);
  const rawById = new Map(listing.notes.map((note) => [note.id, note]));
  const fileSummary = (noteId: string) => {
    const raw = rawById.get(noteId);
    return raw ? completeness(raw, collateralByNote.get(noteId) ?? [], risksByNote.get(noteId) ?? [], { holder }) : null;
  };
  const rawLead = listing.notes[0];
  const poolStrata = stratify(notes.map((note) => ({
    state: note.state,
    lien: note.lienPosition,
    status: note.paymentStatus,
    upb: note.upb,
    value: note.estimatedValue,
    rate: note.interestRate,
    monthsDelinquent: note.monthsDelinquent,
  })));
  const compSubject = commonLoan(forSale);
  const comps = trades ? compsFor(compSubject, trades) : null;
  const canOffer = listing.status === "APPROVED" && wholeOpen && user.role === "BUYER";
  // The eligibility screen informs and is logged. Its one ask is the 350-home acknowledgement before a bid.
  const eligibility = eligibilityFor(forSale, profile);
  const acknowledgedAt = user.role === "BUYER" && eligibility.acknowledge ? await roadAcknowledgedAt(user.id, listing.id) : null;
  const acknowledgeFirst = user.role === "BUYER" && acknowledgementMissing(eligibility, acknowledgedAt, profile?.eligibilityAt);
  const notices = confirmNotices(eligibility);
  // The buyer's verified-funds credential and headroom, and any strike pause, for the bid forms.
  const standing = user.role === "BUYER" ? await bidStanding(user.id) : null;
  // The buying entities a bid here can be for: the main file and each one the desk approved.
  const entities = user.role === "BUYER" ? await bidEntities(user.id) : [];
  // Shared Q&A: answers read inside the room, a bidder's own questions, and the form for a bidder in the room.
  const managesRoom = canManageRoom(user, listing);
  const [answered, myQuestions] = await Promise.all([
    publishedQuestions(listing.id),
    user.role === "BUYER" && !managesRoom ? questionsAskedBy(listing.id, user.id) : Promise.resolve(null),
  ]);
  // A loan bid restates only that loan's notices: a pool can hold one non-performing house among performing paper.
  const loanNotices = (noteId: string) => {
    const loan = forSale.find((item) => item.id === noteId);
    return loan ? confirmNotices(eligibilityFor([loan], profile)) : [];
  };
  // Buy it now is the seller's price, so it is veiled on the free desk like the ask: a free buyer learns only that one is set.
  const takeable = buyNowOffer(listing, wholeOpen);
  const buyNow = canOffer && verified && takeable.price != null ? { price: pro ? takeable.price : null, pool: listing.kind === "POOL" } : undefined;
  const deadline = listing.status === "APPROVED" && listing.bidMode !== "NONE" && listing.bidDeadline ? { at: listing.bidDeadline.toISOString(), mode: listing.bidMode } : null;
  const asked = q(query, "tab");
  const fallback = TABS.includes(asked as (typeof TABS)[number]) ? asked : q(query, "loan") ? "file" : "overview";
  const named = (noteId: string | null) => {
    const note = noteId ? notes.find((item) => item.id === noteId) : null;
    if (!note) return null;
    return note.open ? note.streetAddress : `the loan in ${note.city}, ${note.state}`;
  };

  return (
    // Room under the page for a buyer's bid bar, wherever the bar shows.
    <div className={user.role === "BUYER" ? "pb-20 [@media(min-width:64rem)_and_(min-height:50rem)]:pb-0" : undefined}>
      <Notice notice={q(query, "notice")} error={q(query, "error")} />
      <header className="mt-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="eyebrow">{lead?.state} · {listing.kind === "POOL" ? `Pool of ${notes.length}` : `${labelOf("lien", lead.lienPosition)} lien`} · {bidModeLabel(listing.bidMode)}</p>
          <StatusPill status={listing.status} />
          <SellerVerifiedBadge sellerId={listing.sellerId} />
        </div>
        <h1 className="mt-3 font-semibold tracking-tight text-[28px] leading-tight text-foreground">{listing.title}</h1>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">{listing.summary || "No narrative from the seller."}</p>
        {launchPending(listing) && listing.launchAt && (
          <p role="status" className="mt-3 max-w-3xl border border-link/30 bg-link/5 px-3 py-2 text-sm leading-relaxed text-foreground rounded-lg tabular-nums">
            Coming soon. Buyers see a teaser until it goes live on {launchTime(listing.launchAt)}, when the room and bids open.
          </p>
        )}
        {event && (
          <p className="mt-3 max-w-3xl border border-link/30 bg-link/5 px-3 py-2 text-sm leading-relaxed text-foreground rounded-lg tabular-nums">
            In the sale event <Link href={`/events#${event.id}`} className="font-medium text-link">{event.name}</Link>. Indications due {when(event.indicationsAt)}. Best and final due {when(event.bestFinalAt)}. {roundText(event)}
            {event.qaCutoffAt && (qaClosed(event) ? ` ${qaClosedText(event.qaCutoffAt)}` : ` Questions close ${when(event.qaCutoffAt)}.`)}
            {/* The letter and calendar are for buyers, the desk and this listing's own side, as the routes check. */}
            {(user.role === "BUYER" || user.role === "ADMIN" || listing.sellerId === user.id || listing.brokerId === user.id) && <EventPaperLinks eventId={event.id} className="mt-2" />}
          </p>
        )}
        {listing.broker && (
          <p className="mt-2 text-sm text-foreground">
            {listing.brokerRole === "AFFILIATE" ? "Referring affiliate" : "Seller's broker"} {listing.broker.name}
            {listing.broker.companyName ? ` · ${listing.broker.companyName}` : ""}
          </p>
        )}
      </header>
      <ListingPhotos listing={listing} viewer={user} deal={deal} />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <ListingEconomics
            pool={listing.kind === "POOL"}
            listedAt={listing.approvedAt}
            deadline={deadline}
            economics={pro ? {
              asking,
              premium,
              premiumBps: fees.premiumBps,
              upb: listing.kind === "POOL" ? pool.totalUpb : lead.upb,
              priceToUpb: economics.priceToUpb,
              priceToValue: economics.priceToValue,
              ltv: economics.ltv,
              currentYield: economics.currentYield,
              allInYield: allInYield(economics.currentYield, fees.premiumBps),
              loansPriced: forSale.length,
              performing: forSale.filter((note) => note.paymentStatus === "PERFORMING").length,
              salePrice: listing.salePrice == null ? null : num(listing.salePrice),
            } : null}
          />
          <IndicativePrice indicative={indicative} pro={pro} ask={asking} />
          {user.role === "BUYER" && (
            <AccessLadder
              listingId={listing.id}
              listingTitle={listing.title}
              pro={pro}
              verified={verified}
              verificationStatus={profile?.status ?? null}
              unlocked={unlocked}
              roomClosed={roomClosed}
              canSign={!unlocked && !roomClosed && user.role === "BUYER" && !accessWaiting}
              waiting={accessWaiting}
              closingParty={closingParty}
              ndaSigned={unlocked && listing.ndas[0] ? prettyDate(listing.ndas[0].acknowledgedAt) : null}
            />
          )}
          {/* Buyer eligibility is for buyers and the desk. A seller opening their own listing has nothing to answer. */}
          {(user.role === "BUYER" || user.role === "ADMIN") && (eligibility.road || eligibility.maryland) && (
            <EligibilityPanel
              listingId={listing.id}
              eligibility={eligibility}
              buyer={user.role === "BUYER"}
              acknowledgedAt={acknowledgedAt}
              acknowledgeFirst={acknowledgeFirst}
            />
          )}

          <ListingTabs
            fallback={fallback}
            tabs={[
              { value: "overview", label: "Overview" },
              { value: "file", label: "Loan file" },
              { value: "room", label: "Data room", count: dataRoom.length },
              { value: "analysis", label: "Analysis" },
              { value: "activity", label: "Activity" },
            ]}
          >
            <TabsContent value="overview" keepMounted>
              <CollateralPanel
                title={listing.title}
                single={listing.kind === "SINGLE" ? {
                  open: lead.open,
                  streetAddress: lead.streetAddress,
                  city: lead.city,
                  state: lead.state,
                  zip: lead.zip,
                  borrowerName: lead.borrowerName,
                  streetState: fieldState(rawLead, "streetAddress"),
                  borrowerState: fieldState(rawLead, "borrowerName"),
                } : null}
                pool={listing.kind === "POOL" ? { total: notes.length, forSale: forSale.length, unlocked } : null}
                signed={listing.kind === "SINGLE" && unlocked && listing.ndas[0]?.signerName ? `Signed by ${listing.ndas[0].signerName} on ${prettyDate(listing.ndas[0].acknowledgedAt)}.` : null}
                estimate={pro && avms.length > 0 ? {
                  total: avms.reduce((sum, value) => sum + value, 0),
                  count: avms.length,
                  of: forSale.length,
                  provider: listing.notes[0]?.avmProvider || "mock",
                } : null}
                pins={notes.filter((note) => note.latitude != null && note.longitude != null).map((note) => ({
                  id: note.id,
                  title: `${note.city}, ${note.state}`,
                  latitude: note.latitude as number,
                  longitude: note.longitude as number,
                }))}
              />
              {listing.kind === "SINGLE" ? (
                <>
                  <LoanFacts note={rawLead} open={lead.open} pro={pro} withAddress={false} />
                  {lead.memo && <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{lead.memo}</p>}
                </>
              ) : (
                <PoolTape
                  listingId={listing.id}
                  loans={notes}
                  pro={pro}
                  fileHref={loanFileHref}
                  fileSummary={fileSummary}
                  bidding={user.role === "BUYER" ? {
                    deposit,
                    diligenceDays: diligence,
                    premiumBps: fees.premiumBps,
                    fees: listingFees,
                    verified,
                    listingOpen: listing.status === "APPROVED",
                    noticesFor: loanNotices,
                    standing,
                    entities,
                  } : null}
                />
              )}
              <div className="mt-8 max-w-xl">
                <GroupPanel
                  listingId={listing.id}
                  asking={pro || user.role === "ADMIN" ? asking : null}
                  canStart={listing.status === "APPROVED" && wholeOpen && (user.role === "ADMIN" || (user.role === "BUYER" && verified && unlocked))}
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
              </div>
              <ComplianceNote states={notes.map((note) => note.state)} sellerFinanced={listing.sellerFinanced} sellerRole={listing.seller.role} />
            </TabsContent>

            <TabsContent value="file">
              <LoanFileView
                note={fileNote}
                collateral={collateralByNote.get(fileNote.id) ?? []}
                risks={risksByNote.get(fileNote.id) ?? []}
                documents={listing.documents.filter((document) => document.noteId === fileNote.id)}
                open={fileOpen}
                docsOpen={fileDocsOpen}
                docGate={roomClosed || (fileNote.tradeStatus !== "AVAILABLE" && !fileOpen) ? "Closed" : accessWaiting ? "Not open yet" : pro ? "NDA required" : "Pro"}
                holder={holder}
                pro={pro}
                facts={listing.kind === "POOL"}
                heading={listing.kind === "POOL"
                  ? `${fileOpen ? `${fileNote.streetAddress}, ` : ""}${fileNote.city}, ${fileNote.state} · ${labelOf("lien", fileNote.lienPosition)} lien`
                  : `${labelOf("lien", fileNote.lienPosition)} lien in ${fileNote.city}, ${fileNote.state}`}
                nav={listing.kind === "POOL" ? { previous: fileHref(filePosition - 1), next: fileHref(filePosition + 1), position: `Loan ${filePosition + 1} of ${listing.notes.length}` } : undefined}
              />
            </TabsContent>

            <TabsContent value="room">
              <DataRoomList
                documents={dataRoom}
                roomClosed={roomClosed}
                canOpen={(document) => ((pro || closingParty) && unlocked) || document.id === ownNdaId}
                gate={roomClosed ? "Closed" : accessWaiting ? "Not open yet" : pro ? "NDA required" : "Pro"}
              />
              <QuestionBoard
                listingId={listing.id}
                published={answered}
                mine={myQuestions}
                canAsk={user.role === "BUYER" && !managesRoom && listing.status === "APPROVED" && roomNda && !qaClosed(event)}
                inRoom={unlocked || managesRoom}
                waiting={accessWaiting}
                loans={listing.kind === "POOL" ? notes.map((note, index) => ({ id: note.id, label: `Loan ${index + 1} · ${note.open ? `${note.streetAddress}, ` : ""}${note.city}, ${note.state}` })) : []}
              />
            </TabsContent>

            <TabsContent value="analysis" keepMounted>
              {pro && (
                <section aria-labelledby="stack-heading" className="mt-8 glass p-6">
                  <h2 id="stack-heading" className="eyebrow">Capital stack</h2>
                  <div className="mt-5">
                    <CapitalStack
                      value={listing.kind === "POOL" ? pool.totalValue : lead.estimatedValue}
                      upb={listing.kind === "POOL" ? pool.totalUpb : lead.upb}
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
                  // The same premium the header nets out, and the loan's own occupancy and lien for the scenario
                  // weights. A pool's slice mixes loans, so it keeps the model's defaults.
                  premiumBps={fees.premiumBps}
                  occupancy={listing.kind === "POOL" ? null : lead.occupancy}
                  lienPosition={listing.kind === "POOL" ? null : lead.lienPosition}
                  // A single loan's foreclosure clock and live value estimate. A pool's slice has neither.
                  foreclosureFiledAt={listing.kind === "POOL" ? null : listing.notes[0]?.foreclosureFiledAt?.toISOString() ?? null}
                  valueEstimate={listing.kind !== "POOL" && lead.avm != null
                    ? { value: lead.avm, provider: listing.notes[0]?.avmProvider ?? null, asOf: listing.notes[0]?.avmAsOf?.toISOString() ?? null }
                    : null}
                />
              ) : (
                <section className="mt-8 glass p-6">
                  <h2 className="eyebrow">Deal analyzer</h2>
                  <p className="mt-3 text-sm text-muted-foreground">Yield, IRR, cash-on-cash, payback, non-performing resolutions and closed-trade comps open with Pro.</p>
                </section>
              )}
              {listing.kind === "POOL" && pro && (
                <section className="mt-8 grid gap-4 md:grid-cols-2">
                  <div className="glass p-6">
                    <h2 className="eyebrow">Performance mix</h2>
                    <div className="mt-4">
                      <Donut slices={[
                        { label: "Performing", value: pool.performingUpb, color: "var(--chart-1)" },
                        { label: "Sub-performing", value: pool.subUpb, color: "var(--warn)" },
                        { label: "Non-performing", value: pool.nplUpb, color: "var(--bad)" },
                      ]} />
                    </div>
                  </div>
                  <div className="glass p-6">
                    <h2 className="eyebrow">By state</h2>
                    <div className="mt-4">
                      <HorizontalBars rows={stateCounts} />
                    </div>
                  </div>
                </section>
              )}
              {pro && trades && (
                <div className="mt-8">
                  {listing.kind === "POOL" && (
                    <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
                      A pool takes the comps of its most common loan: {labelOf("lien", compSubject.lienPosition).toLowerCase()} lien, {labelOf("payment", compSubject.paymentStatus).toLowerCase()}, {compSubject.state}.
                    </p>
                  )}
                  <CompsPanel
                    comps={comps}
                    state={compSubject.state}
                    ask={asking}
                    upb={listing.kind === "POOL" ? pool.totalUpb : lead.upb}
                    asOf={new Date()}
                  />
                </div>
              )}
            </TabsContent>

            <TabsContent value="activity">
              <ListingTimeline
                events={[
                  { at: listing.approvedAt, label: "Listed on the book" },
                  ...(event
                    ? [
                        { at: event.indicationsAt, label: event.indicationsAt.getTime() < Date.now() ? "Indications closed" : "Indications due", detail: event.name },
                        { at: event.bestFinalAt, label: event.bestFinalAt.getTime() < Date.now() ? "Best and final closed" : "Best and final due", detail: "One bid each" },
                      ]
                    : [{ at: listing.bidDeadline && listing.bidMode !== "NONE" ? listing.bidDeadline : null, label: listing.bidDeadline && listing.bidDeadline.getTime() < Date.now() ? "Bids closed" : "Bids close", detail: bidModeLabel(listing.bidMode) }]),
                  { at: user.role === "BUYER" && listing.ndas[0] ? listing.ndas[0].acknowledgedAt : null, label: "You signed the NDA" },
                  { at: listing.soldAt, label: "Sold" },
                  { at: listing.withdrawnAt, label: "Withdrawn by the seller" },
                ]}
                mine={mine ? mine.map((inquiry) => ({
                  id: inquiry.id,
                  type: inquiry.type,
                  status: inquiry.status,
                  amount: inquiry.amount == null ? null : num(inquiry.amount),
                  createdAt: inquiry.createdAt,
                  expiresAt: inquiry.expiresAt,
                  noteName: named(inquiry.noteId),
                })) : null}
                ownerHref={user.role === "ADMIN" ? `/admin/listings/${listing.id}` : listing.sellerId === user.id ? `/seller/listings/${listing.id}` : null}
              />
            </TabsContent>
          </ListingTabs>
        </div>

        {/* Offer first. The rail stays in view only where it fits; elsewhere it sits in the flow and the bid bar reaches it. */}
        <aside
          id="offer"
          aria-label="Bid"
          className="scroll-mt-6 space-y-4 lg:mt-6 lg:self-start [@media(min-width:64rem)_and_(min-height:50rem)]:sticky [@media(min-width:64rem)_and_(min-height:50rem)]:top-6 [@media(min-width:64rem)_and_(min-height:50rem)]:max-h-[calc(100dvh-3rem)] [@media(min-width:64rem)_and_(min-height:50rem)]:overflow-y-auto"
        >
          <OfferPanel
            listingId={listing.id}
            premiumBps={fees.premiumBps}
            fees={listingFees}
            deposit={deposit}
            diligenceDays={diligence}
            canOffer={canOffer}
            pro={pro}
            verified={verified}
            buyNow={buyNow}
            notices={notices}
            acknowledgeFirst={acknowledgeFirst}
            standing={standing}
            entities={entities}
            heading={listing.kind === "POOL" ? "Bid the whole pool" : undefined}
            loans={listing.kind === "POOL" && canOffer ? notes.map((note, index) => ({ id: note.id, label: `Loan ${index + 1} · ${note.open && note.streetAddress ? `${note.streetAddress}, ` : ""}${note.city}, ${note.state}`, ask: pro ? note.askingPrice : null })) : []}
            closedText={listing.status === "APPROVED" && !wholeOpen ? "Some loans in this pool have traded, so it can't be bid whole. Bid the loans still for sale in the table." : undefined}
          />
          <p className="text-xs leading-relaxed text-muted-foreground">Listed by {listing.seller.companyName || listing.seller.name}. An accepted bid opens a closing checklist with the premium and commission on the all-in total.</p>
        </aside>
      </div>
      {user.role === "BUYER" && (
        <BidBar
          asking={pro ? asking : null}
          priceToUpb={pro ? economics.priceToUpb : null}
          canOffer={canOffer}
          verified={verified}
          buyNow={buyNow?.price ?? null}
          acknowledgeFirst={acknowledgeFirst}
        />
      )}
    </div>
  );
}

// The federal notice and the Maryland prompt, with the 350-home acknowledgement for a buyer who needs to give it.
// Nothing here stops a bid on its own; the acknowledgement is asked once per listing and logged.
function EligibilityPanel({
  listingId,
  eligibility,
  buyer,
  acknowledgedAt,
  acknowledgeFirst,
}: {
  listingId: string;
  eligibility: Eligibility;
  buyer: boolean;
  acknowledgedAt: Date | null;
  acknowledgeFirst: boolean;
}) {
  const [stated, acknowledgement] = roadAcknowledgement(eligibility.homes ?? 0);
  return (
    <section id="eligibility" aria-labelledby="eligibility-heading" className="mt-6 scroll-mt-6 border border-border p-5 rounded-xl">
      <h2 id="eligibility-heading" className="eyebrow">Buyer eligibility</h2>
      {eligibility.road && (
        <div className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
          <p className="text-[13px] font-semibold text-foreground">{ROAD_HEADING}</p>
          <p>{ROAD_NOTICE.join(" ")}</p>
          {buyer && eligibility.holdToRent && <p className="text-foreground">{ROAD_RENT}</p>}
          {buyer && eligibility.unanswered && (
            <p>
              {ROAD_UNANSWERED} <Link href="/buyer/verification#eligibility" className="text-link">Answer in your buyer file</Link>.
            </p>
          )}
          {buyer && eligibility.acknowledge && (acknowledgeFirst ? (
            <form action={acknowledgeRoadNotice} className="space-y-3 border-t border-border pt-3">
              <input type="hidden" name="listingId" value={listingId} />
              <p>{stated}</p>
              <label className="flex items-start gap-3 text-foreground">
                <input type="checkbox" name="acknowledged" value="yes" required className="mt-1" />
                <span>{acknowledgement}</span>
              </label>
              <SubmitButton className="h-10 text-[13px] font-medium" pendingLabel="Saving…">Acknowledge and continue</SubmitButton>
            </form>
          ) : (
            <p className="text-foreground">You acknowledged this notice on {prettyDate(acknowledgedAt)}.</p>
          ))}
        </div>
      )}
      {eligibility.maryland && (
        <div className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
          <p className="text-[13px] font-semibold text-foreground">{MARYLAND_HEADING}</p>
          <p>{MARYLAND_PROMPT.join(" ")}</p>
        </div>
      )}
    </section>
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

// The state, lien and performance most of the loans for sale share, for the comps a listing reads.
function commonLoan(notes: { state: string; lienPosition: string; paymentStatus: string }[]) {
  const counts = new Map<string, { state: string; lienPosition: string; paymentStatus: string; count: number }>();
  for (const note of notes) {
    const key = `${note.state}|${note.lienPosition}|${note.paymentStatus}`;
    const row = counts.get(key) ?? { state: note.state, lienPosition: note.lienPosition, paymentStatus: note.paymentStatus, count: 0 };
    row.count += 1;
    counts.set(key, row);
  }
  const top = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  return { state: top?.state ?? "", lienPosition: top?.lienPosition ?? "", paymentStatus: top?.paymentStatus ?? "" };
}

function countBy(values: string[]) {
  const map = new Map<string, number>();
  values.forEach((value) => map.set(value, (map.get(value) ?? 0) + 1));
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value }));
}
