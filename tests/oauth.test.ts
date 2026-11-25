import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { Prisma, User } from "@prisma/client";
import { GET as authServerMetadata, OPTIONS as authServerPreflight } from "../app/.well-known/oauth-authorization-server/route";
import { GET as resourceMetadataAtPath } from "../app/.well-known/oauth-protected-resource/api/mcp/route";
import { GET as resourceMetadata, OPTIONS as resourcePreflight } from "../app/.well-known/oauth-protected-resource/route";
import { POST as postMcp } from "../app/api/mcp/route";
import { OPTIONS as registerPreflight, POST as postRegister } from "../app/oauth/register/route";
import { POST as postRevoke } from "../app/oauth/revoke/route";
import { OPTIONS as tokenPreflight, POST as postToken } from "../app/oauth/token/route";
import { BUYER_SCOPES, checkApiKey, hashKey, mintKey } from "../lib/api-keys";
import { apiLogSettled } from "../lib/api-log";
import {
  REGISTER_LIMIT,
  approveAuthorization,
  checkAuthorizeRequest,
  clientNameOf,
  denyAuthorization,
  oauthOrigin,
  redirectUriProblem,
  revokeGrantRows,
  s256,
  verifierMatches,
  type AuthorizeParams,
} from "../lib/oauth";
import { prisma } from "../lib/prisma";
import type { ActingUser } from "../lib/seats";

const HOUR = 60 * 60 * 1000;
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
// No state starts with Y, so a filter on it finds only these fixtures.
const STATE = `Y${String.fromCharCode(65 + Math.floor(Math.random() * 26))}`;
// The route handlers fall back to the request's origin where NEXT_PUBLIC_APP_URL isn't set, as the lib does here.
const ORIGIN = oauthOrigin("http://localhost");
const RESOURCE = `${ORIGIN}/api/mcp`;
const REDIRECT = `https://app-${tag}.example.org/callback`;
const made = { users: [] as string[], listings: [] as string[], clients: [] as string[], addresses: [] as string[], tokens: [] as string[] };

// A fresh address for each test's rate limits, so a rerun within the hour starts clean.
function address() {
  const octet = () => Math.floor(Math.random() * 250) + 1;
  const ip = `10.${octet()}.${octet()}.${octet()}`;
  made.addresses.push(ip);
  return ip;
}

const IP = address();

type OAuthBody = Record<string, unknown> & { error?: string; error_description?: string };

function jsonRequest(path: string, body: unknown, ip = IP) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function formRequest(path: string, values: Record<string, string>, ip = IP, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip, ...headers },
    body: new URLSearchParams(values).toString(),
  });
}

async function register(body: Record<string, unknown>, ip = IP) {
  const response = await postRegister(jsonRequest("/oauth/register", body, ip));
  const json = (await response.json()) as OAuthBody;
  if (typeof json.client_id === "string") made.clients.push(json.client_id);
  return { status: response.status, body: json, response };
}

async function token(values: Record<string, string>, ip = IP) {
  const response = await postToken(formRequest("/oauth/token", values, ip));
  return { status: response.status, body: (await response.json()) as OAuthBody, response };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: s256(verifier) };
}

function request(clientId: string, challenge: string, extra: AuthorizeParams = {}): AuthorizeParams {
  return { response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: `state-${tag}`, resource: RESOURCE, ...extra };
}

async function approve(user: User | ActingUser, params: AuthorizeParams) {
  const decision = await approveAuthorization(user, params, ORIGIN);
  assert.ok("redirect" in decision, "error" in decision ? decision.error : "");
  const url = new URL(decision.redirect);
  return { url, code: url.searchParams.get("code") ?? "" };
}

async function person(who: string, role: "BUYER" | "INSTITUTIONAL_SELLER", data: Partial<Prisma.UserCreateInput> = {}, file: "APPROVED" | "SUBMITTED" | null = "APPROVED") {
  const user = await prisma.user.create({
    data: {
      email: `oauth-${who}-${tag}@example.org`,
      name: `OAuth ${who} ${tag}`,
      role,
      accountStatus: "APPROVED",
      passwordHash: "x",
      ...(role === "BUYER" ? { subscriptionTier: "PRO" as const, subscriptionStatus: "ACTIVE" as const } : {}),
      ...data,
    },
  });
  made.users.push(user.id);
  if (role === "BUYER" && file) await prisma.buyerProfile.create({ data: { userId: user.id, status: file, entityName: `Fund ${tag}` } });
  return user;
}

async function listing(sellerId: string, title: string) {
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
      notes: {
        create: [{
          streetAddress: `4 Hidden Lane ${tag}`, city: "Testville", state: STATE, zip: "99002", propertyType: "SFR", occupancy: "VACANT",
          lienPosition: "FIRST", upb: 120000, interestRate: 6.25, monthlyPi: 900, paymentStatus: "PERFORMING", monthsDelinquent: 0,
          askingPrice: 80000, estimatedValue: 190000, borrowerName: `Borrower Hidden ${tag}`,
        }] as never,
      },
    },
  });
  made.listings.push(row.id);
  return row;
}

let world: { seller: User; buyer: User; open: { id: string } };

test.before(async () => {
  const seller = await person("seller", "INSTITUTIONAL_SELLER");
  const buyer = await person("buyer", "BUYER");
  const open = await listing(seller.id, "OAuth open");
  world = { seller, buyer, open };
});

test.after(async () => {
  await apiLogSettled();
  const users = made.users;
  const grants = await prisma.oAuthGrant.findMany({ where: { userId: { in: users } }, select: { id: true } });
  const clients = await prisma.oAuthClient.findMany({ where: { clientId: { in: made.clients } }, select: { id: true } });
  await prisma.apiCall.deleteMany({ where: { userId: { in: users } } });
  await prisma.apiKey.deleteMany({ where: { userId: { in: users } } });
  await prisma.oAuthCode.deleteMany({ where: { userId: { in: users } } });
  await prisma.oAuthGrant.deleteMany({ where: { userId: { in: users } } });
  await prisma.oAuthClient.deleteMany({ where: { clientId: { in: made.clients } } });
  const windows = [
    ...made.addresses.flatMap((ip) => [`oauth-register:${ip}:`, `oauth-token:${ip}:`, `oauth-revoke:${ip}:`]),
    ...made.tokens.map((value) => `api:${hashKey(value).slice(0, 32)}`),
  ];
  if (windows.length) await prisma.rateWindow.deleteMany({ where: { OR: windows.map((prefix) => ({ key: { startsWith: prefix } })) } });
  const entities = [...grants.map((row) => row.id), ...clients.map((row) => row.id), ...made.listings, ...users];
  await prisma.auditEvent.deleteMany({ where: { OR: [{ entityId: { in: entities } }, { actorId: { in: users } }] } });
  await prisma.note.deleteMany({ where: { listingId: { in: made.listings } } });
  await prisma.listing.deleteMany({ where: { id: { in: made.listings } } });
  await prisma.buyerProfile.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
});

// A registered client, an approval for `user` and the code traded in: what a connector holds afterwards.
async function connect(user: User, name = `Assistant ${tag}`) {
  const client = await register({ client_name: name, redirect_uris: [REDIRECT] });
  assert.equal(client.status, 201);
  const clientId = String(client.body.client_id);
  const { verifier, challenge } = pkce();
  const { code } = await approve(user, request(clientId, challenge));
  const tokens = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: RESOURCE });
  assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
  const access = String(tokens.body.access_token);
  made.tokens.push(access);
  return { clientId, access, refresh: String(tokens.body.refresh_token), body: tokens.body };
}

async function mcp(accessToken: string, body: unknown) {
  return postMcp(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": "203.0.113.19", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------

test("the metadata documents name the MCP resource, the sign-in endpoints and the buyer scopes, open to any origin", async () => {
  for (const handler of [resourceMetadata, resourceMetadataAtPath]) {
    const response = handler(new Request("http://localhost/.well-known/oauth-protected-resource"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await response.json(), {
      resource: RESOURCE,
      authorization_servers: [ORIGIN],
      scopes_supported: [...BUYER_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "UPB Capital",
    });
  }
  const server = authServerMetadata(new Request("http://localhost/.well-known/oauth-authorization-server"));
  assert.equal(server.headers.get("access-control-allow-origin"), "*");
  const meta = (await server.json()) as Record<string, unknown>;
  assert.equal(meta.issuer, ORIGIN);
  assert.equal(meta.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  assert.equal(meta.token_endpoint, `${ORIGIN}/oauth/token`);
  assert.equal(meta.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.equal(meta.revocation_endpoint, `${ORIGIN}/oauth/revoke`);
  assert.deepEqual(meta.response_types_supported, ["code"]);
  assert.deepEqual(meta.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(meta.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(meta.scopes_supported, [...BUYER_SCOPES]);

  for (const preflight of [resourcePreflight, authServerPreflight, registerPreflight, tokenPreflight]) {
    const answer = preflight();
    assert.equal(answer.status, 204);
    assert.equal(answer.headers.get("access-control-allow-origin"), "*");
    assert.match(answer.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.equal(answer.headers.get("access-control-allow-credentials"), null);
  }

  // The MCP endpoint's 401 points a connector at the resource document.
  const missing = await postMcp(new Request("http://localhost/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get("www-authenticate") ?? "", new RegExp(`resource_metadata="${ORIGIN}/\\.well-known/oauth-protected-resource"`));
});

test("registration takes https and loopback http redirects, and refuses the rest in RFC 7591's terms", async () => {
  const ip = address();
  const ok = await register({ client_name: `  Claude‮ ${tag}  `, redirect_uris: [REDIRECT, REDIRECT], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" }, ip);
  assert.equal(ok.status, 201);
  assert.equal(ok.response.headers.get("access-control-allow-origin"), "*");
  assert.equal(ok.response.headers.get("cache-control"), "no-store");
  assert.match(String(ok.body.client_id), /^upbc_[0-9a-f]{32}$/);
  assert.equal(typeof ok.body.client_id_issued_at, "number");
  assert.equal(ok.body.client_name, `Claude ${tag}`, "trimmed, and the text-reordering character gone");
  assert.deepEqual(ok.body.redirect_uris, [REDIRECT]);
  assert.equal(ok.body.token_endpoint_auth_method, "none");
  assert.deepEqual(ok.body.grant_types, ["authorization_code", "refresh_token"]);
  assert.deepEqual(ok.body.response_types, ["code"]);
  assert.equal("client_secret" in ok.body, false);

  const loopback = await register({ redirect_uris: ["http://localhost:33418/callback", "http://127.0.0.1/cb", "http://[::1]:8080/cb"] }, ip);
  assert.equal(loopback.status, 201);
  assert.equal(loopback.body.client_name, "AI assistant");
  const long = await register({ client_name: "A".repeat(200), redirect_uris: [REDIRECT] }, ip);
  assert.equal(String(long.body.client_name).length, 80);

  for (const [body, error] of [
    [{ redirect_uris: ["http://app.example.org/callback"] }, "invalid_redirect_uri"],
    [{ redirect_uris: [`${REDIRECT}#frag`] }, "invalid_redirect_uri"],
    [{ redirect_uris: ["myapp://callback"] }, "invalid_redirect_uri"],
    [{ redirect_uris: ["https://user:pass@app.example.org/cb"] }, "invalid_redirect_uri"],
    [{ redirect_uris: [`https://app.example.org/${"a".repeat(500)}`] }, "invalid_redirect_uri"],
    [{ redirect_uris: Array.from({ length: 6 }, (_, index) => `https://app.example.org/${index}`) }, "invalid_redirect_uri"],
    [{ client_name: "No redirects" }, "invalid_redirect_uri"],
    [{ redirect_uris: [REDIRECT], client_name: 7 }, "invalid_client_metadata"],
    ["not json", "invalid_client_metadata"],
  ] as const) {
    const refused = await register(body as Record<string, unknown>, ip);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(refused.body.error, error, JSON.stringify(body));
    assert.ok(refused.body.error_description);
  }

  assert.equal(redirectUriProblem("https://claude.ai/api/mcp/auth_callback"), null);
  assert.match(redirectUriProblem("http://localhost.evil.example/cb") ?? "", /https/);
  assert.equal(clientNameOf("\u0000​ "), "AI assistant");
});

test("registration is limited by address", async () => {
  const ip = address();
  for (let tries = 0; tries < REGISTER_LIMIT.requests; tries += 1) assert.equal((await register({}, ip)).status, 400);
  const limited = await register({ redirect_uris: [REDIRECT] }, ip);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.response.headers.get("retry-after")) >= 1);
  // Another address is unaffected.
  assert.equal((await register({}, address())).status, 400);
});

test("the authorize checks: client and exact redirect first, then the request, with errors carried back", async () => {
  const client = await register({ client_name: `Checks ${tag}`, redirect_uris: [REDIRECT, "http://127.0.0.1:9000/cb"] });
  const clientId = String(client.body.client_id);
  const { challenge } = pkce();

  // Nothing is sent anywhere until the client and the exact redirect check out.
  for (const params of [
    request("upbc_unknown", challenge),
    request(clientId, challenge, { redirect_uri: `${REDIRECT}/other` }),
    request(clientId, challenge, { redirect_uri: `${REDIRECT}?x=1` }),
    request(clientId, challenge, { redirect_uri: REDIRECT.toUpperCase() }),
    request(clientId, challenge, { redirect_uri: undefined }),
  ]) {
    const checked = await checkAuthorizeRequest(params, ORIGIN);
    assert.equal(checked.kind, "invalid", JSON.stringify(params));
    assert.equal("redirect" in (await denyAuthorization(params, ORIGIN)), false);
  }

  for (const [extra, error] of [
    [{ scope: "listings:read tapes:write" }, "invalid_scope"],
    [{ scope: "openid" }, "invalid_scope"],
    [{ resource: "https://elsewhere.example/api/mcp" }, "invalid_target"],
    [{ code_challenge: undefined }, "invalid_request"],
    [{ code_challenge: "short" }, "invalid_request"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge_method: undefined }, "invalid_request"],
    [{ response_type: undefined }, "invalid_request"],
    [{ response_type: "token" }, "unsupported_response_type"],
  ] as const) {
    const checked = await checkAuthorizeRequest(request(clientId, challenge, extra as AuthorizeParams), ORIGIN);
    assert.equal(checked.kind, "refused", JSON.stringify(extra));
    if (checked.kind !== "refused") continue;
    assert.equal(checked.error, error);
    const back = new URL(checked.redirectTo);
    assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
    assert.equal(back.searchParams.get("error"), error);
    assert.equal(back.searchParams.get("state"), `state-${tag}`);
    assert.equal(back.searchParams.get("iss"), ORIGIN);
    assert.equal(back.searchParams.get("code"), null);
  }

  const ok = await checkAuthorizeRequest(request(clientId, challenge, { resource: `${RESOURCE}/`, scope: undefined }), ORIGIN);
  assert.equal(ok.kind, "ok");
  if (ok.kind === "ok") {
    assert.deepEqual(ok.request.scopes, [...BUYER_SCOPES], "no scope asked is every buyer scope");
    assert.equal(ok.request.resource, RESOURCE);
  }
  const narrow = await checkAuthorizeRequest(request(clientId, challenge, { scope: "holdings:read  listings:read" }), ORIGIN);
  assert.deepEqual(narrow.kind === "ok" ? narrow.request.scopes : null, ["listings:read", "holdings:read"]);
  const loopback = await checkAuthorizeRequest(request(clientId, challenge, { redirect_uri: "http://127.0.0.1:9000/cb" }), ORIGIN);
  assert.equal(loopback.kind, "ok");

  const denied = await denyAuthorization(request(clientId, challenge), ORIGIN);
  assert.ok("redirect" in denied);
  const back = new URL(denied.redirect);
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("state"), `state-${tag}`);
  assert.equal(back.searchParams.get("iss"), ORIGIN);
});

test("only a buyer who could mint a key by hand may approve", async () => {
  const client = await register({ client_name: `Who ${tag}`, redirect_uris: [REDIRECT] });
  const clientId = String(client.body.client_id);
  const { challenge } = pkce();
  const params = request(clientId, challenge);
  const viewSeat: ActingUser = { ...world.buyer, actor: { id: `seat-${tag}`, name: "Seat", email: `seat-${tag}@example.org`, seatRole: "VIEW", bidLimitCents: null } };
  const unfiled = await person("unfiled", "BUYER", {}, "SUBMITTED");
  const lapsed = await person("lapsed", "BUYER", { subscriptionTier: "FREE", subscriptionStatus: "CANCELED" });
  for (const [user, why] of [
    [world.seller, /Only a buyer account/],
    [viewSeat, /managing seat or the account owner/],
    [unfiled, /buyer file the desk approved/],
    [lapsed, /Pro was canceled/],
  ] as const) {
    const decision = await approveAuthorization(user, params, ORIGIN);
    assert.ok("error" in decision, user.email);
    if ("error" in decision) assert.match(decision.error, why);
  }
  assert.equal(await prisma.oAuthCode.count({ where: { clientId } }), 0, "no code for any of them");

  // A managing seat may, as the owner may.
  const manager: ActingUser = { ...world.buyer, actor: { ...viewSeat.actor!, seatRole: "MANAGE" } };
  assert.ok("redirect" in (await approveAuthorization(manager, params, ORIGIN)));
});

test("the full flow: register, approve, trade the code with PKCE, then call the MCP server with the access token", async () => {
  const client = await register({ client_name: `Flow ${tag}`, redirect_uris: [REDIRECT] });
  const clientId = String(client.body.client_id);
  const other = String((await register({ client_name: `Other ${tag}`, redirect_uris: [REDIRECT] })).body.client_id);
  const { verifier, challenge } = pkce();
  assert.ok(verifierMatches(verifier, challenge));
  const { url, code } = await approve(world.buyer, request(clientId, challenge));
  assert.equal(`${url.origin}${url.pathname}`, REDIRECT);
  assert.equal(url.searchParams.get("state"), `state-${tag}`);
  assert.equal(url.searchParams.get("iss"), ORIGIN);
  assert.ok(code.length >= 43);
  // Only the code's hash is kept.
  assert.equal(await prisma.oAuthCode.count({ where: { codeHash: code } }), 0);
  const stored = await prisma.oAuthCode.findUnique({ where: { codeHash: hashKey(code) } });
  assert.equal(stored?.userId, world.buyer.id);
  assert.ok(stored && stored.expiresAt.getTime() - Date.now() <= 5 * 60 * 1000 && stored.expiresAt.getTime() - Date.now() > 4 * 60 * 1000);
  assert.ok(await prisma.auditEvent.findFirst({ where: { actorId: world.buyer.id, action: "OAUTH_APP_APPROVED" } }));

  const trade = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: RESOURCE };
  // Wrong in any way, the code is refused, and stays good for the request that is right.
  for (const wrong of [
    { code_verifier: pkce().verifier },
    { code_verifier: "too-short" },
    { redirect_uri: `${REDIRECT}/elsewhere` },
    { client_id: other },
    { resource: "https://elsewhere.example/api/mcp" },
    { code: randomBytes(32).toString("base64url") },
  ]) {
    const refused = await token({ ...trade, ...wrong });
    assert.equal(refused.status, 400, JSON.stringify(wrong));
    assert.equal(refused.body.error, "invalid_grant", JSON.stringify(wrong));
  }
  const unknown = await token({ ...trade, client_id: "upbc_nobody" });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error, "invalid_client");
  assert.equal((await token({ ...trade, grant_type: "password" })).body.error, "unsupported_grant_type");
  assert.equal((await token({ grant_type: "authorization_code", code })).body.error, "invalid_request");

  const tokens = await token(trade);
  assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
  assert.equal(tokens.response.headers.get("cache-control"), "no-store");
  assert.equal(tokens.response.headers.get("access-control-allow-origin"), "*");
  assert.equal(tokens.body.token_type, "Bearer");
  assert.equal(tokens.body.expires_in, 3600);
  assert.equal(tokens.body.scope, BUYER_SCOPES.join(" "));
  const access = String(tokens.body.access_token);
  const refresh = String(tokens.body.refresh_token);
  made.tokens.push(access);
  assert.match(access, /^upb_/);
  assert.match(refresh, /^upbr_/);

  // The access token is a buyer key on the account, an hour long, under the grant; the refresh token is kept hashed.
  const key = await prisma.apiKey.findUnique({ where: { hash: hashKey(access) } });
  assert.equal(key?.userId, world.buyer.id);
  assert.equal(key?.name, `Flow ${tag} (connected app)`);
  assert.equal(key?.scopes, BUYER_SCOPES.join(","));
  assert.ok(key?.grantId);
  assert.ok(key?.expiresAt && Math.abs(key.expiresAt.getTime() - Date.now() - HOUR) < 60 * 1000);
  const grant = await prisma.oAuthGrant.findUnique({ where: { id: key!.grantId! } });
  assert.equal(grant?.refreshHash, hashKey(refresh));
  assert.equal(grant?.clientId, clientId);
  assert.ok(grant?.refreshExpiresAt && grant.refreshExpiresAt.getTime() > Date.now() + 29 * 24 * HOUR);

  // Used once, the code is spent.
  const again = await token(trade);
  assert.equal(again.status, 400);
  assert.equal(again.body.error, "invalid_grant");

  const response = await mcp(access, { jsonrpc: "2.0", id: "search", method: "tools/call", params: { name: "search_listings", arguments: { state: STATE, limit: 100 } } });
  assert.equal(response.status, 200);
  const result = ((await response.json()) as { result: { isError?: boolean; structuredContent: { listings: { id: string }[] }; content: { text: string }[] } }).result;
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.ok(result.structuredContent.listings.some((row) => row.id === world.open.id));
  assert.ok(!result.content[0].text.includes("Borrower Hidden"));
  await apiLogSettled();
  assert.equal(await prisma.apiCall.count({ where: { keyId: key!.id, status: 200 } }), 1, "logged as any key's call");
});

test("an expired code is refused", async () => {
  const client = await register({ client_name: `Expired ${tag}`, redirect_uris: [REDIRECT] });
  const clientId = String(client.body.client_id);
  const { verifier, challenge } = pkce();
  const { code } = await approve(world.buyer, request(clientId, challenge));
  await prisma.oAuthCode.update({ where: { codeHash: hashKey(code) }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const late = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier });
  assert.equal(late.status, 400);
  assert.equal(late.body.error, "invalid_grant");
});

test("a refresh rotates both tokens; the old refresh token then fails, and scopes may narrow but not widen", async () => {
  const first = await connect(world.buyer);
  const key = await prisma.apiKey.findUnique({ where: { hash: hashKey(first.access) } });
  const refreshed = await token({ grant_type: "refresh_token", refresh_token: first.refresh, client_id: first.clientId });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  const access = String(refreshed.body.access_token);
  const refresh = String(refreshed.body.refresh_token);
  made.tokens.push(access);
  assert.notEqual(access, first.access);
  assert.notEqual(refresh, first.refresh);
  assert.equal(refreshed.body.expires_in, 3600);

  const replay = await token({ grant_type: "refresh_token", refresh_token: first.refresh, client_id: first.clientId });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, "invalid_grant");

  // The grant keeps one key row, with the new token on it: the old access token is gone, the new one reads.
  const now = await checkApiKey(`Bearer ${access}`);
  assert.ok(now.ok);
  if (now.ok) assert.equal(now.key.id, key?.id);
  const old = await checkApiKey(`Bearer ${first.access}`);
  assert.equal(old.ok, false);
  assert.equal(await prisma.apiKey.count({ where: { grantId: key!.grantId } }), 1);
  const grant = await prisma.oAuthGrant.findUnique({ where: { id: key!.grantId! } });
  assert.equal(grant?.refreshHash, hashKey(refresh));
  assert.ok(grant?.lastUsedAt);

  const other = String((await register({ redirect_uris: [REDIRECT] })).body.client_id);
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: refresh, client_id: other })).body.error, "invalid_grant");
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: refresh, client_id: first.clientId, scope: "tapes:write" })).body.error, "invalid_scope");
  const narrow = await token({ grant_type: "refresh_token", refresh_token: refresh, client_id: first.clientId, scope: "listings:read" });
  assert.equal(narrow.status, 200);
  assert.equal(narrow.body.scope, "listings:read");
  made.tokens.push(String(narrow.body.access_token));
  const check = await checkApiKey(`Bearer ${String(narrow.body.access_token)}`);
  assert.deepEqual(check.ok ? check.scopes : null, ["listings:read"]);
});

test("an expired access token is refused by the key check and by the MCP server", async () => {
  const { access } = await connect(world.buyer);
  await prisma.apiKey.update({ where: { hash: hashKey(access) }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const check = await checkApiKey(`Bearer ${access}`);
  assert.deepEqual(check, { ok: false, status: 401, error: "This access token expired." });
  const response = await mcp(access, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  // A key minted by hand has no expiry and keeps working.
  const minted = mintKey();
  await prisma.apiKey.create({ data: { userId: world.buyer.id, name: `Hand ${tag}`, prefix: minted.prefix, hash: minted.hash, scopes: BUYER_SCOPES.join(",") } });
  assert.equal((await checkApiKey(`Bearer ${minted.token}`)).ok, true);
});

test("revoking: the refresh token takes the grant and its access token; an access token takes only itself", async () => {
  const revokeIp = address();
  const revoke = (values: Record<string, string>) => postRevoke(formRequest("/oauth/revoke", values, revokeIp));

  const app = await connect(world.buyer);
  const gone = await revoke({ token: app.refresh, token_type_hint: "refresh_token", client_id: app.clientId });
  assert.equal(gone.status, 200);
  assert.equal(gone.headers.get("access-control-allow-origin"), "*");
  const check = await checkApiKey(`Bearer ${app.access}`);
  assert.equal(check.ok, false);
  if (!check.ok) assert.match(check.error, /revoked/);
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: app.refresh, client_id: app.clientId })).body.error, "invalid_grant");

  // The access token alone: it stops, and the refresh token still gets a new one.
  const second = await connect(world.buyer);
  assert.equal((await revoke({ token: second.access })).status, 200);
  assert.equal((await checkApiKey(`Bearer ${second.access}`)).ok, false);
  const renewed = await token({ grant_type: "refresh_token", refresh_token: second.refresh, client_id: second.clientId });
  assert.equal(renewed.status, 200);
  made.tokens.push(String(renewed.body.access_token));
  assert.equal((await checkApiKey(`Bearer ${String(renewed.body.access_token)}`)).ok, true);

  // Unknown tokens, another client's token, and a key minted by hand change nothing, and the answer is the same.
  const minted = mintKey();
  await prisma.apiKey.create({ data: { userId: world.buyer.id, name: `Hand ${tag}`, prefix: minted.prefix, hash: minted.hash, scopes: BUYER_SCOPES.join(",") } });
  const untouched: Record<string, string>[] = [{ token: "upbr_nothing" }, { token: minted.token }, { token: String(renewed.body.refresh_token), client_id: app.clientId }, {}];
  for (const values of untouched) {
    assert.equal((await revoke(values)).status, 200);
  }
  assert.equal((await checkApiKey(`Bearer ${minted.token}`)).ok, true);
  assert.equal((await checkApiKey(`Bearer ${String(renewed.body.access_token)}`)).ok, true);

  // The Buyer API page's revoke: only on the account's own grant.
  const grantId = (await prisma.apiKey.findUnique({ where: { hash: hashKey(String(renewed.body.access_token)) } }))!.grantId!;
  assert.equal(await revokeGrantRows(grantId, world.seller.id), false);
  assert.equal((await checkApiKey(`Bearer ${String(renewed.body.access_token)}`)).ok, true);
  assert.equal(await revokeGrantRows(grantId, world.buyer.id), true);
  assert.equal((await checkApiKey(`Bearer ${String(renewed.body.access_token)}`)).ok, false);
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: String(renewed.body.refresh_token), client_id: second.clientId })).body.error, "invalid_grant");
});

test("a refresh is refused once the account could no longer approve", async () => {
  const buyer = await person("later", "BUYER");
  const app = await connect(buyer);
  await prisma.user.update({ where: { id: buyer.id }, data: { subscriptionTier: "FREE", subscriptionStatus: "CANCELED" } });
  const refused = await token({ grant_type: "refresh_token", refresh_token: app.refresh, client_id: app.clientId });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "invalid_grant");
  assert.match(String(refused.body.error_description), /Pro/);
  await prisma.user.update({ where: { id: buyer.id }, data: { accountStatus: "SUSPENDED", subscriptionTier: "PRO", subscriptionStatus: "ACTIVE" } });
  assert.equal((await token({ grant_type: "refresh_token", refresh_token: app.refresh, client_id: app.clientId })).body.error, "invalid_grant");
});

test("the token endpoint takes JSON and a client_id sent as HTTP Basic, and is limited by address", async () => {
  const ip = address();
  const app = await connect(world.buyer);
  const json = await postToken(
    new Request("http://localhost/oauth/token", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: app.refresh, client_id: app.clientId }) }),
  );
  assert.equal(json.status, 200);
  const body = (await json.json()) as OAuthBody;
  made.tokens.push(String(body.access_token));
  const basic = await postToken(formRequest("/oauth/token", { grant_type: "refresh_token", refresh_token: String(body.refresh_token) }, ip, { authorization: `Basic ${Buffer.from(`${app.clientId}:`).toString("base64")}` }));
  assert.equal(basic.status, 200);
  made.tokens.push(String(((await basic.json()) as OAuthBody).access_token));
  // A parameter sent twice can't be read.
  const twice = await postToken(new Request("http://localhost/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip }, body: "grant_type=refresh_token&grant_type=authorization_code" }));
  assert.equal(((await twice.json()) as OAuthBody).error, "invalid_request");

  const flood = address();
  for (let tries = 0; tries < 120; tries += 1) assert.equal((await token({ grant_type: "password" }, flood)).status, 400);
  const limited = await token({ grant_type: "password" }, flood);
  assert.equal(limited.status, 429);
});
