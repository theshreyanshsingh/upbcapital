import { checkApiKey, tokenOf, type ApiScope } from "@/lib/api-keys";
import { API_LIMIT } from "@/lib/api-limit";
import { PAGE_LIMIT } from "@/lib/buyer-api";
import { PROGRAM_CHOICES } from "@/lib/filters";
import { LIEN_POSITIONS, PAYMENT_STATUSES } from "@/lib/labels";

// The MCP connector: a Model Context Protocol server over the read-only buyer API, so a buyer can point an AI
// assistant at their UPB account with the key they already use. It speaks MCP's streamable HTTP transport in plain
// JSON mode: one JSON-RPC message per POST to /api/mcp, answered with one JSON body, or 202 and no body for a
// notification. There is no event stream and no session.
//
// Each tool reads one /api/v1 endpoint by calling its handler in-process with the caller's own Authorization header
// (app/api/mcp/route.ts passes the handlers in). So the key check, scopes, Pro, visibility, seller anonymity, the
// rate limit and the call log are exactly the API's, and each tool call is one API call. Connecting, listing the tools
// and ping check the key but aren't API calls. Nothing here writes.

export const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_SERVER = { name: "upb-capital", version: "1.0.0" } as const;
export const MCP_PATH = "/api/mcp";

// JSON-RPC's own codes, and one from the range it leaves to servers, for a key that is turned away.
export const RPC_ERRORS = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, keyRefused: -32001 } as const;

// A tool call's arguments are a few short values. A body far bigger than that isn't one.
const BODY_MAX = 64 * 1024;

type Json = Record<string, unknown>;
type RpcId = string | number | null;

export type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Json; isError?: boolean };
export type ToolRunner = (tool: McpTool, args: Json) => Promise<ToolResult>;

type StringProp = { type: "string"; description: string; enum?: readonly string[]; pattern?: string; format?: "date-time"; minLength?: number };
type NumberProp = { type: "integer" | "number"; description: string; minimum?: number; maximum?: number };
type BooleanProp = { type: "boolean"; description: string };
type ListProp = { type: "array"; description: string; items: { type: "string"; enum: readonly string[] } };
type Prop = StringProp | NumberProp | BooleanProp | ListProp;

export type V1Route = "listings" | "listing" | "matches" | "offers" | "offer" | "holdings";
export type V1Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
export type V1Routes = Record<V1Route, V1Handler>;

export type McpTool = {
  name: string;
  title: string;
  // One line for the developers page. description is what the assistant reads.
  summary: string;
  description: string;
  route: V1Route;
  // The v1 path it reads, with :id for the tool's id argument.
  endpoint: string;
  scope: ApiScope;
  properties: Record<string, Prop>;
  required?: string[];
};

const values = (items: readonly { value: string }[]) => items.map((item) => item.value);
const choices = (description: string, allowed: readonly string[]): ListProp => ({ type: "array", description, items: { type: "string", enum: allowed } });

// limit, cursor and updated_since, by the names the REST API gives them (lib/buyer-api.ts readPage).
const PAGING: Record<string, Prop> = {
  limit: { type: "integer", minimum: 1, maximum: PAGE_LIMIT.max, description: `Rows per page: ${PAGE_LIMIT.default} if left out, at most ${PAGE_LIMIT.max}.` },
  cursor: { type: "string", description: "The nextCursor from the previous page, to read the next one. Send the same other arguments with it." },
  updated_since: { type: "string", format: "date-time", description: "An ISO 8601 time, such as 2026-11-01T00:00:00Z. Only rows that changed at or after it." },
};

const PAGED = "Rows come oldest change first. When nextCursor is set, more follow: call again with it as cursor.";

export const MCP_TOOLS: McpTool[] = [
  {
    name: "search_listings",
    title: "Search live listings",
    summary: "live listings this account may see, with the book's filters",
    description:
      "Search the live book: mortgage-note listings this account may see that are taking bids or in contract. Each row is one listing's summary: loan count, states, lien positions, payment statuses, unpaid balance (upb), asking price, estimated value, LTV, price to UPB, current yield, note rate, sale format and bid deadline, the seller as a type such as Credit union until this account is in the data room, and webUrl to open it on UPB. Money is in dollars and ratios in percent. A pool is judged on its loans still for sale: balance and LTV on their totals, state, lien, performance and program on any one loan. " +
      PAGED,
    route: "listings",
    endpoint: "/api/v1/listings",
    scope: "listings:read",
    properties: {
      state: { type: "string", pattern: "^[A-Za-z]{2}$", description: "Two-letter state code, such as FL." },
      lien_position: choices("Lien positions to include.", values(LIEN_POSITIONS)),
      payment_status: choices("Payment statuses to include.", values(PAYMENT_STATUSES)),
      loan_program: choices("Loan programs to include. A loan whose tape states no program matches none.", values(PROGRAM_CHOICES)),
      cra: {
        type: "boolean",
        description: "true for CRA-eligible paper only: a loan whose tape puts the property in a low- or moderate-income census tract, or marks the borrower LMI. This is UPB's simplified reading of the tape; the bank's CRA officer and regulator decide what counts.",
      },
      max_ltv: { type: "number", minimum: 0, description: "Highest loan-to-value, in percent." },
      min_upb: { type: "number", minimum: 0, description: "Lowest unpaid balance, in dollars." },
      max_upb: { type: "number", minimum: 0, description: "Highest unpaid balance, in dollars." },
      ...PAGING,
    },
  },
  {
    name: "get_listing",
    title: "Read one listing",
    summary: "one listing's summary and loan tape",
    description:
      "One live listing by id: its summary and loan tape as a signed-in buyer reads it before the confidentiality agreement. Each loan carries its city, state, balance, rate, payment, delinquency, dates, pay string, credit score and the other open tape fields, never the street, zip, borrower, loan number or a data-room file. paused is true while the seller hasn't reconfirmed the loans are still available. otherBidders is how many other firms hold a live bid, where the seller chose to show it, never an amount. A listing this account may not see reads as not found.",
    route: "listing",
    endpoint: "/api/v1/listings/:id",
    scope: "listings:read",
    properties: { id: { type: "string", minLength: 1, description: "The listing's id, as search_listings or list_matches gives it." } },
    required: ["id"],
  },
  {
    name: "list_matches",
    title: "List buy-box matches",
    summary: "live listings that fit one of the account's buy boxes",
    description:
      "This account's buy-box matches on the live book: each listing that fits one of its buy boxes, with the score, the reasons, and indicativePrice, the box's own standing price where it has one. That price binds nothing until the buyer confirms it as a bid on UPB. updatedAt is when the match was made or its standing price last moved. " +
      PAGED,
    route: "matches",
    endpoint: "/api/v1/matches",
    scope: "matches:read",
    properties: { ...PAGING },
  },
  {
    name: "list_offers",
    title: "List this account's offers",
    summary: "the account's own bids and requests and where each stands",
    description:
      "This account's own bids and requests and where each stands: OPEN, REVIEWED, ACCEPTED, DECLINED, WITHDRAWN or EXPIRED. amount is the account's own latest price. counter is a price the desk or the seller put to it that it hasn't answered, and counterFrom says whose. No other bidder's amount is ever here. " +
      PAGED,
    route: "offers",
    endpoint: "/api/v1/offers",
    scope: "offers:read",
    properties: { ...PAGING },
  },
  {
    name: "get_offer",
    title: "Read one offer",
    summary: "one of the account's own bids or requests",
    description: "One of this account's own bids or requests by id, as list_offers gives it. Anyone else's reads as not found.",
    route: "offer",
    endpoint: "/api/v1/offers/:id",
    scope: "offers:read",
    properties: { id: { type: "string", minLength: 1, description: "The offer's id, as list_offers gives it." } },
    required: ["id"],
  },
  {
    name: "list_holdings",
    title: "List holdings",
    summary: "the notes the account holds, as its portfolio lists them",
    description:
      "Notes this account holds, as its portfolio lists them: closed trades and notes added by hand, with status, cost basis, unpaid balance, share and underwritten yield. Paging reads the acquisition date as the change time. " +
      PAGED,
    route: "holdings",
    endpoint: "/api/v1/holdings",
    scope: "holdings:read",
    properties: { ...PAGING },
  },
];

export const MCP_INSTRUCTIONS = [
  "UPB Capital is a marketplace for US mortgage notes. This server reads one buyer account through the UPB buyer API, read-only:",
  "the live listings it may see, one listing's loan tape, its buy-box matches, its own bids and requests, and its holdings.",
  "It cannot bid, message or change anything; that happens on UPB itself, where each row's webUrl leads.",
  "Money is in dollars and ratios in percent.",
  `Each tool call is one API call, counted against the key's ${API_LIMIT.requests} a minute and shown in the account's API call log.`,
  "Lists come a page at a time: pass nextCursor back as cursor.",
].join(" ");

// The protocol version to answer with: the client's when this server speaks it, else the newest it does.
export function negotiateVersion(asked: unknown) {
  return typeof asked === "string" && (MCP_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_VERSIONS[0];
}

// A tool as tools/list gives it. Every one only reads.
export function listedTool(tool: McpTool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: { type: "object", properties: tool.properties, ...(tool.required ? { required: tool.required } : {}), additionalProperties: false },
    annotations: { title: tool.title, readOnlyHint: true, openWorldHint: false },
  };
}

const KIND: Record<Prop["type"], string> = { string: "text", integer: "a whole number", number: "a number", boolean: "true or false", array: "a list of text values" };

function fits(prop: Prop, value: unknown) {
  switch (prop.type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
  }
}

// What's wrong with a tool's arguments, in one sentence, or null. Only their names and types are checked here: the
// endpoint reads the values and says what it can't, in the words it gives the REST API.
export function argumentProblem(tool: McpTool, args: Json) {
  for (const name of tool.required ?? []) {
    if (args[name] == null || args[name] === "") return `${tool.name} needs ${name}.`;
  }
  for (const [name, value] of Object.entries(args)) {
    const prop = tool.properties[name];
    if (!prop) return `${tool.name} takes no argument named ${name.slice(0, 40)}. It takes ${Object.keys(tool.properties).join(", ")}.`;
    if (value != null && !fits(prop, value)) return `${name} is ${KIND[prop.type]}.`;
  }
  return null;
}

// The v1 URL a tool call reads: the id in the path, the rest as the query parameters of the same names. A list is
// comma-separated, as the API takes it, and true is 1.
export function toolUrl(tool: McpTool, args: Json, base: string) {
  const id = typeof args.id === "string" ? args.id : "";
  const url = new URL(tool.endpoint.replace(":id", encodeURIComponent(id)), base);
  for (const [name, value] of Object.entries(args)) {
    if (name === "id" || value == null || value === "" || value === false) continue;
    if (Array.isArray(value)) {
      if (value.length) url.searchParams.set(name, value.join(","));
    } else url.searchParams.set(name, value === true ? "1" : String(value));
  }
  return url;
}

function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

// Only these reach the v1 handler: the key, and the addresses the call log hashes.
const FORWARDED = ["authorization", "x-forwarded-for", "x-real-ip"];

// Runs a tool by calling its v1 handler with a GET to the endpoint's own URL, carrying the caller's key. A 2xx answer
// comes back as the API's JSON; anything else as an error with the API's own sentence, a 429's wait included.
export function v1Runner(request: Request, routes: V1Routes): ToolRunner {
  return async (tool, args) => {
    const headers = new Headers();
    for (const name of FORWARDED) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const id = typeof args.id === "string" ? args.id : "";
    let response: Response;
    try {
      response = await routes[tool.route](new Request(toolUrl(tool, args, request.url), { headers }), { params: Promise.resolve({ id }) });
    } catch (error) {
      console.error(`[upb-mcp] ${tool.name} failed:`, error instanceof Error ? error.message : error);
      return toolError("The API couldn't answer just now. Try again in a minute.");
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) return toolError(isObject(body) && typeof body.error === "string" ? body.error : `The API answered ${response.status}.`);
    return { content: [{ type: "text", text: JSON.stringify(body) }], ...(isObject(body) ? { structuredContent: body } : {}) };
  };
}

export type McpReply = { status: number; body: Json | null };

const result = (id: RpcId, value: unknown): McpReply => ({ status: 200, body: { jsonrpc: "2.0", id, result: value } });
const failure = (status: number, id: RpcId, code: number, message: string): McpReply => ({ status, body: { jsonrpc: "2.0", id, error: { code, message } } });
const idOf = (message: unknown): RpcId => (isObject(message) && (typeof message.id === "string" || typeof message.id === "number") ? message.id : null);

// One POST body's answer. A message that can't be read is a 400; a method this server doesn't have, or a call to a
// tool it doesn't have, is a JSON-RPC error; a tool that runs and fails is a tool result marked isError, so the
// assistant reads why. protocolHeader is MCP-Protocol-Version, which a client sends after initialize.
export async function answerMcp(raw: string, run: ToolRunner, protocolHeader: string | null = null): Promise<McpReply> {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return failure(400, null, RPC_ERRORS.parse, "Parse error: the body isn't JSON.");
  }
  // Batching left the protocol in 2025-06-18.
  if (Array.isArray(message)) return failure(400, null, RPC_ERRORS.invalidRequest, "Batches aren't supported. Send one JSON-RPC message per request.");
  if (!isObject(message) || message.jsonrpc !== "2.0") return failure(400, idOf(message), RPC_ERRORS.invalidRequest, "Invalid request: send one JSON-RPC 2.0 object.");
  if (typeof message.method !== "string") {
    // A client's answer to a server request. This server sends none, so there is nothing to match it to.
    if ("id" in message && ("result" in message || "error" in message)) return { status: 202, body: null };
    return failure(400, idOf(message), RPC_ERRORS.invalidRequest, "Invalid request: method is missing.");
  }
  // A notification, such as notifications/initialized, has no id and gets no answer.
  if (!("id" in message)) return { status: 202, body: null };
  const id = idOf(message);
  if (id == null) return failure(400, null, RPC_ERRORS.invalidRequest, "Invalid request: id is a string or a number.");
  const method = message.method;
  if (message.params !== undefined && !isObject(message.params)) return failure(200, id, RPC_ERRORS.invalidParams, "params is an object.");
  const params = (message.params ?? {}) as Json;
  if (method !== "initialize" && protocolHeader && !(MCP_VERSIONS as readonly string[]).includes(protocolHeader)) {
    return failure(400, id, RPC_ERRORS.invalidRequest, `Unsupported MCP-Protocol-Version. This server speaks ${MCP_VERSIONS.join(", ")}.`);
  }
  switch (method) {
    case "initialize":
      return result(id, { protocolVersion: negotiateVersion(params.protocolVersion), capabilities: { tools: {} }, serverInfo: MCP_SERVER, instructions: MCP_INSTRUCTIONS });
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: MCP_TOOLS.map(listedTool) });
    case "tools/call": {
      const tool = MCP_TOOLS.find((item) => item.name === params.name);
      if (!tool) return failure(200, id, RPC_ERRORS.invalidParams, `Unknown tool: ${String(params.name).slice(0, 80)}. tools/list names the ${MCP_TOOLS.length} this server has.`);
      const args = params.arguments ?? {};
      if (!isObject(args)) return result(id, toolError("arguments is an object."));
      const problem = argumentProblem(tool, args);
      return result(id, problem ? toolError(problem) : await run(tool, args));
    }
    default:
      return failure(200, id, RPC_ERRORS.methodNotFound, `Method not found: ${method.slice(0, 80)}. This server answers initialize, ping, tools/list and tools/call.`);
  }
}

// RFC 6750's challenge, so a client knows to send a bearer token.
const CHALLENGE = 'Bearer realm="upb-capital"';

function refusal(status: number, message: string, headers?: Record<string, string>, code: number = RPC_ERRORS.keyRefused) {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status, headers });
}

// POST /api/mcp. Every request carries a buyer's key, checked as the API checks it (lib/api-keys.ts). Pro and the
// scopes are the endpoint's to refuse, so a tool call on a lapsed or narrow key comes back with the API's own reason.
export async function mcpPost(request: Request, routes: V1Routes): Promise<Response> {
  const header = request.headers.get("authorization");
  if (!tokenOf(header)) return refusal(401, "Send a UPB buyer API key as Authorization: Bearer upb_… . Mint one at /buyer/api.", { "WWW-Authenticate": CHALLENGE });
  const check = await checkApiKey(header);
  if (!check.ok) return refusal(401, check.error, { "WWW-Authenticate": `${CHALLENGE}, error="invalid_token"` });
  // The tools are the buyer endpoints, so a seller's or the desk's key has nothing to read here.
  if (check.user.role !== "BUYER") return refusal(403, "The MCP connector reads the buyer API, so it takes a buyer account's key. Mint one at /buyer/api.");
  const tooLarge = () => refusal(413, "That request is too large for one MCP message.", undefined, RPC_ERRORS.invalidRequest);
  if (Number(request.headers.get("content-length") || 0) > BODY_MAX) return tooLarge();
  const raw = await request.text();
  if (raw.length > BODY_MAX) return tooLarge();
  const reply = await answerMcp(raw, v1Runner(request, routes), request.headers.get("mcp-protocol-version"));
  return reply.body ? Response.json(reply.body, { status: reply.status }) : new Response(null, { status: reply.status });
}

// The transport's GET (an event stream) and DELETE (ending a session) have nothing behind them here.
export function mcpNotAllowed() {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code: RPC_ERRORS.invalidRequest, message: "This MCP server answers POST only. It has no event stream and no session to end." } },
    { status: 405, headers: { Allow: "POST" } },
  );
}
