import type { Metadata } from "next";
import { PublicPage } from "@/components/public-page";
import { BUYER_SCOPES, SCOPE_LABELS } from "@/lib/api-keys";
import { API_LIMIT } from "@/lib/api-limit";
import { PAGE_LIMIT } from "@/lib/buyer-api";
import { BUYER_WEBHOOK_EVENTS } from "@/lib/webhooks";

export const metadata: Metadata = {
  title: "API",
  description: "Institutional sellers push tapes and read offers. Pro buyers read live listings, buy-box matches, their own inquiries and holdings, with signed webhooks.",
};

const APP = process.env.NEXT_PUBLIC_APP_URL || "";
const ID = "cm3k9x2ab0001";
const web = `${APP}/marketplace/${ID}`;

function Example({ label, children }: { label: string; children: unknown }) {
  return (
    <div>
      <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
      <pre className="mt-2 overflow-x-auto rounded-xl border border-border bg-muted/40 p-4 font-mono text-[12.5px] leading-relaxed text-foreground">
        {typeof children === "string" ? children : JSON.stringify(children, null, 2)}
      </pre>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="pt-6 text-2xl font-semibold tracking-tight text-foreground">{children}</h2>;
}

function Endpoint({ children }: { children: React.ReactNode }) {
  return <h3 className="pt-2 font-mono text-[15px] font-medium text-foreground">{children}</h3>;
}

const summary = {
  id: ID,
  title: "Orlando SFR first lien",
  kind: "SINGLE",
  status: "APPROVED",
  private: false,
  loanCount: 1,
  loansForSale: 1,
  states: ["FL"],
  lienPositions: ["FIRST"],
  paymentStatuses: ["NON_PERFORMING"],
  upb: 182400,
  askingPrice: 118000,
  estimatedValue: 265000,
  ltv: 68.83,
  priceToUpb: 64.69,
  currentYield: null,
  noteRate: 6.25,
  buyNowPrice: null,
  saleFormat: "SEALED",
  bidDeadline: "2026-11-20T21:00:00.000Z",
  approvedAt: "2026-11-02T15:04:00.000Z",
  updatedAt: "2026-11-08T09:12:44.000Z",
  webUrl: web,
};

export default function DevelopersPage() {
  return (
    <PublicPage title="The UPB API." lede="Institutional sellers push tapes and read the bids on them. Pro buyers read the live book, their buy-box matches, their own inquiries and their holdings. Keys are stored as a hash and sent as a bearer token.">
      <Heading>Keys and limits</Heading>
      <p>Send every request with Authorization: Bearer upb_… . Sellers mint keys at Seller API. Pro buyers mint them at Buyer API, which needs Pro, a live trial included, and a buyer file the desk approved. A key belongs to the account, so every seat on a firm&apos;s account reads the same thing through it.</p>
      <p>Each key may make {API_LIMIT.requests} requests a minute. Past that, the API answers 429 with a Retry-After header in seconds and a JSON body with error and retryAfter. Wait that long, then go on.</p>
      <p>Every error is JSON with an error sentence. 401 means the key is unknown, revoked, or its account is suspended or closed. 403 adds a code: pro_required when the account&apos;s Pro has lapsed, which pauses every buyer key until Pro is back, and scope_missing when the key wasn&apos;t given the scope the endpoint needs. 400 means a query parameter can&apos;t be read, and 404 means the record isn&apos;t one this key may see.</p>
      <Example label="403 after a trial ends">{{ code: "pro_required", error: "This account's Pro trial ended on Nov 2, 2026. Buyer API keys need Pro. Subscribe at /buyer/subscription and the key works again." }}</Example>

      <Heading>Buyer scopes</Heading>
      <p>A buyer key carries the scopes picked when it was minted. A seller key has tapes:write and offers:read.</p>
      <ul className="list-disc space-y-1 pl-5">
        {BUYER_SCOPES.map((scope) => <li key={scope}><span className="font-mono text-[14px]">{scope}</span> · {SCOPE_LABELS[scope]}</li>)}
      </ul>

      <Heading>Paging</Heading>
      <p>Buyer lists come oldest change first, then by id. limit sets the page size, {PAGE_LIMIT.default} by default and at most {PAGE_LIMIT.max}. When more rows follow, nextCursor is set: send it back as cursor for the next page, with the same filters. It is null on the last page.</p>
      <p>updated_since takes an ISO 8601 time and returns only rows that changed at or after it. To keep a copy in sync, store the newest updatedAt you received and send it on the next pass. A row that changes during a sync moves to the end and comes back on that next pass, so the same row can arrive twice with nothing new in it.</p>

      <Heading>Buyer endpoints</Heading>
      <Endpoint>GET /api/v1/listings</Endpoint>
      <p>Live listings this account may see: taking bids or in contract, and past any launch date. A private sale shows only to the buyers its seller invited, and a seller who excludes the account shows none of theirs. Scope listings:read.</p>
      <p>Filters, all optional: state (two letters), lien_position (FIRST, SECOND, THIRD, OTHER), payment_status (PERFORMING, SUB_PERFORMING, NON_PERFORMING), max_ltv (percent), min_upb and max_upb (dollars). Lien and status take several values, comma-separated. A pool is judged as the book judges it: its balance and LTV on the loans still for sale, its state, lien and performance on any one loan.</p>
      <Example label="Request">{`curl -H "Authorization: Bearer upb_…" \\
  "${APP}/api/v1/listings?state=FL&lien_position=FIRST&max_ltv=80&limit=50"`}</Example>
      <Example label="Response">{{ listings: [summary], nextCursor: "WyIyMDI2LTExLTA4VDA5OjEyOjQ0LjAwMFoiLCJjbTNrOXgyYWIwMDAxIl0" }}</Example>
      <p>Money is in dollars and ratios in percent. saleFormat is NONE for open offers, SEALED or BEST_AND_FINAL. bidDeadline is set when a round has one. updatedAt moves when the listing or its price changes.</p>

      <Endpoint>GET /api/v1/listings/:id</Endpoint>
      <p>One live listing&apos;s summary and loan tape, as a signed-in buyer reads it before the confidentiality agreement. It never carries data-room files, the street, zip or borrower, the loan number, MERS or eNote ids, the seller&apos;s memo, or anyone&apos;s bid. Each loan lists every other tape field, null where the tape lacks it. A value estimate shows only where it came from a real provider. Scope listings:read.</p>
      <Example label="Response, shortened">{{
        ...summary,
        summary: "Vacant SFR, foreclosure filed, BPO in the room.",
        loans: [{
          id: "cm3k9x2ab0002",
          city: "Orlando",
          state: "FL",
          tradeStatus: "AVAILABLE",
          askingPrice: 118000,
          propertyType: "SFR",
          occupancy: "VACANT",
          lienPosition: "FIRST",
          paymentStatus: "NON_PERFORMING",
          monthsDelinquent: 14,
          foreclosureStatus: "LIS_PENDENS",
          interestRate: 6.25,
          monthlyPi: 1123.4,
          upb: 182400,
          estimatedValue: 265000,
          lastPaidDate: "2025-08-01T00:00:00.000Z",
          originationDate: "2019-04-12T00:00:00.000Z",
          maturityDate: "2049-05-01T00:00:00.000Z",
          payString: "999999999999",
          creditScore: 612,
          valueEstimate: null,
          valueEstimateProvider: null,
          valueEstimateAsOf: null,
        }],
      }}</Example>

      <Endpoint>GET /api/v1/matches</Endpoint>
      <p>Live listings that fit one of the account&apos;s buy boxes, with the score and the reasons. indicativePrice is the box&apos;s own standing price where it has one, and binds nothing until you confirm it as a bid. updatedAt is when the match was made or its standing price last moved. Scope matches:read.</p>
      <Example label="Response">{{
        matches: [{
          id: "cm3kb1m4c0007",
          listingId: ID,
          listing: "Orlando SFR first lien",
          listingStatus: "APPROVED",
          buyBoxId: "cm3j7q0zd0003",
          buyBox: "Florida firsts",
          buyBoxActive: true,
          score: 86,
          reasons: ["In FL", "First lien", "LTV 69%"],
          indicativePrice: null,
          matchedAt: "2026-11-02T15:05:10.000Z",
          updatedAt: "2026-11-02T15:05:10.000Z",
          webUrl: web,
        }],
        nextCursor: null,
      }}</Example>

      <Endpoint>GET /api/v1/offers and GET /api/v1/offers/:id</Endpoint>
      <p>With a buyer key, the account&apos;s own bids and requests and where each stands: OPEN, REVIEWED, ACCEPTED, DECLINED, WITHDRAWN or EXPIRED. amount is your own latest price. counter is a price the desk or the seller put to you that you haven&apos;t answered, and counterFrom says whose it is. No other bidder&apos;s amount is ever here. updatedAt is the latest message, counter, withdrawal or closing, so use the offer.status webhook to hear every change as it happens. Scope offers:read.</p>
      <Example label="Response">{{
        offers: [{
          id: "cm3kc8f2e0011",
          type: "OFFER",
          status: "REVIEWED",
          listingId: ID,
          listing: "Orlando SFR first lien",
          noteId: null,
          amount: 112000,
          counter: 116500,
          counterFrom: "desk",
          expiresAt: "2026-11-30T00:00:00.000Z",
          withdrawnAt: null,
          closingId: null,
          createdAt: "2026-11-04T13:22:08.000Z",
          updatedAt: "2026-11-06T10:41:51.000Z",
          webUrl: web,
        }],
        nextCursor: null,
      }}</Example>

      <Endpoint>GET /api/v1/holdings</Endpoint>
      <p>Notes the account holds, as its portfolio lists them: closed trades and notes added by hand. updatedAt for paging is the acquisition date. Scope holdings:read.</p>
      <Example label="Response">{{
        holdings: [{
          id: "cm3kd2h9f0014",
          title: "Tampa performing second",
          listingId: "cm3h1v6ya0020",
          closingId: "cm3jx4n8b0031",
          status: "CURRENT",
          costBasis: 41250,
          upb: 58800,
          sharePercent: null,
          underwrittenYield: 13.4,
          acquiredAt: "2026-10-15T00:00:00.000Z",
        }],
        nextCursor: null,
      }}</Example>

      <Heading>Buyer webhooks</Heading>
      <p>Add an https endpoint on a public host at Buyer API and pick its events. Events go only while the account has Pro. Bodies carry ids and the listing&apos;s public terms, never a street, a borrower, a data-room file or another bidder&apos;s amount; read the rest from the endpoints above.</p>
      <ul className="list-disc space-y-1 pl-5">
        {BUYER_WEBHOOK_EVENTS.map((item) => <li key={item.event}><span className="font-mono text-[14px]">{item.event}</span> · {item.label}</li>)}
      </ul>
      <p>listing.matched goes when a listing goes live and fits a buy box, once per buyer, naming the best-scoring box. listing.repriced goes when a listing you saved has a new ask; previousAsk and ask cover the loans whose price moved. listing.deadline goes once, about a day before bids close on a listing you saved. offer.status goes when one of your bids or requests is placed, countered, accepted, declined, withdrawn or expires. change is created, countered, accepted, declined or expired, status is where it stands now, and reason says why where there is one, such as another_bid_accepted or withdrawn.</p>
      <Example label="listing.repriced">{{ event: "listing.repriced", sentAt: "2026-11-09T14:00:03.000Z", listingId: ID, title: "Orlando SFR first lien", saleFormat: "NONE", bidDeadline: null, webUrl: web, loansRepriced: 1, previousAsk: 118000, ask: 109500 }}</Example>
      <Example label="offer.status">{{ event: "offer.status", sentAt: "2026-11-21T16:30:12.000Z", inquiryId: "cm3kc8f2e0011", listingId: ID, type: "OFFER", status: "DECLINED", change: "declined", reason: "another_bid_accepted" }}</Example>

      <Heading>Seller endpoints</Heading>
      <p>POST /api/v1/tapes with JSON. title is the pool name. csv is the tape, using the same headers as the upload template. The listing is submitted for review and the response is listingId and loans. Scope tapes:write.</p>
      <p>GET /api/v1/offers returns bids on listings this key’s account owns: id, status, amount, listing title. GET /api/v1/offers/:id returns one of them. On a sealed listing before its deadline, amount is null, sealed is true, and the message history is empty. Scope offers:read.</p>
      <p>A seller&apos;s webhook receives offer.created, offer.accepted, offer.declined, and offer.countered, and you can pick which for each endpoint. An offer declined because another bid won carries reason another_bid_accepted.</p>

      <Heading>Signatures and retries</Heading>
      <p>The body is JSON. x-upb-signature is the hex HMAC-SHA256 of the raw body, using the secret shown once when the endpoint is saved. x-upb-event names the event.</p>
      <p>Answer a webhook with any 2xx status. Anything else, or no answer within five seconds, counts as a failure, and the same body is sent again after 1 minute, 10 minutes, 1 hour, 6 hours and 24 hours, then no more. Every try carries x-upb-delivery, which stays the same across tries, and x-upb-attempt, which counts them, so you can drop a repeat. The Seller API and Buyer API pages list recent deliveries with their answers and can send any one again.</p>
      <p>Scheduled jobs are separate. A host can call GET /api/cron with Authorization: Bearer $CRON_SECRET, or run npm run jobs on a worker. That sends buy-box digests, task reminders, bid-deadline notices, closing-step reminders, the new owner’s sale-notice reminders, closed-auction notices, data-room destruction requests, webhook retries, and retention cleanup.</p>
    </PublicPage>
  );
}
