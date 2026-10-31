import assert from "node:assert/strict";
import test from "node:test";
import { assertDemoSeedAllowed, assertMongoUrl, assertReleaseEnv, DEMO_EMAILS, DEMO_LOGINS, demoSeedBlocked, secureCookies, showDemoDesk } from "../lib/deploy";
import { planIndexes } from "../lib/mongo-indexes";

const atlas = "mongodb+srv://upb:secret@cluster0.example.mongodb.net/upb_capital?retryWrites=true&w=majority";

test("demo seed is refused in production and on Vercel", () => {
  assert.equal(demoSeedBlocked({}), false);
  assert.equal(demoSeedBlocked({ NODE_ENV: "production" }), true);
  assert.equal(demoSeedBlocked({ VERCEL: "1" }), true);
  assert.throws(() => assertDemoSeedAllowed({ NODE_ENV: "production" }), /Demo seed is refused/);
  assertDemoSeedAllowed({});
});

test("the sign-in page lists demo accounts only when they exist outside a release build", () => {
  assert.equal(showDemoDesk({}, 8), true);
  assert.equal(showDemoDesk({ NODE_ENV: "production" }, 8), true);
  assert.equal(showDemoDesk({}, 0), false);
  assert.equal(showDemoDesk({ VERCEL: "1" }, 8), false);
  assert.equal(showDemoDesk({ UPB_RELEASE: "1" }, 8), false);
  assert.ok(DEMO_LOGINS.every((login) => DEMO_EMAILS.includes(login.email)));
});

test("session cookies are https-only in production unless an internal http server opts out", () => {
  assert.equal(secureCookies({}), false);
  assert.equal(secureCookies({ NODE_ENV: "production" }), true);
  assert.equal(secureCookies({ NODE_ENV: "production", ALLOW_HTTP_SESSIONS: "1" }), false);
  assert.equal(secureCookies({ NODE_ENV: "production", ALLOW_HTTP_SESSIONS: "true" }), true);
});

test("the database URL names UPB's own MongoDB database", () => {
  assert.doesNotThrow(() => assertMongoUrl(atlas));
  assert.doesNotThrow(() => assertMongoUrl("mongodb://localhost:27017/upb_capital?directConnection=true"));
  assert.throws(() => assertMongoUrl(undefined), /DATABASE_URL is required/);
  assert.throws(() => assertMongoUrl("postgresql://user:pass@host/upb"), /mongodb/);
  assert.throws(() => assertMongoUrl("mongodb+srv://upb:secret@cluster0.example.mongodb.net/?retryWrites=true"), /name the database/);
  assert.throws(() => assertMongoUrl("mongodb+srv://upb:secret@cluster0.example.mongodb.net/synergifund"), /synergifund/);
});

test("optional unique fields get partial indexes so empty values do not collide", () => {
  const specs = planIndexes(`
model Closing {
  id        String  @id @default(cuid()) @map("_id")
  listingId String
  deskBidId String? @unique
  code      String  @unique
  listing   Listing @relation(fields: [listingId], references: [id])
  @@index([listingId])
}
model Holding {
  id        String  @id @default(cuid()) @map("_id")
  closingId String?
  userId    String
  user      User    @relation(fields: [userId], references: [id])
  @@unique([closingId, userId])
}`);
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  assert.deepEqual(byName.get("Closing_deskBidId_key")?.partialFilterExpression, { deskBidId: { $gt: "" } });
  assert.equal(byName.get("Closing_code_key")?.partialFilterExpression, undefined);
  assert.deepEqual(byName.get("Holding_closingId_userId_key")?.partialFilterExpression, { closingId: { $gt: "" } });
  assert.ok(byName.has("Closing_listingId_idx"));
  assert.ok(byName.has("Holding_userId_idx"), "a foreign key without an index gets one");
  assert.equal(specs.filter((spec) => spec.collection === "Closing" && Object.keys(spec.key)[0] === "listingId").length, 1);
});

test("a release build requires the production env and refuses demo admin", () => {
  const env = {
    DATABASE_URL: atlas,
    AUTH_SECRET: "a-real-production-secret-value",
    NEXT_PUBLIC_APP_URL: "https://desk.example.com",
    ADMIN_EMAIL: "desk@example.com",
    ADMIN_PASSWORD: "correct horse battery",
    CRON_SECRET: "another-long-cron-secret",
    BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_test",
    OFAC_SDN_URL: "https://example.org/SDN.CSV",
  };
  assert.doesNotThrow(() => assertReleaseEnv(env));
  assert.throws(() => assertReleaseEnv({ ...env, OFAC_SDN_URL: "" }), /OFAC_SDN_URL/);
  assert.throws(() => assertReleaseEnv({ ...env, DATABASE_URL: atlas.replace("/upb_capital", "/synergifund") }), /synergifund/);
  assert.throws(() => assertReleaseEnv({ ...env, ADMIN_EMAIL: "iris@upbcapital.test" }), /demo/);
  assert.doesNotThrow(() => assertReleaseEnv({ ...env, DESK_EMAIL: "desk@example.com" }));
  assert.throws(() => assertReleaseEnv({ ...env, DESK_EMAIL: "iris@upbcapital.test" }), /DESK_EMAIL cannot be a demo/);
  assert.throws(() => assertReleaseEnv({ ...env, DESK_EMAIL: "not-an-email" }), /DESK_EMAIL is not/);
  assert.throws(() => assertReleaseEnv({ ...env, ADMIN_PASSWORD: "Desk1847!" }), /demo password/);
  assert.throws(() => assertReleaseEnv({ ...env, BLOB_READ_WRITE_TOKEN: undefined }), /missing/i);
  assert.throws(() => assertReleaseEnv({ ...env, NEXT_PUBLIC_APP_URL: "http://127.0.0.1:4317" }), /https/);
  assert.throws(() => assertReleaseEnv({ ...env, ALLOW_HTTP_SESSIONS: "1" }), /ALLOW_HTTP_SESSIONS/);
});
