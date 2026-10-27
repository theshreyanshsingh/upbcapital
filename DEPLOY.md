# Deploy UPB Capital

First production host is Vercel, connected to the private Origin repo `gt-tharma/upb-capital`, with MongoDB Atlas: the `upb_capital` database on the SynergyFund cluster. Do not run `npm run db:seed` against that database; the seed starts by dropping the database. The Vercel build builds the indexes and creates one admin. It never loads the demo desk.

## Checklist

1. In Atlas, on the SynergyFund cluster, add a database user whose only role is `readWrite` on `upb_capital`. Do not reuse SynergyFund's user. Under Network Access, allow Vercel to connect (Vercel functions have no fixed IP, so that is usually `0.0.0.0/0` with a strong password). Copy the connection string and put `/upb_capital` after the host.
2. In Vercel, import `gt-tharma/upb-capital` from Origin. Framework preset is Next.js. Leave the build command as `npm run build`.
3. Set the required variables below for **Production** and **Preview**. The build reads them. A preview build without them fails closed instead of migrating the wrong database.
4. Deploy from the Vercel dashboard. This repo does not deploy itself.
5. Open `https://<your-domain>/login` and sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
6. Hit `https://<your-domain>/api/health`. `db` should be `ok` and `storage` should be `s3` or `blob`.
7. In the fee schedule, replace the empty wire instructions and confirm the premium and commission.

`vercel.json` already schedules `GET /api/cron` at 13:00 UTC every day. Vercel sends `Authorization: Bearer $CRON_SECRET` when that variable exists.

## What the build does

`npm run build` runs `scripts/release.ts` only when `VERCEL=1` (or `UPB_RELEASE=1` on another host). Leave Vercel’s install command as the default. `tsx`, which runs that script, is a production dependency so the step still exists if dev dependencies are omitted. The script:

- Refuses to start unless the required variables below are present.
- Refuses a `DATABASE_URL` that is not `mongodb+srv://` or `mongodb://`, names no database, or names `synergifund`, `admin`, `local`, or `config`.
- Builds the indexes from `prisma/schema.prisma` (`lib/mongo-indexes.ts`). Optional unique fields get partial indexes, so empty values never collide. Running it again changes nothing.
- Runs the production bootstrap: one approved admin, the default fee-schedule row, and the Florida disclosure already in the source. No listings, buyers, or demo logins.

Changing `ADMIN_PASSWORD` later does not reset the password. The bootstrap writes it only when that email is absent. Rotate it from the signed-in admin after the first deploy.

`prisma/seed.ts` throws if `NODE_ENV=production`, `VERCEL=1`, or `UPB_RELEASE=1`. Demo emails such as `iris@upbcapital.test` and `nora.vale@upbcapital.test` are rejected as `ADMIN_EMAIL`. The broker seat, its public profile, and its sample fees are demo data. They are not created by the production bootstrap. Broker compensation uses the fee schedule already in the database. There is no new environment variable for it. The payout note on a broker profile is a method only. The desk does not store account numbers.

## Required

| Variable | Where to get it |
| --- | --- |
| `DATABASE_URL` | Atlas → Connect → Drivers, with UPB's own user. `mongodb+srv://<user>:<password>@<cluster-host>/upb_capital?retryWrites=true&w=majority`. |
| `AUTH_SECRET` | `openssl rand -base64 32`. Signs the session cookie. The demo value in `.env.example` is rejected. |
| `NEXT_PUBLIC_APP_URL` | The public `https://` origin, including the Vercel domain until a custom domain is attached. Used in mail links and Stripe return URLs. |
| `ADMIN_EMAIL` | The one production admin. Not a `@upbcapital.test` address. |
| `ADMIN_PASSWORD` | At least 12 characters. Not `Desk1847!`. Applied only when the admin row is created. |
| `CRON_SECRET` | `openssl rand -base64 32`. Vercel Cron uses it as the bearer token for `/api/cron`. |
| Storage, one of the two blocks below | Files (NDAs, proof of funds, closing uploads) do not survive on Vercel’s disk. |

### Storage option A — Cloudflare R2

Create an R2 bucket and an API token with object read and write. Then set:

| Variable | Where to get it |
| --- | --- |
| `S3_BUCKET` | The R2 bucket name. |
| `S3_ACCESS_KEY_ID` | R2 → Manage API tokens → the token’s access key id. |
| `S3_SECRET_ACCESS_KEY` | The same token’s secret. Shown once. |
| `S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` from the R2 bucket’s S3 API page. |
| `S3_REGION` | `auto` |

If these three credentials are set, they win over Vercel Blob.

### Storage option B — Vercel Blob

Create a **private** Blob store in the Vercel dashboard and connect it to this project. Vercel adds `BLOB_READ_WRITE_TOKEN`. The app uploads and reads with `access: "private"`, so a public store will reject the calls. On Vercel the SDK can also use OIDC when `BLOB_STORE_ID` is present. Keys are the same paths the desk already stores. They are not given a random suffix, and a rewrite of the same key overwrites.

`S3_REGION` is optional for AWS S3 (`us-east-1` if omitted) and required as `auto` for R2 only in the sense that R2 expects that value. Leave `S3_ENDPOINT` empty for AWS S3.

## Optional

| Variable | Where to get it | If unset |
| --- | --- | --- |
| `ADMIN_NAME` | Any display name. | The admin is named “Desk admin”. |
| `DESK_EMAIL` | A shared desk inbox. Gets desk alerts alongside every approved admin and is shown in the public footer. Not a `@upbcapital.test` address. | Desk alerts go to approved admins only. The footer shows no address. |
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys. | Pro checkout stays simulated. No card is charged. |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Webhooks → endpoint `https://<domain>/api/billing/webhook`. | Stripe events are not verified. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe → API keys. | Checkout UI falls back to the simulated path. |
| `STRIPE_PRO_PRICE_ID` | Stripe → Products, only if you do not save the price from the fee schedule. | The fee schedule creates the Price when the secret key is set. |
| `RESEND_API_KEY` | Resend → API keys. | |
| `EMAIL_FROM` | A sender address on the Resend (or SMTP) domain. | Without Resend or SMTP, mail is written to the log and the in-app notice list. |
| `SMTP_HOST` | Your SMTP host. | Used only when Resend is not set. |
| `SMTP_PORT` | Usually `587`. | Defaults to 587. |
| `SMTP_USER` | SMTP username. | |
| `SMTP_PASSWORD` | SMTP password. | |
| `ESCROW_PROVIDER` | Leave `manual` until a provider is registered in `lib/escrow.ts`. | Wire instructions on the closing. |
| `AVM_PROVIDER` | `mock` or `attom`. | `mock` pins a city. |
| `ATTOM_API_KEY` | ATTOM → API key. | Mock value estimate. |
| `RATE_LIMIT_STORE` | `database` (default), `redis`, or `memory`. | The database. Use that on Vercel. `memory` is per instance. |
| `ALLOW_HTTP_SESSIONS` | `1` only on an internal server reached over plain http, such as pm2 on port 3009 with no proxy. A release build refuses it. | Session cookies are https-only in production, so sign-in fails over plain http. |
| `REDIS_URL` | Redis provider, only if `RATE_LIMIT_STORE=redis`. | Ignored. |
| `DROPBOX_SIGN_API_KEY` | Dropbox Sign → API. | Signatures stay in the app. |
| `DROPBOX_SIGN_TEST_MODE` | `1` or `0`. | Test mode when the key is set and this is blank or `1`. |
| `DOCUSIGN_ACCESS_TOKEN` | DocuSign OAuth token. | |
| `DOCUSIGN_ACCOUNT_ID` | DocuSign account id. | |
| `DOCUSIGN_BASE_URL` | Defaults to the DocuSign demo REST host. | |
| `PERSONA_API_KEY` | Persona → API keys. | Buyer file stays the desk form. |
| `PERSONA_TEMPLATE_ID` | Persona inquiry template. | |
| `PARALLEL_API_KEY` | Parallel Markets. | |
| `KYC_WEBHOOK_SECRET` | A secret you choose. Persona or Parallel posts to `/api/kyc/webhook` with header `x-kyc-secret`. | The webhook rejects calls. |
| `OFAC_API_KEY` | The sanctions vendor. | Local SDN list and fuzzy match, including the planted test names. |
| `OFAC_API_URL` | A URL that returns JSON names, a name column, or an OpenSanctions-style body. | |
| `LLM_API_KEY` or `OPENAI_API_KEY` | OpenAI or a compatible host. | The desk assistant writes a local sketch. |
| `LLM_BASE_URL` | Defaults to `https://api.openai.com/v1`. | |
| `LLM_MODEL` | Defaults to `gpt-4o-mini`. | |

## Still outside this repo

- The Atlas user and network rule, the Vercel project, and the env values themselves. Nothing here calls `vercel deploy`.
- A custom domain and its DNS, if you do not want the `*.vercel.app` host.
- Resend or SMTP, if mail should leave the log.
- Stripe, if Pro should charge a card.
- The browser tape wizard keeps the upload in the database for 24 hours so any Vercel instance can finish the later steps. `/api/cron` deletes drafts older than that. `POST /api/v1/tapes` still sends the CSV in one request.
