import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthClient, User } from "@prisma/client";
import { accountLocked } from "@/lib/access";
import { BUYER_SCOPES, buyerKeyProblem, cleanBuyerScopes, hashKey, mintKey, scopesOf, type ApiScope } from "@/lib/api-keys";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/email";
import { unset } from "@/lib/db-filters";
import { MCP_PATH } from "@/lib/mcp";
import { prisma } from "@/lib/prisma";
import { canManageSeats, type ActingUser } from "@/lib/seats";

// OAuth 2.1 sign-in for the MCP connector, as the MCP authorization spec (2025-06-18) asks: claude.ai, ChatGPT and
// other connectors can't send a fixed header, so they find this server from the MCP endpoint's 401, register
// themselves (RFC 7591), send the buyer to /oauth/authorize to approve them, and trade the code for tokens with PKCE.
//
// An access token is a buyer API key: an ApiKey row with expiresAt an hour out and grantId naming the buyer's consent
// (OAuthGrant). So the key check, the scopes, Pro, the demo-seat rule, the 120 a minute and the call log apply to a
// connected app exactly as to a key the buyer minted. A grant keeps one key row and gives it a new token on each
// refresh, so the app's calls stay under one name in Recent calls and the rows don't pile up an hour at a time.
// Codes and refresh tokens are stored only as SHA-256 hashes, as keys are.

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export const ACCESS_TOKEN_SECONDS = 60 * 60;
export const CODE_MINUTES = 5;
export const REFRESH_DAYS = 30;
// Registrations and token requests one address may make. claude.ai and ChatGPT register and refresh from their own
// servers, so every buyer connecting through one of them shares its address: the registration figure leaves room for
// a busy hour of new connections there, and the token figure matches a key's own allowance.
export const REGISTER_LIMIT = { requests: 300, windowMs: 60 * MINUTE };
export const TOKEN_LIMIT = { requests: 120, windowMs: MINUTE };
export const REVOKE_LIMIT = { requests: 60, windowMs: MINUTE };

const REDIRECTS_MAX = 5;
const REDIRECT_URI_MAX = 500;
const CLIENT_NAME_MAX = 80;
const DEFAULT_CLIENT_NAME = "AI assistant";
const STATE_MAX = 1000;
// A form or JSON body for these endpoints is a few short values.
export const OAUTH_BODY_MAX = 16 * 1024;

export const GRANT_TYPES = ["authorization_code", "refresh_token"] as const;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------------------------------------------
// Addresses and metadata

// The site's own origin, as the developers page and the links in mail build it. A request's own origin stands in only
// where NEXT_PUBLIC_APP_URL isn't set, as on a local copy.
export function oauthOrigin(fallback = "") {
  return ((process.env.NEXT_PUBLIC_APP_URL || "").trim() || fallback).replace(/\/+$/, "");
}

export function originOf(request: Request) {
  return oauthOrigin(new URL(request.url).origin);
}

// For pages and server actions, which have headers rather than a Request.
export function originFromHeaders(incoming: Headers) {
  const host = incoming.get("host") || "localhost";
  const proto = (incoming.get("x-forwarded-proto") || "").split(",")[0].trim() || (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? "http" : "https");
  return oauthOrigin(`${proto}://${host}`);
}

export const mcpResource = (origin: string) => `${origin}${MCP_PATH}`;

// RFC 9728, served at /.well-known/oauth-protected-resource and at the same path with /api/mcp after it.
export function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpResource(origin),
    authorization_servers: [origin],
    scopes_supported: [...BUYER_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "UPB Capital",
  };
}

// RFC 8414, at /.well-known/oauth-authorization-server.
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: [...GRANT_TYPES],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...BUYER_SCOPES],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/developers#mcp`,
  };
}

// Connectors may call the metadata, registration, token and revocation endpoints from a browser. Nothing there reads a
// cookie, so any origin may, without credentials. The authorize page has none of this.
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export function oauthJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store", Pragma: "no-cache", ...headers } });
}

export function oauthPreflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function metadataResponse(body: unknown) {
  return Response.json(body, { headers: { ...CORS_HEADERS, "Cache-Control": "public, max-age=300" } });
}

export function tooMany(windowMs: number, now = Date.now()) {
  const wait = Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));
  return oauthJson({ error: "too_many_requests", error_description: `Too many requests from this address. Try again in ${wait} seconds.` }, 429, { "Retry-After": String(wait) });
}

// ---------------------------------------------------------------------------------------------------------------
// Request bodies

async function readBody(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > OAUTH_BODY_MAX) return null;
  const raw = await request.text().catch(() => null);
  return raw == null || raw.length > OAUTH_BODY_MAX ? null : raw;
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const raw = await readBody(request);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// A token or revocation request's parameters: form-encoded as RFC 6749 sends them, or a JSON object. A parameter sent
// twice makes the request unreadable, as the RFC asks, and one sent empty counts as left out.
export async function readOAuthForm(request: Request): Promise<Record<string, string> | null> {
  const raw = await readBody(request);
  if (raw == null) return null;
  const out: Record<string, string> = {};
  if ((request.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isObject(parsed)) return null;
    for (const [name, value] of Object.entries(parsed)) if (typeof value === "string" && value) out[name] = value;
    return out;
  }
  for (const [name, value] of new URLSearchParams(raw)) {
    if (name in out) return null;
    if (value) out[name] = value;
  }
  return out;
}

// A public client may send its client_id as HTTP Basic with an empty secret, as some libraries do by default.
export function basicClientId(header: string | null) {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec((header || "").trim());
  if (!match) return "";
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const user = decoded.split(":")[0] ?? "";
  try {
    return decodeURIComponent(user);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Registration (RFC 7591). Public clients only: no secret is issued, and PKCE stands in for one.

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Why a redirect URI can't be registered, or null. https anywhere, or plain http to this computer for a desktop app.
export function redirectUriProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value) return "Each redirect URI is a non-empty string.";
  if (value.length > REDIRECT_URI_MAX) return `A redirect URI is at most ${REDIRECT_URI_MAX} characters.`;
  if (value.includes("#")) return "A redirect URI can't have a fragment.";
  if (/[\s\u0000-\u001f\u007f\\]/.test(value)) return "A redirect URI can't contain spaces, control characters or backslashes.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Each redirect URI is an absolute URL.";
  }
  if (url.username || url.password) return "A redirect URI can't carry a user name or password.";
  if (url.protocol === "https:" && url.hostname) return null;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return null;
  return "A redirect URI is https, or plain http only on localhost, 127.0.0.1 or [::1].";
}

// The name the app gives itself, shown on the consent screen as the app's own. Control characters and the invisible
// characters that reorder text are taken out, so it reads as what it is.
export function clientNameOf(value: unknown) {
  const text = typeof value === "string" ? value : "";
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, " ").replace(/\s+/g, " ").trim();
  return clean.slice(0, CLIENT_NAME_MAX).trim() || DEFAULT_CLIENT_NAME;
}

type Answer = { status: number; body: Json };
const oauthError = (status: number, error: string, description: string): Answer => ({ status, body: { error, error_description: description } });

// What a client asked for that this server does differently (a secret, other grant types) is answered with what it
// does, as RFC 7591 allows, rather than refused: the response says how the client must behave.
export async function registerClient(input: unknown): Promise<Answer> {
  if (!isObject(input)) return oauthError(400, "invalid_client_metadata", "Send the client's metadata as one JSON object.");
  const uris = input.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return oauthError(400, "invalid_redirect_uri", "redirect_uris lists at least one redirect URI.");
  if (uris.length > REDIRECTS_MAX) return oauthError(400, "invalid_redirect_uri", `Register at most ${REDIRECTS_MAX} redirect URIs.`);
  for (const uri of uris) {
    const problem = redirectUriProblem(uri);
    if (problem) return oauthError(400, "invalid_redirect_uri", problem);
  }
  if (input.client_name !== undefined && typeof input.client_name !== "string") return oauthError(400, "invalid_client_metadata", "client_name is text.");
  const name = clientNameOf(input.client_name);
  const redirectUris = [...new Set(uris as string[])];
  const client = await prisma.oAuthClient.create({ data: { clientId: `upbc_${randomBytes(16).toString("hex")}`, name, redirectUris } });
  return {
    status: 201,
    body: {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: [...GRANT_TYPES],
      response_types: ["code"],
      scope: BUYER_SCOPES.join(" "),
    },
  };
}

async function findClient(clientId: string | undefined) {
  if (!clientId || clientId.length > 100) return null;
  return prisma.oAuthClient.findUnique({ where: { clientId } });
}

// ---------------------------------------------------------------------------------------------------------------
// The authorization request

export const AUTHORIZE_PARAMS = ["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource"] as const;
export type AuthorizeParams = Partial<Record<(typeof AUTHORIZE_PARAMS)[number], string>>;

// The parameters this server reads, from a page's query or the consent form, first value only.
export function authorizeParams(get: (name: string) => unknown): AuthorizeParams {
  const out: AuthorizeParams = {};
  for (const name of AUTHORIZE_PARAMS) {
    const raw = get(name);
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string" && value) out[name] = value;
  }
  return out;
}

// The authorize page's own path for these parameters, for the sign-in page's next and the way back from the form.
export function authorizePath(params: AuthorizeParams) {
  const query = new URLSearchParams();
  for (const name of AUTHORIZE_PARAMS) if (params[name]) query.set(name, params[name]!);
  return `/oauth/authorize?${query.toString()}`;
}

// Buyer scopes from a space-separated list, in the fixed order: all of them when none are named, null when any isn't
// a buyer scope.
export function requestedScopes(value: string | undefined | null): ApiScope[] | null {
  const words = (value ?? "").split(/\s+/).filter(Boolean);
  if (!words.length) return [...BUYER_SCOPES];
  const known = new Set<string>(BUYER_SCOPES);
  if (words.some((word) => !known.has(word))) return null;
  return BUYER_SCOPES.filter((scope) => words.includes(scope));
}

// RFC 7636: a verifier or challenge is 43 to 128 unreserved characters.
const PKCE_TEXT = /^[A-Za-z0-9\-._~]{43,128}$/;

export function s256(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function verifierMatches(verifier: string, challenge: string) {
  if (!PKCE_TEXT.test(verifier)) return false;
  const made = Buffer.from(s256(verifier));
  const kept = Buffer.from(challenge);
  return made.length === kept.length && timingSafeEqual(made, kept);
}

// RFC 8707's resource names the MCP server. A trailing slash is the same server.
export function sameResource(value: string, origin: string) {
  try {
    const asked = new URL(value);
    const own = new URL(mcpResource(origin));
    if (asked.hash || asked.search || asked.username || asked.password) return false;
    return asked.origin === own.origin && asked.pathname.replace(/\/+$/, "") === own.pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

// The redirect URI with these parameters added, keeping any query it was registered with.
export function withParams(redirectUri: string, values: Record<string, string | undefined | null>) {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(values)) if (value) url.searchParams.set(name, value);
  return url.toString();
}

export function redirectHost(redirectUri: string) {
  try {
    return new URL(redirectUri).host;
  } catch {
    return "";
  }
}

export const isLoopback = (redirectUri: string) => {
  try {
    return LOOPBACK.has(new URL(redirectUri).hostname);
  } catch {
    return false;
  }
};

export type AuthorizeRequest = { client: OAuthClient; redirectUri: string; scopes: ApiScope[]; state: string | null; challenge: string; resource: string | null };

export type AuthorizeCheck =
  // The client or its redirect can't be trusted, so nothing is sent anywhere: the page says why.
  | { kind: "invalid"; error: string }
  // The client and redirect check out but the request doesn't. redirectTo carries the error back to the app.
  | { kind: "refused"; client: OAuthClient; redirectUri: string; error: string; description: string; redirectTo: string }
  | { kind: "ok"; request: AuthorizeRequest };

// The authorize page's checks, run again on Approve and Deny. The client and the exact redirect URI come first: until
// both check out, nothing is sent to the redirect URI.
export async function checkAuthorizeRequest(params: AuthorizeParams, origin: string): Promise<AuthorizeCheck> {
  const client = await findClient(params.client_id);
  if (!client) return { kind: "invalid", error: "UPB doesn't know the app that sent you here. Start again from the app." };
  const redirectUri = params.redirect_uri ?? "";
  if (!redirectUri) return { kind: "invalid", error: "The app's request doesn't say where to send you back, so UPB can't finish it. Start again from the app." };
  if (!client.redirectUris.includes(redirectUri)) {
    return { kind: "invalid", error: "The app asked UPB to send you to an address it didn't register, so UPB won't send you there. Start again from the app." };
  }
  const refused = (error: string, description: string): AuthorizeCheck => ({
    kind: "refused",
    client,
    redirectUri,
    error,
    description,
    redirectTo: withParams(redirectUri, { error, error_description: description, state: params.state, iss: origin }),
  });
  if (!params.response_type) return refused("invalid_request", "response_type is required, and only code is supported.");
  if (params.response_type !== "code") return refused("unsupported_response_type", "Only response_type=code is supported.");
  if (!params.code_challenge || !PKCE_TEXT.test(params.code_challenge)) return refused("invalid_request", "A PKCE code_challenge of 43 to 128 characters is required.");
  if (params.code_challenge_method !== "S256") return refused("invalid_request", "code_challenge_method must be S256.");
  if (params.state && params.state.length > STATE_MAX) return refused("invalid_request", `state is at most ${STATE_MAX} characters.`);
  const scopes = requestedScopes(params.scope);
  if (!scopes) return refused("invalid_scope", `The scopes this server grants are ${BUYER_SCOPES.join(", ")}.`);
  if (params.resource && !sameResource(params.resource, origin)) return refused("invalid_target", `The resource this server grants is ${mcpResource(origin)}.`);
  return {
    kind: "ok",
    request: { client, redirectUri, scopes, state: params.state ?? null, challenge: params.code_challenge, resource: params.resource ? mcpResource(origin) : null },
  };
}

// Why this signed-in account can't connect an app, or null. The rules for minting a buyer key by hand
// (actions/buyer-api.ts): a buyer account, its owner or a managing seat, Pro, and a buyer file the desk approved.
export function approvalProblem(user: User | ActingUser, file: { status: string } | null | undefined, now = new Date()) {
  if (user.role !== "BUYER") return "Only a buyer account can connect an AI assistant, since the connector reads the buyer API. Sign in with the buyer account.";
  if (user.deletedAt || accountLocked(user.accountStatus)) return "This account is suspended or closed.";
  if (!canManageSeats(user)) return "Only a managing seat or the account owner can connect an app, since it reads as the whole firm.";
  return buyerKeyProblem(user, file, now);
}

export type Decision = { redirect: string } | { error: string };

// Approve: a code good once, for five minutes, bound to the client, the redirect URI, the scopes and the PKCE challenge.
export async function approveAuthorization(user: User | ActingUser, params: AuthorizeParams, origin: string, now = new Date()): Promise<Decision> {
  const checked = await checkAuthorizeRequest(params, origin);
  if (checked.kind === "invalid") return { error: checked.error };
  if (checked.kind === "refused") return { error: checked.description };
  const file = await prisma.buyerProfile.findUnique({ where: { userId: user.id }, select: { status: true } });
  const problem = approvalProblem(user, file, now);
  if (problem) return { error: problem };
  const { client, redirectUri, scopes, state, challenge, resource } = checked.request;
  const code = randomBytes(32).toString("base64url");
  await prisma.oAuthCode.create({
    data: {
      codeHash: hashKey(code),
      clientId: client.clientId,
      userId: user.id,
      redirectUri,
      scopes: cleanBuyerScopes(scopes),
      challenge,
      ...(resource ? { resource } : {}),
      expiresAt: new Date(now.getTime() + CODE_MINUTES * MINUTE),
    },
  });
  await prisma.oAuthClient.update({ where: { id: client.id }, data: { lastUsedAt: now } });
  await audit(user.id, "OAUTH_APP_APPROVED", "oauthClient", client.id, `${client.name} · ${redirectHost(redirectUri)} · ${scopes.join(",")}`);
  // Codes are used within minutes. Now and then the ones a day past their time go.
  if (Math.random() < 0.05) await prisma.oAuthCode.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - DAY) } } });
  return { redirect: withParams(redirectUri, { code, state, iss: origin }) };
}

// Deny: the app hears access_denied, once its client and redirect URI check out.
export async function denyAuthorization(params: AuthorizeParams, origin: string): Promise<Decision> {
  const checked = await checkAuthorizeRequest(params, origin);
  if (checked.kind === "invalid") return { error: checked.error };
  const redirectUri = checked.kind === "ok" ? checked.request.redirectUri : checked.redirectUri;
  return { redirect: withParams(redirectUri, { error: "access_denied", error_description: "The account holder didn't approve the connection.", state: params.state, iss: origin }) };
}

// ---------------------------------------------------------------------------------------------------------------
// Tokens

const INVALID_GRANT = "The code or refresh token is invalid, expired or already used, or was issued to another client or redirect URI.";

// Why the account behind a grant can't have a token now, or null: the approval rules, checked again with nobody signed
// in. A seat's role was checked when it approved.
async function accountProblem(userId: string, now: Date) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.deletedAt || accountLocked(user.accountStatus)) return "This UPB account is suspended or closed.";
  if (user.role !== "BUYER") return "Only a buyer account can connect an app.";
  const file = await prisma.buyerProfile.findUnique({ where: { userId }, select: { status: true } });
  return buyerKeyProblem(user, file, now);
}

const keyName = (appName: string) => `${appName} (connected app)`;

// The grant's access token: its key row gets a new token and another hour. A grant whose row was revoked on its own
// (POST /oauth/revoke with the access token) gets a new row. A grant revoked while this ran has its key revoked too.
async function issueAccessToken(grant: { id: string; userId: string }, appName: string, scopes: string, now: Date) {
  const minted = mintKey();
  const data = { name: keyName(appName), prefix: minted.prefix, hash: minted.hash, scopes, expiresAt: new Date(now.getTime() + ACCESS_TOKEN_SECONDS * 1000) };
  const current = await prisma.apiKey.findFirst({ where: { grantId: grant.id, userId: grant.userId, ...unset("revokedAt") }, select: { id: true } });
  let keyId = current?.id ?? "";
  if (!current || (await prisma.apiKey.updateMany({ where: { id: current.id, ...unset("revokedAt") }, data })).count !== 1) {
    keyId = (await prisma.apiKey.create({ data: { userId: grant.userId, grantId: grant.id, ...data } })).id;
  }
  const live = await prisma.oAuthGrant.findFirst({ where: { id: grant.id, ...unset("revokedAt") }, select: { id: true } });
  if (!live) {
    await prisma.apiKey.updateMany({ where: { id: keyId }, data: { revokedAt: now } });
    return null;
  }
  return minted.token;
}

const newRefreshToken = () => `upbr_${randomBytes(32).toString("base64url")}`;

function tokenBody(accessToken: string, refreshToken: string, scopes: string) {
  return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refreshToken, scope: scopesOf({ scopes }).join(" ") };
}

async function exchangeCode(form: Record<string, string>, origin: string, now: Date): Promise<Answer> {
  const { code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource } = form;
  if (!code || !redirectUri || !clientId || !verifier) return oauthError(400, "invalid_request", "authorization_code needs code, redirect_uri, client_id and code_verifier.");
  const client = await findClient(clientId);
  if (!client) return oauthError(401, "invalid_client", "UPB doesn't know this client_id. Register the client again.");
  const row = code.length <= 200 ? await prisma.oAuthCode.findUnique({ where: { codeHash: hashKey(code) } }) : null;
  if (!row || row.clientId !== client.clientId || row.redirectUri !== redirectUri || row.usedAt || row.expiresAt.getTime() <= now.getTime()) {
    return oauthError(400, "invalid_grant", INVALID_GRANT);
  }
  if (!verifierMatches(verifier, row.challenge)) return oauthError(400, "invalid_grant", "code_verifier doesn't match the code_challenge.");
  if (resource && (!sameResource(resource, origin) || (row.resource && !sameResource(row.resource, origin)))) {
    return oauthError(400, "invalid_grant", "resource isn't the one this code was issued for.");
  }
  // Claimed once: of two requests with the same code, one wins.
  const claimed = await prisma.oAuthCode.updateMany({ where: { id: row.id, ...unset("usedAt"), expiresAt: { gt: now } }, data: { usedAt: now } });
  if (claimed.count !== 1) return oauthError(400, "invalid_grant", INVALID_GRANT);
  const problem = await accountProblem(row.userId, now);
  if (problem) return oauthError(400, "invalid_grant", problem);
  const refresh = newRefreshToken();
  const grant = await prisma.oAuthGrant.create({
    data: { clientId: client.clientId, userId: row.userId, scopes: row.scopes, refreshHash: hashKey(refresh), refreshExpiresAt: new Date(now.getTime() + REFRESH_DAYS * DAY), lastUsedAt: now },
  });
  const access = await issueAccessToken(grant, client.name, row.scopes, now);
  if (!access) return oauthError(400, "invalid_grant", INVALID_GRANT);
  await prisma.oAuthClient.update({ where: { id: client.id }, data: { lastUsedAt: now } });
  return { status: 200, body: tokenBody(access, refresh, row.scopes) };
}

async function refreshGrant(form: Record<string, string>, now: Date): Promise<Answer> {
  const { refresh_token: token, client_id: clientId } = form;
  if (!token || !clientId) return oauthError(400, "invalid_request", "refresh_token needs refresh_token and client_id.");
  const client = await findClient(clientId);
  if (!client) return oauthError(401, "invalid_client", "UPB doesn't know this client_id. Register the client again.");
  const oldHash = hashKey(token);
  const grant = token.length <= 200 ? await prisma.oAuthGrant.findUnique({ where: { refreshHash: oldHash } }) : null;
  if (!grant) {
    if (token.length <= 200) await replayedRefresh(oldHash, client.clientId, now);
    return oauthError(400, "invalid_grant", INVALID_GRANT);
  }
  if (grant.clientId !== client.clientId || grant.revokedAt || !grant.refreshExpiresAt || grant.refreshExpiresAt.getTime() <= now.getTime()) {
    return oauthError(400, "invalid_grant", INVALID_GRANT);
  }
  // A refresh may narrow the scopes, never widen them.
  const granted = scopesOf({ scopes: grant.scopes });
  const asked = form.scope ? requestedScopes(form.scope) : granted;
  if (!asked || asked.some((scope) => !granted.includes(scope))) return oauthError(400, "invalid_scope", `This grant covers ${granted.join(", ")}.`);
  const problem = await accountProblem(grant.userId, now);
  if (problem) return oauthError(400, "invalid_grant", problem);
  // The old refresh token is good once: of two requests with it, one wins, and it fails from then on.
  const refresh = newRefreshToken();
  const rotated = await prisma.oAuthGrant.updateMany({
    where: { id: grant.id, refreshHash: oldHash, ...unset("revokedAt") },
    data: { refreshHash: hashKey(refresh), previousRefreshHash: oldHash, refreshExpiresAt: new Date(now.getTime() + REFRESH_DAYS * DAY), lastUsedAt: now },
  });
  if (rotated.count !== 1) return oauthError(400, "invalid_grant", INVALID_GRANT);
  const scopes = cleanBuyerScopes(asked);
  const access = await issueAccessToken(grant, client.name, scopes, now);
  if (!access) return oauthError(400, "invalid_grant", INVALID_GRANT);
  await prisma.oAuthClient.update({ where: { id: client.id }, data: { lastUsedAt: now } });
  return { status: 200, body: tokenBody(access, refresh, scopes) };
}

// A refresh token that was already exchanged, presented again. Rotation leaves only the newest one working, so a second
// use of a replaced one means a copy is in someone else's hands, or the app lost an answer and retried. RFC 9700
// (4.14.2) treats it as theft: the grant and its access token are revoked and the buyer hears, in words that fit
// either case. A token two rotations old isn't recognised, and simply fails.
async function replayedRefresh(hash: string, clientId: string, now: Date) {
  const grant = await prisma.oAuthGrant.findFirst({ where: { previousRefreshHash: hash, clientId, ...unset("revokedAt") }, select: { id: true, userId: true } });
  if (!grant || !(await revokeGrantRows(grant.id, grant.userId, now))) return;
  await audit(null, "OAUTH_REFRESH_REPLAYED", "oauthGrant", grant.id, "A replaced refresh token was used again, so the connection was revoked");
  const [user, client] = await Promise.all([
    prisma.user.findUnique({ where: { id: grant.userId }, select: { email: true } }),
    prisma.oAuthClient.findUnique({ where: { clientId }, select: { name: true } }),
  ]);
  if (!user) return;
  const app = client?.name ? `"${client.name}"` : "a connected app";
  await notify(
    user.email,
    "A connected app was disconnected",
    `UPB disconnected ${app} from your account because an old sign-in token for it was used again. That happens when a copy of the token is used somewhere else, or when the app retries after losing an answer. If you still use the app, connect it again from the app itself. If you don't recognise it, look over your Buyer API keys and connected apps.`,
  );
}

// Clients that registered but never connected, after a month, and codes past their minutes: the jobs' cleanup. A
// client with any grant, live or revoked, stays, so the buyer's list and the audit log keep naming it.
export const UNUSED_CLIENT_DAYS = 30;

export async function cleanOAuth(now = new Date()) {
  const cutoff = new Date(now.getTime() - UNUSED_CLIENT_DAYS * DAY);
  const codes = await prisma.oAuthCode.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - DAY) } } });
  const stale = await prisma.oAuthClient.findMany({ where: { createdAt: { lt: cutoff }, ...unset("lastUsedAt") }, select: { clientId: true }, take: 5000 });
  let clients = 0;
  for (const { clientId } of stale) {
    if (await prisma.oAuthGrant.count({ where: { clientId } })) continue;
    if (await prisma.oAuthCode.count({ where: { clientId, expiresAt: { gt: now } } })) continue;
    clients += (await prisma.oAuthClient.deleteMany({ where: { clientId, ...unset("lastUsedAt") } })).count;
  }
  return `OAuth cleanup removed ${clients} unused client${clients === 1 ? "" : "s"} and ${codes.count} old code${codes.count === 1 ? "" : "s"}`;
}

// POST /oauth/token's answer. basicClient is a client_id sent as HTTP Basic. Clients here are public, so a secret,
// if one is sent, proves nothing and is ignored: PKCE does that work.
export async function tokenRequest(form: Record<string, string> | null, origin: string, basicClient = "", now = new Date()): Promise<Answer> {
  if (!form) return oauthError(400, "invalid_request", "Send the token request form-encoded, or as one JSON object, with each parameter once.");
  if (basicClient) {
    if (form.client_id && form.client_id !== basicClient) return oauthError(400, "invalid_request", "client_id differs between the header and the body.");
    form = { ...form, client_id: basicClient };
  }
  if (!form.grant_type) return oauthError(400, "invalid_request", "grant_type is required.");
  if (form.grant_type === "authorization_code") return exchangeCode(form, origin, now);
  if (form.grant_type === "refresh_token") return refreshGrant(form, now);
  return oauthError(400, "unsupported_grant_type", "grant_type is authorization_code or refresh_token.");
}

// ---------------------------------------------------------------------------------------------------------------
// Revocation

// The grant and every access token under it. The grant goes first, so a refresh running at the same moment sees it
// and revokes the token it made (issueAccessToken).
export async function revokeGrantRows(grantId: string, userId: string, now = new Date()) {
  const revoked = await prisma.oAuthGrant.updateMany({ where: { id: grantId, userId, ...unset("revokedAt") }, data: { revokedAt: now } });
  await prisma.apiKey.updateMany({ where: { grantId, userId, ...unset("revokedAt") }, data: { revokedAt: now } });
  return revoked.count === 1;
}

// RFC 7009, from the app: a refresh token revokes its grant and the grant's access token; an access token revokes
// itself. A key the buyer minted by hand isn't revoked here. An unknown token, or one issued to another client_id,
// changes nothing, and the answer is the same either way.
export async function revokeToken(form: Record<string, string> | null, basicClient = "", now = new Date()) {
  const token = form?.token ?? "";
  if (!token || token.length > 200) return;
  const clientId = basicClient || form?.client_id || "";
  if (token.startsWith("upb_")) {
    const key = await prisma.apiKey.findUnique({ where: { hash: hashKey(token) }, select: { id: true, grantId: true } });
    if (!key?.grantId) return;
    if (clientId) {
      const grant = await prisma.oAuthGrant.findUnique({ where: { id: key.grantId }, select: { clientId: true } });
      if (grant?.clientId !== clientId) return;
    }
    await prisma.apiKey.updateMany({ where: { id: key.id, ...unset("revokedAt") }, data: { revokedAt: now } });
    return;
  }
  const grant = await prisma.oAuthGrant.findUnique({ where: { refreshHash: hashKey(token) } });
  if (!grant || (clientId && grant.clientId !== clientId)) return;
  if (await revokeGrantRows(grant.id, grant.userId, now)) await audit(null, "OAUTH_GRANT_REVOKED", "oauthGrant", grant.id, "Revoked by the app");
}

// ---------------------------------------------------------------------------------------------------------------
// The buyer's list

export const CONNECTED_APPS_SHOWN = 50;

// The account's live grants, newest first, with each app's name and the hosts it returns to.
export async function connectedApps(userId: string, now = new Date()) {
  const grants = await prisma.oAuthGrant.findMany({
    where: { userId, ...unset("revokedAt"), refreshExpiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    take: CONNECTED_APPS_SHOWN,
  });
  // A few apps at most, each found by its unique id.
  const ids = [...new Set(grants.map((grant) => grant.clientId))];
  const clients = await Promise.all(ids.map((clientId) => prisma.oAuthClient.findUnique({ where: { clientId }, select: { clientId: true, name: true, redirectUris: true } })));
  const byId = new Map(clients.filter((client) => client !== null).map((client) => [client.clientId, client]));
  return grants.map((grant) => {
    const client = byId.get(grant.clientId);
    return {
      id: grant.id,
      name: client?.name ?? DEFAULT_CLIENT_NAME,
      hosts: [...new Set((client?.redirectUris ?? []).map(redirectHost).filter(Boolean))],
      scopes: scopesOf({ scopes: grant.scopes }),
      approvedAt: grant.createdAt,
      lastUsedAt: grant.lastUsedAt,
    };
  });
}
