import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { GET as getHoldings } from "../app/api/v1/holdings/route";
import { BUYER_SCOPES, mintKey } from "../lib/api-keys";
import { addressHash, apiLogSettled, callsCsv, callsDownload, firstRefusal, loggedPath, purgeApiCalls, recentCalls } from "../lib/api-log";
import { prisma } from "../lib/prisma";
import {
  EMPTY_SECURITY_PACK,
  NOT_IN_PLACE,
  NOT_SET,
  auditStatement,
  packDownload,
  packFacts,
  packText,
  questionnaire,
  questionnaireCsv,
  readSecurityPack,
  saveSecurityPack,
  securityPackFrom,
  vendorPackPdf,
  type PackFacts,
} from "../lib/vendor-pack";

const DAY = 24 * 60 * 60 * 1000;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const made = { users: [] as string[], keys: [] as string[] };
const SECRET = `vendor-pack-secret-${tag}`;
const savedSecret = process.env.AUTH_SECRET;
const savedHops = process.env.TRUSTED_PROXY_HOPS;
const NOW = new Date("2026-11-20T15:00:00.000Z");

type Role = "BUYER" | "INSTITUTIONAL_SELLER" | "BROKER" | "ADMIN";

async function person(who: string, role: Role, data: Partial<Prisma.UserCreateInput> = {}) {
  const user = await prisma.user.create({
    data: {
      email: `vendor-pack-${who}-${tag}@example.org`,
      name: `Vendor Pack ${who} ${tag}`,
      role,
      accountStatus: "APPROVED",
      passwordHash: "x",
      ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      ...data,
    },
  });
  made.users.push(user.id);
  return user;
}

async function key(userId: string, scopes = BUYER_SCOPES.join(",")) {
  const minted = mintKey();
  const row = await prisma.apiKey.create({ data: { userId, name: `Key ${tag}`, prefix: minted.prefix, hash: minted.hash, scopes } });
  made.keys.push(row.id);
  return { token: minted.token, id: row.id, prefix: minted.prefix };
}

function call(path: string, token: string, address = "203.0.113.7") {
  const request = new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": address } });
  return getHoldings(request);
}

// The facts with the desk's own fields replaced, so a test never changes the shared settings row to read a pack.
async function factsWith(pack: Partial<typeof EMPTY_SECURITY_PACK>, env: Record<string, string | undefined> = {}): Promise<PackFacts> {
  const facts = await packFacts({ now: NOW, env });
  return { ...facts, pack: { ...EMPTY_SECURITY_PACK, ...pack } };
}

test.before(() => {
  process.env.AUTH_SECRET = SECRET;
  process.env.TRUSTED_PROXY_HOPS = "1";
});

test.after(async () => {
  await apiLogSettled();
  await prisma.apiCall.deleteMany({ where: { OR: [{ keyId: { in: made.keys } }, { userId: { in: made.users } }] } });
  await prisma.apiKey.deleteMany({ where: { id: { in: made.keys } } });
  await prisma.auditEvent.deleteMany({ where: { actorId: { in: made.users } } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  if (savedSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedSecret;
  if (savedHops === undefined) delete process.env.TRUSTED_PROXY_HOPS;
  else process.env.TRUSTED_PROXY_HOPS = savedHops;
});

// ---------------------------------------------------------------------------------------------------------------
// The vendor pack

test("without a pen test the pack says Not yet in place, and a recorded test is named", async () => {
  const bare = await factsWith({});
  const text = packText(bare);
  assert.match(text, /Penetration test: Not yet in place\. No outside firm has tested these controls\./);
  assert.match(text, /SOC 2 report: Not yet in place\./);
  assert.match(text, /Cyber insurance: Not set by the desk\./);
  assert.match(text, /Recovery time objective: Not set by the desk\./);
  assert.match(text, /Recovery point objective: Not set by the desk\./);
  assert.match(text, /Incident contact: Not set by the desk\./);
  assert.match(text, /At rest: per the hosting and database provider's defaults/);
  assert.match(text, /UPB Capital's own statement, .* For counsel and security review\./);
  assert.match(auditStatement(bare.pack), /No outside firm has tested these controls/);

  const tested = await factsWith({ penTestDate: "2026-10-01", penTestFirm: `Acme Security ${tag}`, cyberInsurer: "Example Mutual", rtoHours: 24, rpoHours: 4, incidentContact: "security@example.org" });
  const after = packText(tested);
  assert.match(after, new RegExp(`the last outside test was on 2026-10-01, by Acme Security ${tag}`));
  assert.doesNotMatch(after, /Penetration test: Not yet in place/);
  assert.match(after, /Recovery time objective: 24 hours, as set by the desk\./);
  assert.match(after, /Recovery point objective: 4 hours, as set by the desk\./);
  assert.match(after, /Cyber insurance: Example Mutual, as recorded by the desk\./);
  assert.match(after, /Incident contact: security@example\.org\./);
  // SOC 2 has no desk field, so it stays not in place whatever else is set.
  assert.match(after, /SOC 2 report: Not yet in place\./);
  assert.match(auditStatement(tested.pack), new RegExp(`2026-10-01, by Acme Security ${tag}`));

  const pdf = await vendorPackPdf(tested);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.length > 2000);
});

test("the pack reads the outside services, the sanctions list and https from the configuration", async () => {
  const live = await factsWith({}, { NEXT_PUBLIC_APP_URL: "https://upb.example", NODE_ENV: "production", OFAC_SDN_URL: "https://www.treasury.gov/ofac/downloads/SDN.CSV", HOSTING_PROVIDER: "Example Cloud" });
  const text = packText(live);
  assert.match(text, /In transit: the site's address is https/);
  assert.match(text, /Sanctions list: the US Treasury SDN list/);
  assert.match(text, /Hosting: In use\. Example Cloud\./);
  assert.match(text, /Servers: Example Cloud\./);

  const bare = packText(await factsWith({}, {}));
  assert.match(bare, /In transit: the site's configured address is not https/);
  assert.match(bare, /Sanctions list: Not yet in place\. A short built-in list stands in/);
  assert.match(bare, /Servers: a host the configuration doesn't name\./);
});

test("the questionnaire answers come from the facts, with no invented Yes", async () => {
  const bare = questionnaire(await factsWith({}, {}));
  assert.ok(bare.length >= 38 && bare.length <= 50, `about 40 questions, got ${bare.length}`);
  assert.equal(new Set(bare.map((row) => row.id)).size, bare.length);
  for (const row of bare) {
    assert.ok(["Yes", "No", "Partial"].includes(row.answer), row.id);
    assert.ok(row.explanation.length > 3, row.id);
    // A missing fact is never answered Yes.
    if (row.explanation.includes(NOT_IN_PLACE) || row.explanation.includes(NOT_SET)) assert.notEqual(row.answer, "Yes", row.id);
  }
  const answer = (rows: typeof bare, start: string) => rows.find((row) => row.question.startsWith(start))!;
  assert.equal(answer(bare, "Has an outside firm run a penetration test").answer, "No");
  assert.equal(answer(bare, "Does UPB have a SOC 2 report").answer, "No");
  assert.equal(answer(bare, "Does UPB carry cyber insurance").answer, "No");
  assert.equal(answer(bare, "Is a recovery time objective set").answer, "No");
  assert.equal(answer(bare, "Is a recovery point objective set").answer, "No");
  assert.equal(answer(bare, "Is there a named contact for security incidents").answer, "No");
  assert.equal(answer(bare, "Is there a written incident response plan").answer, "No");
  assert.equal(answer(bare, "Is screening done against a real sanctions list").answer, "No");
  assert.equal(answer(bare, "Is data encrypted in transit").answer, "Partial");
  assert.equal(answer(bare, "Is data encrypted at rest").answer, "Partial");
  assert.equal(answer(bare, "Is the hosting provider named").answer, "No");

  const facts = await factsWith(
    { penTestDate: "2026-10-01", penTestFirm: "Acme Security", cyberInsurer: "Example Mutual", rtoHours: 24, rpoHours: 4, incidentContact: "security@example.org" },
    { NEXT_PUBLIC_APP_URL: "https://upb.example", NODE_ENV: "production", OFAC_SDN_URL: "https://www.treasury.gov/ofac/downloads/SDN.CSV", HOSTING_PROVIDER: "Example Cloud" },
  );
  const set = questionnaire(facts);
  assert.equal(answer(set, "Has an outside firm run a penetration test").answer, "Yes");
  assert.equal(answer(set, "Does UPB carry cyber insurance").answer, "Yes");
  assert.equal(answer(set, "Is a recovery time objective set").answer, "Yes");
  assert.equal(answer(set, "Is there a named contact for security incidents").answer, "Yes");
  assert.equal(answer(set, "Is screening done against a real sanctions list").answer, "Yes");
  assert.equal(answer(set, "Is data encrypted in transit").answer, "Yes");
  assert.equal(answer(set, "Is the hosting provider named").answer, "Yes");
  // What the desk can't set by hand stays as the code has it.
  assert.equal(answer(set, "Does UPB have a SOC 2 report").answer, "No");
  assert.equal(answer(set, "Is there a written business continuity").answer, "No");
  assert.equal(answer(set, "Is data encrypted at rest").answer, "Partial");
  // A test more than a year old is only Partial.
  const stale = questionnaire({ ...facts, pack: { ...facts.pack, penTestDate: "2025-06-01" } });
  assert.equal(answer(stale, "Has an outside firm run a penetration test").answer, "Partial");

  const csv = questionnaireCsv(facts).split("\n");
  assert.equal(csv[0], "id,area,question,answer,explanation,as_of,source");
  assert.equal(csv.length, set.length + 1);
  assert.ok(csv.slice(1).every((line) => line.includes("2026-11-20")));
});

test("downloads are refused to signed-out and unapproved accounts and allowed to an approved buyer", async () => {
  const buyer = await person("buyer", "BUYER");
  const pending = await person("pending", "BUYER", { accountStatus: "PENDING" });
  const broker = await person("broker", "BROKER");
  const desk = await person("desk", "ADMIN", { deskRole: "ANALYST" });

  const signedOut = await packDownload(null, "pdf", { now: NOW });
  assert.equal(signedOut.status, 401);
  assert.match(await signedOut.text(), /ask the desk/);
  assert.equal((await packDownload(pending, "pdf", { now: NOW })).status, 403);
  assert.equal((await packDownload(broker, "csv", { now: NOW })).status, 403);
  assert.equal((await packDownload(buyer, "xls", { now: NOW })).status, 400);

  const pdf = await packDownload(buyer, null, { now: NOW });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.match(pdf.headers.get("content-disposition") ?? "", /upb-vendor-pack-2026-11-20\.pdf/);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");

  const csv = await packDownload(buyer, "csv", { now: NOW });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(await csv.text(), /^id,area,question,answer,explanation/);
  assert.equal((await packDownload(desk, "pdf", { now: NOW })).status, 200);

  const audits = await prisma.auditEvent.findMany({ where: { actorId: buyer.id, action: "VENDOR_PACK_DOWNLOAD" } });
  assert.deepEqual(audits.map((row) => row.detail).sort(), ["PDF, as of 2026-11-20", "Questionnaire CSV, as of 2026-11-20"]);
  assert.equal(await prisma.auditEvent.count({ where: { actorId: { in: [pending.id, broker.id] }, action: "VENDOR_PACK_DOWNLOAD" } }), 0);
});

test("the desk's vendor pack facts are checked, saved and audited", async () => {
  const ok = securityPackFrom({ penTestDate: "2026-10-01", penTestFirm: " Acme  Security ", cyberInsurer: "Example Mutual", rtoHours: "24h", rpoHours: "0.5", incidentContact: "Jo Smith, security@example.org" }, NOW);
  assert.equal(ok.error, null);
  if (ok.error === null) {
    assert.deepEqual(ok.pack, { penTestDate: "2026-10-01", penTestFirm: "Acme Security", cyberInsurer: "Example Mutual", rtoHours: 24, rpoHours: 0.5, incidentContact: "Jo Smith, security@example.org" });
  }
  const blank = securityPackFrom({}, NOW);
  assert.equal(blank.error, null);
  if (blank.error === null) assert.deepEqual(blank.pack, EMPTY_SECURITY_PACK);

  const refused: [Record<string, string>, RegExp][] = [
    [{ penTestDate: "2026-13-01", penTestFirm: "Acme" }, /YYYY-MM-DD/],
    [{ penTestDate: "2026-12-01", penTestFirm: "Acme" }, /no later than today/],
    [{ penTestDate: "2026-10-01" }, /Name the firm/],
    [{ penTestFirm: "Acme" }, /date of the penetration test/],
    [{ rtoHours: "0" }, /more than 0/],
    [{ rpoHours: "721" }, /at most 720/],
    [{ rtoHours: "soon" }, /Recovery targets are hours/],
    [{ incidentContact: "call the office" }, /email address or a phone number/],
    [{ cyberInsurer: "x".repeat(121) }, /under 120/],
  ];
  for (const [input, message] of refused) {
    const result = securityPackFrom(input, NOW);
    assert.notEqual(result.error, null, JSON.stringify(input));
    assert.match(result.error ?? "", message);
  }
  assert.equal(securityPackFrom({ incidentContact: "+1 (555) 010-2030" }, NOW).error, null);

  // A stored value written by hand, or one from before the field, reads as nothing set.
  assert.deepEqual(readSecurityPack(null), EMPTY_SECURITY_PACK);
  assert.deepEqual(readSecurityPack(["x"]), EMPTY_SECURITY_PACK);
  assert.deepEqual(readSecurityPack({ penTestDate: "soon", rtoHours: "24", rpoHours: -1 }), EMPTY_SECURITY_PACK);

  const desk = await person("compliance", "ADMIN", { deskRole: "COMPLIANCE" });
  const before = (await prisma.platformSettings.findUnique({ where: { id: "default" }, select: { securityPack: true } }))?.securityPack ?? null;
  try {
    const saved = await saveSecurityPack(desk, { penTestDate: "2026-10-01", penTestFirm: `Acme ${tag}`, rtoHours: "12", incidentContact: "security@example.org" }, NOW);
    assert.deepEqual(saved, { error: null, changed: true });
    const stored = readSecurityPack((await prisma.platformSettings.findUniqueOrThrow({ where: { id: "default" } })).securityPack);
    assert.equal(stored.penTestFirm, `Acme ${tag}`);
    assert.equal(stored.rtoHours, 12);
    assert.equal(stored.cyberInsurer, null);
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { actorId: desk.id, action: "SECURITY_PACK" } });
    assert.match(event.detail, new RegExp(`pen test firm .* to Acme ${tag}`));
    assert.match(event.detail, /RTO hours .* to 12/);
    // Saving the same facts again changes nothing and writes nothing.
    assert.deepEqual(await saveSecurityPack(desk, { penTestDate: "2026-10-01", penTestFirm: `Acme ${tag}`, rtoHours: "12", incidentContact: "security@example.org" }, NOW), { error: null, changed: false });
    assert.equal(await prisma.auditEvent.count({ where: { actorId: desk.id, action: "SECURITY_PACK" } }), 1);
    const bad = await saveSecurityPack(desk, { rtoHours: "-3" }, NOW);
    assert.match(bad.error ?? "", /Recovery targets/);
  } finally {
    await prisma.platformSettings.update({ where: { id: "default" }, data: { securityPack: before as Prisma.InputJsonValue | null } });
    const { clearSettingsCache } = await import("../lib/settings");
    clearSettingsCache();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The API call log

test("a v1 call is logged with a keyed hash of the address and the query's values left out", async () => {
  assert.equal(loggedPath("http://localhost/api/v1/listings?state=FL&limit=50&state=GA"), "/api/v1/listings?state&limit");
  assert.equal(loggedPath("http://localhost/api/v1/holdings"), "/api/v1/holdings");
  assert.equal(addressHash("203.0.113.7", ""), "");
  assert.notEqual(addressHash("203.0.113.7", "one"), addressHash("203.0.113.7", "two"));

  const buyer = await person("caller", "BUYER");
  const minted = await key(buyer.id);
  const response = await call(`/api/v1/holdings?limit=5&updated_since=2026-01-01T00:00:00Z`, minted.token, "198.51.100.1, 203.0.113.7");
  assert.equal(response.status, 200);
  await apiLogSettled();
  const rows = await prisma.apiCall.findMany({ where: { keyId: minted.id } });
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.userId, buyer.id);
  assert.equal(row.method, "GET");
  assert.equal(row.path, "/api/v1/holdings?limit&updated_since");
  assert.equal(row.status, 200);
  // The nearest proxy's entry, hashed with the server's secret. Neither the address nor the query's values are kept.
  assert.equal(row.ipHash, addressHash("203.0.113.7", SECRET));
  assert.ok(row.ipHash.length > 10);
  assert.doesNotMatch(JSON.stringify(row), /203\.0\.113\.7|198\.51\.100\.1|2026-01-01/);
});

test("a call the key check lets through is logged with the route's own answer", async () => {
  const { GET: getListing } = await import("../app/api/v1/listings/[id]/route");
  const buyer = await person("routed", "BUYER");
  const minted = await key(buyer.id, "listings:read");
  const request = new Request("http://localhost/api/v1/listings/nolisting", { headers: { authorization: `Bearer ${minted.token}`, "x-forwarded-for": "203.0.113.7" } });
  const response = await getListing(request, { params: Promise.resolve({ id: "nolisting" }) });
  assert.equal(response.status, 404);
  await apiLogSettled();
  const rows = await prisma.apiCall.findMany({ where: { keyId: minted.id } });
  assert.deepEqual(rows.map((row) => [row.path, row.status]), [["/api/v1/listings/nolisting", 404]]);
});

test("refused calls are logged against the key, and an unknown key logs nothing", async () => {
  const buyer = await person("refused", "BUYER");
  const narrow = await key(buyer.id, "listings:read");
  const scoped = await call("/api/v1/holdings", narrow.token);
  assert.equal(scoped.status, 403);
  const revoked = await key(buyer.id);
  await prisma.apiKey.update({ where: { id: revoked.id }, data: { revokedAt: new Date() } });
  const dead = await call("/api/v1/holdings?cursor=abc", revoked.token);
  assert.equal(dead.status, 401);
  const unknown = await call("/api/v1/holdings", `upb_${"0".repeat(48)}`, "192.0.2.99");
  assert.equal(unknown.status, 401);
  await apiLogSettled();
  // A key that isn't on file has no owner to log against.
  assert.equal(await prisma.apiCall.count({ where: { ipHash: addressHash("192.0.2.99", SECRET) } }), 0);

  const refusedRows = await prisma.apiCall.findMany({ where: { keyId: { in: [narrow.id, revoked.id] } }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(refusedRows.map((row) => [row.keyId, row.status, row.path]), [
    [narrow.id, 403, "/api/v1/holdings"],
    [revoked.id, 401, "/api/v1/holdings?cursor"],
  ]);
  assert.ok(refusedRows.every((row) => row.userId === buyer.id && row.ipHash === addressHash("203.0.113.7", SECRET)));

  // Past the allowance, or on a dead key, the first refusal of each minute is logged.
  const start = Date.UTC(2026, 10, 20, 12, 0, 0);
  const ref = `ref-${tag}`;
  assert.equal(firstRefusal(ref, 429, start), true);
  assert.equal(firstRefusal(ref, 429, start + 30_000), false);
  assert.equal(firstRefusal(ref, 401, start + 30_000), true);
  assert.equal(firstRefusal(ref, 429, start + 60_000), true);
});

test("the daily job removes calls older than 90 days, and running it again removes nothing more", async () => {
  const seller = await person("cleanup", "INSTITUTIONAL_SELLER");
  const minted = await key(seller.id, "tapes:write,offers:read");
  const base = { keyId: minted.id, userId: seller.id, method: "GET", path: "/api/v1/offers", status: 200, ipHash: "" };
  const old = await prisma.apiCall.create({ data: { ...base, createdAt: new Date(NOW.getTime() - 91 * DAY) } });
  const kept = await prisma.apiCall.create({ data: { ...base, createdAt: new Date(NOW.getTime() - 89 * DAY) } });
  const first = await purgeApiCalls(NOW);
  assert.match(first, /^API call log removed \d+ calls? older than 90 days$/);
  assert.equal(await prisma.apiCall.count({ where: { id: old.id } }), 0);
  assert.equal(await prisma.apiCall.count({ where: { id: kept.id } }), 1);
  assert.equal(await purgeApiCalls(NOW), "API call log removed 0 calls older than 90 days");
  assert.equal(await prisma.apiCall.count({ where: { id: kept.id } }), 1);
});

test("an account sees only its own keys' calls, and only the desk's compliance role reads another's", async () => {
  const mine = await person("owner", "BUYER");
  const theirs = await person("other", "BUYER");
  const myKey = await key(mine.id);
  const theirKey = await key(theirs.id);
  const at = new Date();
  await prisma.apiCall.createMany({
    data: [
      { keyId: myKey.id, userId: mine.id, method: "GET", path: `/api/v1/listings?mine${tag}`, status: 200, ipHash: "", createdAt: at },
      { keyId: theirKey.id, userId: theirs.id, method: "GET", path: `/api/v1/listings?theirs${tag}`, status: 200, ipHash: "", createdAt: at },
      // A row naming the owner's key under someone else's account is not the owner's to read.
      { keyId: myKey.id, userId: theirs.id, method: "GET", path: `/api/v1/listings?crossed${tag}`, status: 200, ipHash: "", createdAt: at },
    ],
  });

  const groups = await recentCalls(mine.id);
  assert.deepEqual(groups.map((group) => group.key.id), [myKey.id]);
  assert.deepEqual(groups[0].calls.map((row) => row.path), [`/api/v1/listings?mine${tag}`]);
  const csv = await callsCsv(mine.id);
  assert.equal(csv.rows, 1);
  assert.match(csv.csv, new RegExp(`mine${tag}`));
  assert.doesNotMatch(csv.csv, new RegExp(`theirs${tag}|crossed${tag}|${theirKey.prefix}`));
  assert.equal((await callsCsv(theirs.id)).csv.includes(`mine${tag}`), false);

  // The download: the owner's own; another account's only for the desk's compliance role.
  assert.equal((await callsDownload(null, null)).status, 401);
  const own = await callsDownload(mine, null);
  assert.equal(own.status, 200);
  assert.match(await own.text(), new RegExp(`mine${tag}`));
  assert.equal((await callsDownload(mine, theirs.id)).status, 403);
  const analyst = await person("analyst", "ADMIN", { deskRole: "ANALYST" });
  assert.equal((await callsDownload(analyst, mine.id)).status, 403);
  const compliance = await person("vetting", "ADMIN", { deskRole: "COMPLIANCE" });
  const desk = await callsDownload(compliance, mine.id);
  assert.equal(desk.status, 200);
  assert.match(await desk.text(), new RegExp(`mine${tag}`));
  assert.equal(await prisma.auditEvent.count({ where: { actorId: compliance.id, action: "API_LOG_EXPORT", entityId: mine.id } }), 1);
  assert.equal(await prisma.auditEvent.count({ where: { actorId: mine.id, action: "API_LOG_EXPORT", entityId: mine.id } }), 1);
});
