import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { checkApiKey, hashKey, mintKey } from "../lib/api-keys";
import { calendarTokenHash, userForCalendarToken } from "../lib/calendar-feed";
import { DEMO_SEAT_SHUT, demoDeskOpen, demoSeat, demoSeatShut, localOrigin, showDemoDesk } from "../lib/deploy";
import { prisma } from "../lib/prisma";
import { resolveSessionUser } from "../lib/seats";

const PUBLIC = "https://upbcapital.com";
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const made = { users: [] as string[], keys: [] as string[] };

// ---------------------------------------------------------------------------------------------------------------
// The rule, without the database

test("an origin is local when it is unset or names this machine or a reserved test host", () => {
  for (const url of [undefined, "", "  ", "http://localhost:4317", "http://LOCALHOST", "http://127.0.0.1:4317", "http://[::1]:4317", "https://desk.localhost", "http://app.upb.localhost:3000", "https://desk.upbcapital.test", "http://upb.test/"]) {
    assert.equal(localOrigin(url), true, String(url));
  }
  for (const url of [PUBLIC, "https://www.upbcapital.com", "http://upbcapital.com", "http://3.14.15.92:3009", "http://127.0.0.2", "http://localhost.example.com", "https://test.example.com", "https://example.testing", "localhost:4317", "not a url"]) {
    assert.equal(localOrigin(url), false, url);
  }
});

test("the demo desk opens on a local origin or with DEMO_DESK=1, and never in a release build", () => {
  assert.equal(demoDeskOpen({}), true);
  assert.equal(demoDeskOpen({ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "http://localhost:4318" }), true);
  assert.equal(demoDeskOpen({ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: PUBLIC }), false);
  assert.equal(demoDeskOpen({ NEXT_PUBLIC_APP_URL: PUBLIC, DEMO_DESK: "1" }), true);
  assert.equal(demoDeskOpen({ NEXT_PUBLIC_APP_URL: PUBLIC, DEMO_DESK: "true" }), false, "only 1 opts in");
  assert.equal(demoDeskOpen({ NEXT_PUBLIC_APP_URL: PUBLIC, DEMO_DESK: "0" }), false);
  assert.equal(demoDeskOpen({ UPB_RELEASE: "1" }), false);
  assert.equal(demoDeskOpen({ UPB_RELEASE: "1", DEMO_DESK: "1" }), false);
  assert.equal(demoDeskOpen({ VERCEL: "1", NEXT_PUBLIC_APP_URL: "http://localhost:4317" }), false);
});

test("the sign-in page's demo panel shows only where the demo seats may sign in", () => {
  assert.equal(showDemoDesk({ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: PUBLIC }, 8), false);
  assert.equal(showDemoDesk({ NODE_ENV: "production", NEXT_PUBLIC_APP_URL: PUBLIC, DEMO_DESK: "1" }, 8), true);
  assert.equal(showDemoDesk({ NEXT_PUBLIC_APP_URL: "http://localhost:4317" }, 8), true);
  assert.equal(showDemoDesk({ NEXT_PUBLIC_APP_URL: "http://localhost:4317" }, 0), false);
  assert.equal(showDemoDesk({ UPB_RELEASE: "1", DEMO_DESK: "1" }, 8), false);
});

test("a demo address is shut out on a public origin, and only a demo address", () => {
  const live = { NODE_ENV: "production", NEXT_PUBLIC_APP_URL: PUBLIC };
  for (const email of ["iris@upbcapital.test", " IRIS@UPBCAPITAL.TEST ", "desk@harborline.test", "credit@southshore.test", "anyone@upbcapital.test"]) {
    assert.equal(demoSeatShut(email, live), true, email);
    assert.equal(demoSeatShut(email, { ...live, DEMO_DESK: "1" }), false, email);
    assert.equal(demoSeatShut(email, { NEXT_PUBLIC_APP_URL: "http://localhost:4317" }), false, email);
  }
  for (const email of ["someone@example.com", "desk@harborline.com", "", null, undefined]) assert.equal(demoSeatShut(email, live), false, String(email));
  // A release build is left as it was: no demo seats, and no new refusal either.
  assert.equal(demoSeatShut("iris@upbcapital.test", { UPB_RELEASE: "1", NEXT_PUBLIC_APP_URL: PUBLIC }), false);
  assert.equal(demoSeat("iris@upbcapital.test", { UPB_RELEASE: "1" }), false);
  assert.match(DEMO_SEAT_SHUT, /local copy/);
});

// ---------------------------------------------------------------------------------------------------------------
// Everywhere a session or key is checked, against the database

function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const shut = { NEXT_PUBLIC_APP_URL: PUBLIC, DEMO_DESK: undefined, UPB_RELEASE: undefined, VERCEL: undefined };
const optedIn = { ...shut, DEMO_DESK: "1" };
const local = { ...shut, NEXT_PUBLIC_APP_URL: "http://localhost:4317" };

async function account(email: string, data: Record<string, unknown> = {}) {
  const user = await prisma.user.create({
    data: { email, name: `Demo gate ${tag}`, role: "BUYER", accountStatus: "APPROVED", passwordHash: "x", emailConfirmedAt: new Date(), ...data },
  });
  made.users.push(user.id);
  return user;
}

let world: Awaited<ReturnType<typeof build>>;

async function build() {
  const calendarToken = randomBytes(32).toString("hex");
  const demo = await account(`demo-gate-${tag}@upbcapital.test`, { calendarTokenHash: calendarTokenHash(calendarToken) });
  const real = await account(`demo-gate-${tag}@example.org`);
  // A seat with its own real address, acting for a demo firm.
  const seat = await account(`demo-gate-seat-${tag}@example.org`, { principalId: demo.id, seatRole: "TRADE", seatAddedById: demo.id, seatAddedAt: new Date() });
  const minted = mintKey();
  const key = await prisma.apiKey.create({ data: { userId: demo.id, name: `Demo gate ${tag}`, prefix: minted.prefix, hash: minted.hash } });
  made.keys.push(key.id);
  const realMinted = mintKey();
  const realKey = await prisma.apiKey.create({ data: { userId: real.id, name: `Demo gate ${tag}`, prefix: realMinted.prefix, hash: realMinted.hash } });
  made.keys.push(realKey.id);
  return { demo, real, seat, calendarToken, token: minted.token, realToken: realMinted.token };
}

test.before(async () => {
  world = await build();
});

test.after(async () => {
  await prisma.apiCall.deleteMany({ where: { OR: [{ keyId: { in: made.keys } }, { userId: { in: made.users } }] } });
  await prisma.apiKey.deleteMany({ where: { id: { in: made.keys } } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: made.users } }, { actorId: { in: made.users } }] } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
  await prisma.$disconnect();
});

test("on a public origin a demo seat's session resolves to nobody, and so does a seat acting for one", async () => {
  await withEnv(shut, async () => {
    assert.equal(await resolveSessionUser(world.demo.id), null);
    assert.equal(await resolveSessionUser(world.seat.id), null);
    assert.equal((await resolveSessionUser(world.real.id))?.user.id, world.real.id, "a real account is untouched");
  });
  for (const env of [optedIn, local]) {
    await withEnv(env, async () => {
      assert.equal((await resolveSessionUser(world.demo.id))?.user.id, world.demo.id);
      const seat = await resolveSessionUser(world.seat.id);
      assert.equal(seat?.user.id, world.demo.id);
      assert.equal(seat?.user.actor?.id, world.seat.id);
    });
  }
});

test("on a public origin a demo seat's API key (and so its MCP connector) and calendar link stop", async () => {
  await withEnv(shut, async () => {
    const check = await checkApiKey(`Bearer ${world.token}`);
    assert.equal(check.ok, false);
    assert.equal(check.ok ? 0 : check.status, 401);
    assert.match(check.ok ? "" : check.error, /demo account/);
    assert.equal((await checkApiKey(`Bearer ${world.realToken}`)).ok, true, "a real account's key still works");
    assert.equal(await userForCalendarToken(world.calendarToken), null);
  });
  // A refused key records nothing.
  assert.equal((await prisma.apiKey.findUnique({ where: { hash: hashKey(world.token) } }))?.lastUsedAt ?? null, null);
  await withEnv(optedIn, async () => {
    const check = await checkApiKey(`Bearer ${world.token}`);
    assert.equal(check.ok && check.user.id, world.demo.id);
    assert.equal((await userForCalendarToken(world.calendarToken))?.id, world.demo.id);
  });
});
