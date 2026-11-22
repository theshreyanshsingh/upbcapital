import assert from "node:assert/strict";
import test from "node:test";
import type { Prisma } from "@prisma/client";
import { DELETE as deleteMcp, GET as getMcp, POST as postMcp } from "../app/api/mcp/route";
import { GET as getListings } from "../app/api/v1/listings/route";
import { BUYER_SCOPES, hashKey, mintKey } from "../lib/api-keys";
import { addressHash, apiLogSettled } from "../lib/api-log";
import { MCP_TOOLS, MCP_VERSIONS, RPC_ERRORS, answerMcp, argumentProblem, toolUrl, type McpTool, type ToolResult } from "../lib/mcp";
import { prisma } from "../lib/prisma";
import { limitStore } from "../lib/rate-limit";

const HOUR = 60 * 60 * 1000;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
// No real state starts with J, and no other test file uses one, so a filter on it finds only these fixtures.
const STATE = `J${String.fromCharCode(65 + Math.floor(Math.random() * 26))}`;
const made = { users: [] as string[], listings: [] as string[], keys: [] as string[], tokens: [] as string[] };

type Rpc = { jsonrpc: string; id: string | number | null; result?: Record<string, unknown>; error?: { code: number; message: string } };

// ---------------------------------------------------------------------------------------------------------------
// The protocol, without the database: a runner that records what it was asked stands in for the API.

function recorder() {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const run = async (tool: McpTool, args: Record<string, unknown>): Promise<ToolResult> => {
    calls.push({ tool: tool.name, args });
    return { content: [{ type: "text", text: "{}" }], structuredContent: {} };
  };
  return { calls, run };
}

const rpc = (method: string, params?: Record<string, unknown>, id: string | number = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

test("initialize answers the client's protocol version when it is spoken here, else the newest", async () => {
  const { run } = recorder();
  for (const asked of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
    const reply = await answerMcp(rpc("initialize", { protocolVersion: asked, capabilities: {}, clientInfo: { name: "test", version: "1" } }), run);
    assert.equal(reply.status, 200);
    assert.equal((reply.body as Rpc).result?.protocolVersion, asked);
  }
  for (const asked of ["2099-01-01", undefined, 7]) {
    const reply = await answerMcp(rpc("initialize", { protocolVersion: asked }), run);
    assert.equal((reply.body as Rpc).result?.protocolVersion, MCP_VERSIONS[0], String(asked));
  }
  const body = (await answerMcp(rpc("initialize", { protocolVersion: "2025-06-18" }, "init-1"), run)).body as Rpc;
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, "init-1");
  assert.deepEqual(body.result?.serverInfo, { name: "upb-capital", version: "1.0.0" });
  assert.deepEqual(body.result?.capabilities, { tools: {} });
  assert.match(String(body.result?.instructions), /read-only/);
  assert.match(String(body.result?.instructions), /cannot bid/);
});

test("notifications and client answers get 202 with no body; ping answers empty", async () => {
  const { run, calls } = recorder();
  for (const raw of [
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } }),
    JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "search_listings" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} }),
  ]) {
    assert.deepEqual(await answerMcp(raw, run), { status: 202, body: null }, raw);
  }
  // A tools/call sent as a notification runs nothing.
  assert.equal(calls.length, 0);
  assert.deepEqual(await answerMcp(rpc("ping", undefined, 4), run), { status: 200, body: { jsonrpc: "2.0", id: 4, result: {} } });
});

test("bad JSON, a batch, an invalid message and an unknown method get JSON-RPC errors", async () => {
  const { run } = recorder();
  const parse = await answerMcp("{not json", run);
  assert.equal(parse.status, 400);
  assert.deepEqual(parse.body, { jsonrpc: "2.0", id: null, error: { code: RPC_ERRORS.parse, message: "Parse error: the body isn't JSON." } });

  const batch = await answerMcp(`[${rpc("ping")},${rpc("tools/list", undefined, 2)}]`, run);
  assert.equal(batch.status, 400);
  assert.equal((batch.body as Rpc).error?.code, -32600);
  assert.match(String((batch.body as Rpc).error?.message), /Batches aren't supported/);

  for (const raw of ['"ping"', "null", JSON.stringify({ id: 1, method: "ping" }), JSON.stringify({ jsonrpc: "1.0", id: 1, method: "ping" }), JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }), JSON.stringify({ jsonrpc: "2.0", id: 1 })]) {
    const reply = await answerMcp(raw, run);
    assert.equal(reply.status, 400, raw);
    assert.equal((reply.body as Rpc).error?.code, -32600, raw);
  }

  const unknown = await answerMcp(rpc("resources/list", undefined, "r"), run);
  assert.equal(unknown.status, 200);
  assert.equal((unknown.body as Rpc).id, "r");
  assert.equal((unknown.body as Rpc).error?.code, -32601);

  // After initialize the client names its version on each request. One this server doesn't speak is refused.
  assert.equal((await answerMcp(rpc("tools/list"), run, "2025-06-18")).status, 200);
  const stale = await answerMcp(rpc("tools/list"), run, "2099-01-01");
  assert.equal(stale.status, 400);
  assert.equal((stale.body as Rpc).error?.code, -32600);
});

test("tools/list gives six read-only tools, each with an object schema", async () => {
  const { run } = recorder();
  const body = (await answerMcp(rpc("tools/list"), run)).body as Rpc;
  const tools = body.result?.tools as { name: string; title: string; description: string; inputSchema: { type: string; properties: Record<string, { type: string }>; required?: string[]; additionalProperties: boolean }; annotations: { readOnlyHint: boolean } }[];
  assert.deepEqual(tools.map((tool) => tool.name), ["search_listings", "get_listing", "list_matches", "list_offers", "get_offer", "list_holdings"]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    assert.ok(tool.description.length > 40, tool.name);
    assert.ok(tool.title, tool.name);
    // Only what the protocol defines: no route, endpoint or scope.
    assert.deepEqual(Object.keys(tool).sort(), ["annotations", "description", "inputSchema", "name", "title"]);
  }
  const search = tools[0].inputSchema.properties;
  for (const name of ["state", "lien_position", "payment_status", "loan_program", "cra", "max_ltv", "min_upb", "max_upb", "limit", "cursor", "updated_since"]) assert.ok(search[name], name);
  assert.deepEqual(tools[1].inputSchema.required, ["id"]);
  assert.deepEqual(tools[4].inputSchema.required, ["id"]);
});

test("tools/call checks the arguments and reads the v1 URL they make", async () => {
  const { run, calls } = recorder();
  const unknown = (await answerMcp(rpc("tools/call", { name: "place_bid", arguments: {} }), run)).body as Rpc;
  assert.equal(unknown.error?.code, -32602);
  assert.match(unknown.error?.message ?? "", /Unknown tool: place_bid/);

  for (const [name, args, why] of [
    ["search_listings", { limit: "10" }, /limit is a whole number/],
    ["search_listings", { limit: 2.5 }, /limit is a whole number/],
    ["search_listings", { lien_position: "FIRST" }, /lien_position is a list/],
    ["search_listings", { cra: "yes" }, /cra is true or false/],
    ["search_listings", { seller: "Acme" }, /takes no argument named seller/],
    ["get_listing", {}, /get_listing needs id/],
    ["get_offer", { id: "" }, /get_offer needs id/],
  ] as const) {
    const body = (await answerMcp(rpc("tools/call", { name, arguments: args }), run)).body as Rpc;
    assert.equal(body.result?.isError, true, JSON.stringify(args));
    assert.match((body.result?.content as { text: string }[])[0].text, why);
  }
  assert.equal(((await answerMcp(rpc("tools/call", { name: "list_offers", arguments: [1] }), run)).body as Rpc).result?.isError, true);
  assert.equal(calls.length, 0, "a refused call never reached the API");

  // Arguments left out are fine, and the runner gets them as sent.
  const ok = (await answerMcp(rpc("tools/call", { name: "list_matches" }), run)).body as Rpc;
  assert.equal(ok.result?.isError, undefined);
  assert.deepEqual(calls, [{ tool: "list_matches", args: {} }]);

  const search = MCP_TOOLS.find((tool) => tool.name === "search_listings")!;
  assert.equal(argumentProblem(search, { state: "FL", lien_position: ["FIRST"], cra: true, max_ltv: 80.5, limit: 10 }), null);
  const url = toolUrl(search, { state: "fl", lien_position: ["FIRST", "SECOND"], cra: true, max_ltv: 80, min_upb: null, cursor: "" }, "http://localhost/api/mcp");
  assert.equal(`${url.pathname}${url.search}`, "/api/v1/listings?state=fl&lien_position=FIRST%2CSECOND&cra=1&max_ltv=80");
  assert.equal(toolUrl(search, { cra: false }, "http://localhost/api/mcp").search, "");
  const one = MCP_TOOLS.find((tool) => tool.name === "get_listing")!;
  assert.equal(toolUrl(one, { id: "abc/../x" }, "https://upb.example/api/mcp").href, "https://upb.example/api/v1/listings/abc%2F..%2Fx");
});

// ---------------------------------------------------------------------------------------------------------------
// Through the route, with a real key

async function person(who: string, role: "BUYER" | "INSTITUTIONAL_SELLER", data: Partial<Prisma.UserCreateInput> = {}) {
  const user = await prisma.user.create({
    data: {
      email: `mcp-${who}-${tag}@example.org`,
      name: `MCP ${who} ${tag}`,
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

async function key(userId: string, scopes: string | null = BUYER_SCOPES.join(",")) {
  const minted = mintKey();
  const row = await prisma.apiKey.create({ data: { userId, name: `Key ${tag}`, prefix: minted.prefix, hash: minted.hash, ...(scopes == null ? {} : { scopes }) } });
  made.keys.push(row.id);
  made.tokens.push(minted.token);
  return { token: minted.token, id: row.id };
}

async function listing(sellerId: string, title: string, data: Partial<Prisma.ListingUncheckedCreateInput> = {}) {
  const row = await prisma.listing.create({
    data: {
      kind: "SINGLE",
      sellerId,
      status: "APPROVED",
      approvedAt: new Date(Date.now() - 2 * HOUR),
      // Already claimed, so nothing here sends the desk a standing-bid notice.
      standingBidsNotifiedAt: new Date(),
      title: `${title} ${tag}`,
      summary: "A test listing.",
      ...data,
      notes: {
        create: [{
          streetAddress: `9 Hidden Way ${tag}`, city: "Testville", state: STATE, zip: "99001", propertyType: "SFR", occupancy: "VACANT",
          lienPosition: "FIRST", upb: 150000, interestRate: 6.5, monthlyPi: 1100, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 90000, estimatedValue: 210000, borrowerName: `Borrower Hidden ${tag}`,
        }] as never,
      },
    },
  });
  made.listings.push(row.id);
  return row;
}

function post(body: unknown, token: string | null, headers: Record<string, string> = {}) {
  return postMcp(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": "203.0.113.9", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await post({ jsonrpc: "2.0", id: `${name}-call`, method: "tools/call", params: { name, arguments: args } }, token);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const body = (await response.json()) as Rpc;
  assert.equal(body.id, `${name}-call`);
  return body.result as ToolResult;
}

let world: Awaited<ReturnType<typeof build>>;

async function build() {
  const seller = await person("seller", "INSTITUTIONAL_SELLER");
  const buyer = await person("buyer", "BUYER");
  const open = await listing(seller.id, "MCP open");
  const second = await listing(seller.id, "MCP second");
  const hidden = await listing(seller.id, "MCP private", { visibility: "PRIVATE" });
  return { seller, buyer, open, second, hidden };
}

test.before(async () => {
  world = await build();
});

test.after(async () => {
  await apiLogSettled();
  const ids = made.listings;
  await prisma.apiCall.deleteMany({ where: { OR: [{ keyId: { in: made.keys } }, { userId: { in: made.users } }] } });
  await prisma.buyerHolding.deleteMany({ where: { userId: { in: made.users } } });
  await prisma.note.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listing.deleteMany({ where: { id: { in: ids } } });
  await prisma.apiKey.deleteMany({ where: { id: { in: made.keys } } });
  if (made.tokens.length) await prisma.rateWindow.deleteMany({ where: { OR: made.tokens.map((token) => ({ key: { startsWith: `api:${hashKey(token).slice(0, 32)}` } })) } });
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: [...ids, ...made.users] } }, { actorId: { in: made.users } }] } });
  await prisma.user.deleteMany({ where: { id: { in: made.users } } });
});

test("no key, an unknown key, or a seller's key is turned away before anything runs", async () => {
  const missing = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, null);
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("www-authenticate") ?? "", /^Bearer realm="upb-capital"/);
  const body = (await missing.json()) as Rpc;
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, null);
  assert.equal(body.error?.code, RPC_ERRORS.keyRefused);
  assert.match(body.error?.message ?? "", /Authorization: Bearer/);

  // A notification needs the key too.
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, null)).status, 401);
  const unknown = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, `upb_${"0".repeat(48)}`);
  assert.equal(unknown.status, 401);
  assert.match(unknown.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  assert.equal(((await unknown.json()) as Rpc).error?.message, "Unknown API key.");

  const revoked = await key(world.buyer.id);
  await prisma.apiKey.update({ where: { id: revoked.id }, data: { revokedAt: new Date() } });
  const dead = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, revoked.token);
  assert.equal(dead.status, 401);
  assert.match(((await dead.json()) as Rpc).error?.message ?? "", /revoked/);

  const sellerKey = await key(world.seller.id, null);
  const seller = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_offers" } }, sellerKey.token);
  assert.equal(seller.status, 403);
  assert.match(((await seller.json()) as Rpc).error?.message ?? "", /buyer account's key/);

  for (const handler of [getMcp, deleteMcp]) {
    const refused = handler();
    assert.equal(refused.status, 405);
    assert.equal(refused.headers.get("allow"), "POST");
  }
});

test("a session: initialize, the initialized notification, tools/list and ping, none of them an API call", async () => {
  const minted = await key(world.buyer.id);
  const init = await post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }, minted.token);
  assert.equal(init.status, 200);
  assert.equal(((await init.json()) as Rpc).result?.protocolVersion, "2025-03-26");
  const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, minted.token, { "mcp-protocol-version": "2025-03-26" });
  assert.equal(note.status, 202);
  assert.equal(await note.text(), "");
  const list = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, minted.token, { "mcp-protocol-version": "2025-03-26" });
  assert.equal((((await list.json()) as Rpc).result?.tools as unknown[]).length, 6);
  assert.equal((await post({ jsonrpc: "2.0", id: 2, method: "ping" }, minted.token)).status, 200);
  assert.equal((await post("{oops", minted.token)).status, 400);

  await apiLogSettled();
  assert.equal(await prisma.apiCall.count({ where: { keyId: minted.id } }), 0);
  const windows = { key: { startsWith: `api:${hashKey(minted.token).slice(0, 32)}` } };
  if (limitStore() === "database") assert.equal(await prisma.rateWindow.count({ where: windows }), 0);

  // A tool call is one API call: logged with the v1 path, and counted against the key's allowance.
  const result = await callTool(minted.token, "list_holdings", { limit: 5 });
  assert.equal(result.isError, undefined);
  await apiLogSettled();
  const rows = await prisma.apiCall.findMany({ where: { keyId: minted.id } });
  assert.deepEqual(rows.map((row) => [row.method, row.path, row.status, row.userId]), [["GET", "/api/v1/holdings?limit", 200, world.buyer.id]]);
  // The caller's address reached the API's log, hashed as on any v1 call.
  assert.equal(rows[0].ipHash, addressHash("203.0.113.9"));
  if (limitStore() === "database") {
    const [window] = await prisma.rateWindow.findMany({ where: windows });
    assert.equal(window?.count, 1);
  }
});

test("search_listings answers what GET /api/v1/listings answers for the same key", async () => {
  const minted = await key(world.buyer.id);
  const result = await callTool(minted.token, "search_listings", { state: STATE, limit: 100 });
  assert.equal(result.isError, undefined);
  const direct = await getListings(new Request(`http://localhost/api/v1/listings?state=${STATE}&limit=100`, { headers: { authorization: `Bearer ${minted.token}` } }));
  assert.equal(direct.status, 200);
  const expected = (await direct.json()) as { listings: { id: string }[]; nextCursor: string | null };
  assert.deepEqual(result.structuredContent, expected);
  assert.deepEqual(JSON.parse(result.content[0].text), expected);
  const ids = expected.listings.map((row) => row.id);
  assert.ok(ids.includes(world.open.id) && ids.includes(world.second.id));
  assert.ok(!ids.includes(world.hidden.id), "a private sale it wasn't invited to");
  assert.ok(!result.content[0].text.includes("Borrower Hidden") && !result.content[0].text.includes("Hidden Way"));

  // Paging and the API's own value checks come through.
  const first = await callTool(minted.token, "search_listings", { state: STATE, limit: 1, lien_position: ["FIRST"] });
  const page = first.structuredContent as { listings: unknown[]; nextCursor: string | null };
  assert.equal(page.listings.length, 1);
  assert.ok(page.nextCursor);
  const rest = await callTool(minted.token, "search_listings", { state: STATE, limit: 1, lien_position: ["FIRST"], cursor: page.nextCursor });
  assert.equal(rest.isError, undefined);
  const bad = await callTool(minted.token, "search_listings", { state: "Florida" });
  assert.equal(bad.isError, true);
  assert.equal(bad.content[0].text, "state is a two-letter code, such as FL.");
});

test("get_listing on a listing the key can't see, a narrow key and a lapsed Pro come back as tool errors", async () => {
  const minted = await key(world.buyer.id);
  const hidden = await callTool(minted.token, "get_listing", { id: world.hidden.id });
  assert.deepEqual(hidden, { content: [{ type: "text", text: "Listing not found." }], isError: true });
  const open = await callTool(minted.token, "get_listing", { id: world.open.id });
  assert.equal(open.isError, undefined);
  assert.equal((open.structuredContent as { id: string }).id, world.open.id);
  assert.equal((await callTool(minted.token, "get_offer", { id: "nosuchoffer" })).content[0].text, "Offer not found.");

  const narrow = await key(world.buyer.id, "listings:read");
  const refused = await callTool(narrow.token, "list_holdings");
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, "This key doesn't have the holdings:read scope. Mint a key that has it.");
  assert.equal((await callTool(narrow.token, "search_listings", { state: STATE })).isError, undefined);
  await apiLogSettled();
  const logged = await prisma.apiCall.findMany({ where: { keyId: narrow.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(logged.map((row) => [row.path, row.status]), [["/api/v1/holdings", 403], ["/api/v1/listings?state", 200]]);

  // The key still connects once Pro lapses, and each tool says why it is paused, in the API's words.
  const lapsed = await person("lapsed", "BUYER", { subscriptionTier: "FREE", subscriptionStatus: "CANCELED" });
  const lapsedKey = await key(lapsed.id);
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, lapsedKey.token)).status, 200);
  const paused = await callTool(lapsedKey.token, "search_listings");
  assert.equal(paused.isError, true);
  assert.match(paused.content[0].text, /Pro was canceled\. Buyer API keys need Pro\. Subscribe at \/buyer\/subscription/);
});
