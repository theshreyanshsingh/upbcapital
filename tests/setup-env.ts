// Loaded before every test file (see the test script in package.json). The Prisma client copies the local .env
// into process.env, so without this a test that stores a file, sends mail or opens a signature envelope would
// reach the real vendor. A key set to "" counts as set, so .env never fills it. A test that needs a vendor path
// sets its own key.
const VENDOR_KEYS = [
  "RESEND_API_KEY",
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "DESK_EMAIL",
  "BLOB_READ_WRITE_TOKEN",
  "BLOB_STORE_ID",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "DROPBOX_SIGN_API_KEY",
  "DOCUSIGN_ACCESS_TOKEN",
  "DOCUSIGN_ACCOUNT_ID",
  "DOCUSIGN_CONNECT_SECRET",
  "PERSONA_API_KEY",
  "PERSONA_TEMPLATE_ID",
  "PARALLEL_API_KEY",
  "LLM_API_KEY",
  "OPENAI_API_KEY",
  "ATTOM_API_KEY",
  "OFAC_API_KEY",
  "STRIPE_SECRET_KEY",
  "VAPID_PRIVATE_KEY",
  "REDIS_URL",
];

for (const key of VENDOR_KEYS) process.env[key] = "";

// Tests create, change and delete records, so they only ever run against a local database. Without this the Prisma
// client filled DATABASE_URL from .env, which names the Atlas database the live desk uses: on 2026-11-23 a full run
// there left test accounts, listings and notifications behind. TEST_DATABASE_URL may name another local database.
const LOCAL_TEST_DATABASE = "mongodb://localhost:27017/upb_capital_test?directConnection=true";
const testDatabase = process.env.TEST_DATABASE_URL || LOCAL_TEST_DATABASE;
const testHost = (() => {
  try {
    return new URL(testDatabase).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
})();
if (!["localhost", "127.0.0.1", "::1"].includes(testHost)) {
  throw new Error("The tests only run against a MongoDB on this computer. Set TEST_DATABASE_URL to a local database, or leave it unset for upb_capital_test on localhost:27017.");
}
process.env.DATABASE_URL = testDatabase;
