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
