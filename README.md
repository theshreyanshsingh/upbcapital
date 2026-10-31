# UPB Capital

A private desk for mortgage notes and distressed real estate debt. Sellers list a single note or an institutional tape. The desk reviews it. Approved buyers underwrite against unpaid principal balance, save favorites, and send an offer. Premiums, commissions, and Pro membership are configurable, and they show up on a revenue ledger.

This is a working demo. Every loan, borrower, and document in the seed data is fictional.

## Stack

- Next.js 15, React 19, TypeScript
- Tailwind CSS 4 and shadcn/ui
- MongoDB and Prisma
- Auth.js-style signed cookies (credentials, roles) via `jose` and `bcryptjs`
- Local file storage in `storage/`
- Stripe Checkout for Pro, with a simulated checkout when keys are absent
- Email is written to the server log and the `Notification` table

## Run it

You need Node 22 and MongoDB 7 or later running as a replica set. Prisma uses transactions, which a standalone MongoDB does not support. `docker compose up -d` starts a one-node replica set.

```bash
cp .env.example .env
docker compose up -d
npm install
npx prisma db seed
npm run dev
```

The app listens on [http://127.0.0.1:4317](http://127.0.0.1:4317).

`DATABASE_URL` in `.env.example` matches `docker-compose.yml`:

```
mongodb://localhost:27017/upb_capital?directConnection=true
```

There are no migrations. `npm run db:indexes` builds the indexes the schema declares and is safe to run again; the seed and the release build both run it. Do not use `prisma db push`. It builds plain unique indexes, and MongoDB counts every document without an optional unique value (a closing with no desk bid, a user with no referral code) as a duplicate. `db:indexes` makes those indexes partial instead. Money fields are stored as floating-point numbers, because Prisma has no decimal type on MongoDB. `npm run db:reset` empties the local database and loads the demo desk again.

## Demo accounts

Password for every sample account: `Desk1847!`

| Seat | Email | What you can do |
| --- | --- | --- |
| Desk admin | iris@upbcapital.test | Review queue, offers, accounts, fees, revenue |
| Note seller | maya.ellison@upbcapital.test | File a single note |
| Institution | desk@harborline.test | Upload a CSV or Excel tape |
| Buyer, Free | jordan.hale@upbcapital.test | Limited book, veiled metrics |
| Buyer, Pro | camille.ortiz@upbcapital.test | Full metrics, data room, alerts |
| Waiting buyer | avery.chen@upbcapital.test | Sees the pending screen |
| Waiting bank | credit@southshore.test | Cannot upload until approved |
| Broker | nora.vale@upbcapital.test | File deals for a seller, share a referral code |

The sign-in page lists six of these accounts (not the two waiting seats) and fills the password only when they exist in the database and the app is not a Vercel or `UPB_RELEASE` build. A production database never has them, because bootstrap refuses one that does.

A downloadable tape template, with three fictional rows, is linked from the upload screen and at `/api/tapes/template?format=csv` or `?format=xlsx`.

## How a listing moves

Submitted → under review → approved (live) or rejected or changes requested → in contract → sold.

Approving a listing makes it visible to approved buyers. New approvals stay Pro-only for the early-access window (48 hours by default). Marking a listing sold posts the buyer premium and the seller commission to the ledger, using the rates on the fee schedule at that moment.

Sensitive fields — street address, ZIP, borrower name, and files — stay hidden until the buyer acknowledges confidentiality on that listing. Files also require Pro.

## Money

The admin fee schedule (`/admin/settings`) sets:

- Buyer premium, added on top of an accepted price and shown on the listing and the offer
- Seller commission, deducted from the sale price and shown on the note form and the seller desk
- Pro monthly price, used for checkout and for MRR
- Early-access hours
- How many listings a free buyer can open
- Default wire instructions copied onto a new closing
- Broker fee and affiliate referral fee, each a percentage of the buyer premium plus the seller commission, or a flat amount. A broker can have an override. The fee posts when a closing completes, shows on the closing economics, and waits in the payout queue until it is marked paid. It is withheld when the broker is also the buyer or the seller.

Brokers sign up from the same request-access page, then finish a short onboarding: company, license (optional for an affiliate), states, portrait, W-9, payout note, and bio. The payout note is a method only. Account numbers are refused. The desk approves the seat before a deal can be filed or a referral can attach. The public page is `/brokers/NORAVALE` for the demo broker. Buyers who sign up with `?ref=NORAVALE` are tied to that seat.

Saving the Pro price with `STRIPE_SECRET_KEY` set creates a Stripe Product if needed and a new monthly Price when the amount changed. The previous Price is deactivated. Checkout uses that stored price, and falls back to `STRIPE_PRO_PRICE_ID` only when the schedule has not synced one yet. Without a Stripe secret, buyers activate Pro through a simulated checkout that still writes a mock subscription line to the ledger. With a secret and no price yet, the membership page waits for the price instead of simulating.

Point the Stripe webhook at `/api/billing/webhook` with `STRIPE_WEBHOOK_SECRET`.

MRR is the count of paid active Pro members times the current monthly price. Comped memberships are excluded from MRR.

## Confidentiality

A buyer signs per listing, by typing a name or drawing on the pad. The record stores the time, IP address, user agent, and a PDF. The seller, the desk, and the signer can download that PDF; other buyers never see it in the data room. A broker's seller authorization is kept the same way. Street, borrower, and files stay closed until that signature exists.

## Offers and closing

Approved buyers with an approved buyer file can bid the whole listing or, inside a pool, a single loan. The desk and the buyer can counter and message on the same thread. Accepting the working price opens a closing checklist:

1. Purchase agreement
2. Buyer deposit
3. Collateral file transfer
4. Assignment and allonge
5. Payment received
6. Closed

Both sides upload documents. A broker who filed the listing acts for the seller and sees what the seller sees. An approved broker who referred the buyer can follow the steps and the fee without seeing wire instructions, files, or other group members. The desk marks steps complete and edits wire instructions. The checklist shows the sale price, buyer premium, all-in, commission, and net to seller. Marking the file closed posts those two ledger lines once. Escrow is a manual wire provider today. `registerEscrowProvider()` in `lib/escrow.ts` is the hook for a later provider, selected with `ESCROW_PROVIDER`.

## Buyer file

Before an offer, a buyer submits entity type, legal name, jurisdiction, an accredited-investor self-certification, and a proof-of-funds file. The desk approves, declines, or asks for changes at `/admin/verification`. Browsing does not require this file. Offering does.

## Mail, files, health

`/notifications` shows the same notes the desk sends. Desk alerts — new listings, broker files, offers, sign-ups, buyer files, and deadlines — go to every approved admin, and to `DESK_EMAIL` when it is set. Delivery uses Resend when `RESEND_API_KEY` and `EMAIL_FROM` are set, otherwise SMTP when `SMTP_HOST` and `EMAIL_FROM` are set, otherwise the server log. A failed provider still keeps the in-app notice.

Files go to S3-compatible storage when `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY` are set (`S3_ENDPOINT` for Cloudflare R2). A private Vercel Blob store is used when `BLOB_READ_WRITE_TOKEN` or `BLOB_STORE_ID` is set and the S3 credentials are not. Otherwise files stay in `storage/uploads`, which is only for local development. Production rules are in [DEPLOY.md](DEPLOY.md).

`GET /api/health` returns database, storage mode, mail mode, and Stripe presence. It is unauthenticated and does not include secrets.

## Environment

See `.env.example`. In production `DATABASE_URL` is the MongoDB Atlas connection string for UPB's own database, `upb_capital`, on the SynergyFund cluster. A release build refuses a URL with no database name or one that names `synergifund`.

## Deploy

Docker:

```bash
docker compose -f docker-compose.prod.yml up --build
```

The app container runs `npm run db:indexes` and then listens on port 4317. Set `AUTH_SECRET` before you use that file for anything but a local trial.

Vercel and MongoDB Atlas: follow [DEPLOY.md](DEPLOY.md). The Vercel build syncs the indexes, then creates one admin from `ADMIN_EMAIL` and `ADMIN_PASSWORD`. `npm run db:seed` refuses to run when `NODE_ENV` is production or `VERCEL` is set, so demo accounts never load there.

A plain server under pm2, with no proxy: the whole app (pages and API) is one Next.js process, plus the daily jobs. It uses port 3009; SynergyFund's frontend holds 3007 on the shared server.

```bash
npm ci && npm run db:indexes && npm run build
pm2 start node_modules/.bin/next --name upb-capital -- start -p 3009 -H 0.0.0.0
pm2 start node_modules/.bin/tsx --name upb-jobs --cron-restart "0 13 * * *" --no-autorestart -- --env-file=.env scripts/jobs.ts
pm2 save
```

Session cookies are https-only in production. If the server is reached over plain `http://`, set `ALLOW_HTTP_SESSIONS="1"` in `.env` or sign-in will not stick.

Any other Node host:

- Node 22
- `npm install` (postinstall runs `prisma generate`)
- `npm run db:indexes`
- `npm run db:seed` only on a demo database
- `UPB_RELEASE=1 npm run db:bootstrap` for the production admin
- `npm run build` and `npm start`
- Set the environment variables from `.env.example`
- Stripe webhook: `https://<host>/api/billing/webhook`

## Tests

```bash
npm test
```

Unit tests cover fees, the closing gate, offer counters, buyer-file gating, mail and storage selection, Stripe price replacement, and the NDA PDF. One test runs a closing against the database in `DATABASE_URL` and deletes the rows it created.

## Underwriting, tape, and the map

A Pro buyer can type a bid on a listing and see yield, IRR, cash-on-cash, and payback on performing paper. Non-performing paper shows five resolution cases — reinstatement, modification, short sale, deed in lieu, and foreclosure / REO — with a state timeline. Unknown states use Florida judicial timing. Download the same figures as a PDF memo.

Pool listings add stratification by state, lien, status, UPB, LTV, and coupon, plus WAC, weighted LTV, and weighted months delinquent. CSV and Excel exports sit on the tape.

Each listing asks the property provider for a value estimate and a map pin. `AVM_PROVIDER` defaults to `mock`. `registerPropertyProvider()` in `lib/enrichment.ts` is the hook for a live AVM. The book has a map view at `/marketplace?view=map`.

## Auctions

A seller or the desk can set a sealed-bid or best-and-final deadline on a listing. The page counts down. Sealed amounts stay hidden from everyone but the desk until the deadline. The seller is told a bid arrived and who placed it; the amount and note stay out of the email, the seller API, and webhooks (`amount` is null and `sealed` is true). Best and final accepts one bid per buyer. When the deadline passes, the seller, the bidders, and the desk are notified once. The desk awards from the offer book after that.

## Seller desk and admin tools

The seller home shows views, inquiries, offers, and a suggested price from comparable live notes in the same state and performance band. A pool can be repriced as a percent of UPB. Duplicate listing files a fresh copy into review.

`/admin/contacts` is the buyer and seller book, with saved-search demand. `/admin/audit` is the status-change log. CSV exports for users, listings, notes, and inquiries are linked from contacts.

## Public pages, referrals, and sign-in

Live listings have an anonymized page at `/open/[id]` — city, lien, performance, and an UPB band. Street, borrower, ZIP, and price stay off it. `/sitemap.xml` lists those pages.

Buyers get a referral code on the membership page. The first time someone who used that code activates Pro, the referrer banks one free month. A credit covers the next simulated month with no ledger charge. With Stripe configured, checkout creates a one-time coupon for the Pro price and the webhook spends the credit when checkout completes. Pro members with a Stripe customer id can open the billing portal from membership.

## Sign-in, limits, and sessions

Security shows a QR code for an authenticator, eight one-time recovery codes, and an optional email code. Sign-in stops at `/login/verify` when two-factor is on. Recovery codes and email codes are accepted on that screen. Codes are limited to five tries per fifteen minutes per account, at sign-in and when turning two-factor off.

`RATE_LIMIT_STORE` is `database` (default; the old value `postgres` means the same), `redis` (needs `REDIS_URL`), or `memory`. A store error falls back to memory. Login is eight attempts per ten minutes per address and email. New sessions are documents in the database, so sign-out revokes that cookie on every instance. Older cookies without a session id still verify until they expire.

## Vendors

| Concern | Env | Fallback |
| --- | --- | --- |
| Value estimate | `AVM_PROVIDER=attom` and `ATTOM_API_KEY`. Calls ATTOM AVM detail with street or city. | Mock pin and value |
| NDA | `DROPBOX_SIGN_API_KEY` (HelloSign send, test mode unless `DROPBOX_SIGN_TEST_MODE=0`) or `DOCUSIGN_ACCESS_TOKEN` plus `DOCUSIGN_ACCOUNT_ID` (optional `DOCUSIGN_BASE_URL`). The purchase agreement can be sent the same way through its packet link with `?send=1`, but no screen offers that yet, and no signature status comes back. | Signed in the app |
| Buyer file | `PERSONA_API_KEY` and `PERSONA_TEMPLATE_ID`, or `PARALLEL_API_KEY` | Desk form and proof upload |

`POST /api/kyc/webhook` expects `x-kyc-secret: $KYC_WEBHOOK_SECRET`. The body can be `{ "userId", "reference", "status" }` or a Persona inquiry event. Status `approved` or `completed` approves the buyer file.

## Closing forms and boarding

`/admin/templates` edits the purchase agreement, assignment, and allonge. Tokens such as `{{buyer}}`, `{{price}}`, and `{{street}}` fill from the closing. The PDF keeps those fields editable. Download them from the closing page.

After a file is closed, the parties record the servicer, loan number, and boarding date. `/api/closings/[id]/boarding` downloads the CSV package.

The book lists twelve listings a page. Fee settings are cached for twenty seconds in the process.

## Buy boxes, quotes, and the desk book

A buyer files a buy box at `/buyer/buy-box`: states, lien, performance, UPB and price ranges, a maximum price as a percent of UPB, and a target IRR. The score uses the performing case from the deal analyzer (level monthly principal and interest, term from maturity or 360 months), not cash yield. Every new listing is scored against the active boxes. The review queue shows the match count before a listing is approved. Matching buyers are notified when that listing goes live.

`/sell` is a public quick quote. A few fields return an indicative range from the desk bands and comparable notes on the book. It is not an offer. Creating an account with that quote prefills the listing form. `/admin/leads` is the pipeline: new, contacted, listing, or passed.

An admin can place a desk bid on a listing. Accepting it opens the same closing checklist and fee ledger as a buyer deal. The note joins `/admin/book` when that checklist is marked closed. Fee schedule has a switch for whether the buyer premium and seller commission apply to desk purchases. A purchase accepted before this checklist existed is given an open closing the next time the book loads; the holding is not duplicated. Buyers get the same ledger at `/buyer/portfolio` after a closing completes, and can add a note they already hold. Both books export a CSV statement.

## Inbox, tape checks, and analytics

`/inbox` gathers offers, inquiries, and closings into threads. Opening a thread marks it read. A reply can include a file, and your own note shows Read once the other participants have opened it.

Tape upload checks the mapped rows even with no model: missing fields, coupons outside the usual band, LTV over 100%, a city or ZIP that disagrees with the state, and the formats the importer will rewrite (`$228,000`, `Florida`, `0.065`, `1st`, ZIP+4). Problem rows are highlighted. The pool is still rejected on hard errors at submit.

`/admin/assistant` summarizes a tape, explains those issues, or drafts a listing. It is for the desk only. Set `LLM_API_KEY` or `OPENAI_API_KEY` (optional `LLM_BASE_URL` and `LLM_MODEL`) for an OpenAI-compatible model. With no key, the desk writes a sketch from the rows.

`/admin/analytics` is the funnel (visits, signups, verified buyers, offers, closings, closed), mean days from filing to sold, top buyers by offer volume, and listing views. Send match digest emails the buyers whose preference is daily or weekly and who have new live matches since the last digest.

## Owned notes, slices, and capital

`/admin/book/[id]` is the loss file for a note the desk owns: borrower outreach, a reinstatement, forbearance, or modification, foreclosure milestones with attorney and court dates, and task deadlines. Those deadlines also show on the book when they are due within a week. REO hand-off writes a property record with a rehab budget and a resale or rental exit.

Relist, on the desk file or a buyer holding, copies the loan facts, the stored documents, and the payment history onto a new listing. A desk relist goes live. A buyer relist waits in review. A participation sells a percent of the note or a count of future payments. The analyzer splits the cash flows, and the desk can list that slice.

`/admin/capital` tracks investors, commitments, and allocations against desk purchases. Receipts are attributed in proportion to the allocation. `/api/admin/capital/statement` downloads the CSV.

## Compliance and notices

`/admin/compliance` stores a per-state license note and disclosure. Florida is seeded. Those notes render on marketplace listings, the public listing, the seller desk, and the closing checklist. Seller-financed notes, including every individual-seller filing, also show Dodd-Frank and SAFE Act reminders. They are reminders, not advice.

OFAC screening is a fuzzy name match, in either word order. Set `OFAC_SDN_URL` to read Treasury's SDN list and aliases, at most every six hours (vessels and aircraft are skipped). Or set `OFAC_API_KEY` and `OFAC_API_URL` for a vendor, parsed as JSON names or an OpenSanctions-style body. With neither, the desk uses a seven-name stand-in that is not real screening, says so on `/admin/compliance`, and a release build refuses to start. The planted strings “blocked test” and “ofac sample” always go to review, including a close misspelling.

The desk screens at sign-up, on a buyer file, on an investor, and when a note or tape arrives, covering the seller, a broker's client, and every named borrower. It screens again at approval. A match goes to `/admin/compliance`, where a person clears it or confirms it with a reason. Until then it stops account approval, listing approval, awards, desk bids, and closing steps, and the party is told nothing. A decision carries forward for that name and that list entry. Retention removes old page visits and read notices. Loan files stay. Nothing deletes accounts or their files yet, because the retention periods need a lawyer's answer first.

Anyone can reset a forgotten password from the sign-in page. The link lasts an hour, works once, and signs every device out. `/account/security` changes the password and lists signed-in devices. Real admins must use an authenticator. The demo seats on `@upbcapital.test` are exempt, keep the shared password, and their mail stays in the server log.

On `/admin/users` the desk can suspend or reinstate an account, sign a user out everywhere, or clear a lost second factor. Declining or suspending ends the user's sessions at once and also stops their API keys. A closing can be canceled with a reason from its page. The note goes back on the book, nothing posts to the ledger, and the buyer must send a new offer.

`/account/notifications` sets email, in-app notices, and digest frequency per user. Turning both channels off skips the message.

## Group buys

On a live listing, a verified buyer who has signed confidentiality, or the desk, can open a group. They set the price, the smallest seat, a deadline, and either pro-rata ownership or a senior/junior split. Other verified buyers join by dollars or by percent. The fill bar shows what is left. Other buyers see seats as Seat 1, Seat 2. The desk sees names.

When the seats add up to the price, one offer goes to the seller. A counter scales every seat and each member reconfirms or drops. A drop reopens the spot. If the deadline passes short, the opener can extend it, send the filled amount when the seller has allowed a partial bid, or dissolve the group. Everyone with a seat is notified.

Accepting the offer opens one closing. Each member funds their share. The premium is split on the same percentages and posted once. The purchase agreement lists the co-ownership schedule. After the file closes, each member’s portfolio shows their percentage, and that share can be relisted.

## Jobs

`GET` or `POST /api/cron` with `Authorization: Bearer $CRON_SECRET` runs the daily jobs: buy-box digests that are due, loss-task reminders inside 48 hours, bid-deadline notices inside 24 hours, the existing closed-auction notice, and retention cleanup. `vercel.json` schedules that path at 13:00 UTC. If the host has no cron, run `npm run jobs` from a worker. The HTTP route stays closed until `CRON_SECRET` is set.

## Rehab, filings, and the public site

A desk holding has a rehab estimator: room and trade lines, South Florida unit costs at `/admin/costs`, contractor bids, a draw schedule, and a resale profit or a rental cap rate. `/admin/filings` imports a Miami-Dade, Broward, or Palm Beach clerk CSV and matches rows to notes already on the book. The pipeline is new, contacted, becoming a listing, or passed.

`/learn`, `/faq`, and `/blog` are public. `/admin/blog` edits posts and testimonial placeholders. The home page shows those placeholders with that label. `/sitemap.xml` includes the public pages and published posts.

## Seller API

An institutional seller, or the desk, mints a key at `/seller/api`. The token is shown once, on that page, and never placed in a URL. `POST /api/v1/tapes` accepts `{ "title", "csv" }` and files a pool for review. `GET /api/v1/offers` and `GET /api/v1/offers/:id` return bids on that account’s listings. A webhook URL receives `offer.created`, `offer.accepted`, `offer.declined`, and `offer.countered`. `x-upb-signature` is the hex HMAC-SHA256 of the raw body. The same contract is written at `/developers`.

## Limits

- Wires are instructions, not a payment processor. Sold means the desk marked the checklist closed.
- The in-app signature is stored here. Dropbox Sign or DocuSign runs only when those keys are set. The forms are desk templates, not legal advice.
- Accreditation is a self-certification plus a file, unless Persona or Parallel Markets is configured.
- Mail is delivered only when Resend or SMTP is configured.
- Stripe covers the Pro subscription. Premiums and commissions are ledger entries, not charges.
- A loan bid does not split a pool into separate listings. It tracks that loan through its own closing.
- A value estimate is an ATTOM AVM when that key is set, and a mock pin otherwise. It is not an appraisal.
- Foreclosure months and costs are desk estimates for a model, not a legal opinion.
- Two-factor email codes need Resend or SMTP. There is no SMS fallback.
- Memory rate limits are per process. Database and Redis limits are shared.
- Prisma enforces cascading deletes on MongoDB itself, not the database. Deleting a user who referred other users is refused until those referrals are cleared.
- An indicative quote is a desk range, not a bid. The assistant sketch is not a credit memo.
- Buy-box IRR can include a balloon, skipped months, and one ARM reset. It is still not a full credit memo.
- Digests, task reminders, bid-deadline notices, and retention run from `/api/cron` or `npm run jobs`.
- Desk relist goes live. A buyer relist still waits for review.
- A vendor OFAC body that is not JSON names, a name column, or an OpenSanctions-style payload is ignored and the local list is used.
- Retention does not delete loan files, closings, or the ledger.
- A group is co-ownership of one note, not a fund. Investor capital on the desk book is still a share of cash received, not a waterfall.
- Rehab unit costs are desk defaults for South Florida, not a contractor quote.
- Filing import matches street and city. It does not pull the clerk sites itself.
- Compliance copy is a desk reminder, not legal advice.
