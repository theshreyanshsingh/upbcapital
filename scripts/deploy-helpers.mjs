// Helpers for scripts/deploy.sh, in plain Node (22 or later) so the server needs nothing else. Two commands:
//
//   node scripts/deploy-helpers.mjs web-app <checkout> [<checkout's real path>] < (pm2 jlist output)
//     Prints "<pm2 id> <name> <port>" for the pm2 process that serves this checkout's site, or nothing. It is the
//     process started from the checkout that runs `next start` (named upb-capital in README.md), else any process
//     named upb-capital. The port is its -p/--port argument, else its PORT, else nothing.
//
//   node scripts/deploy-helpers.mjs check <origin> [--wait <seconds>]
//     Waits until <origin>/ answers 200, then fetches every /_next/static file the home page names and fails if
//     any answers anything but 200: the sign of a server running with another build's manifests.

import { realpathSync } from "node:fs";
import { argv, exit, stdin } from "node:process";
import { fileURLToPath } from "node:url";

const WEB_NAME = "upb-capital";

async function readStdin() {
  let raw = "";
  for await (const chunk of stdin) raw += chunk;
  return raw;
}

// pm2 may print a notice before its JSON, so the list starts at the first "[".
export function pm2List(raw) {
  const start = raw.indexOf("[");
  if (start < 0) return [];
  try {
    const list = JSON.parse(raw.slice(start));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function argsOf(item) {
  const args = item?.pm2_env?.args;
  if (Array.isArray(args)) return args.map(String);
  return typeof args === "string" ? args.split(/\s+/).filter(Boolean) : [];
}

export function portOf(item) {
  const args = argsOf(item);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === "-p" || arg === "--port") && /^\d+$/.test(args[index + 1] ?? "")) return args[index + 1];
    const joined = /^--port=(\d+)$/.exec(arg);
    if (joined) return joined[1];
  }
  const env = item?.pm2_env ?? {};
  const port = env.PORT ?? env.env?.PORT;
  return /^\d+$/.test(String(port ?? "")) ? String(port) : "";
}

function servesNext(item) {
  const script = String(item?.pm2_env?.pm_exec_path ?? "");
  return /(^|\/)next$/.test(script) || /next\/dist\/bin\/next$/.test(script) ? argsOf(item).includes("start") : false;
}

export function webApp(list, roots) {
  const inCheckout = (item) => {
    const cwd = String(item?.pm2_env?.pm_cwd ?? "").replace(/\/$/, "");
    return roots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
  };
  const ours = list.filter(inCheckout);
  return (
    ours.find((item) => item.name === WEB_NAME && servesNext(item)) ??
    ours.find(servesNext) ??
    ours.find((item) => item.name === WEB_NAME) ??
    list.find((item) => item.name === WEB_NAME) ??
    null
  );
}

// Every build file the page names: /_next/static/... in tags, and static/... inside the page's escaped React data.
// Route groups put parentheses in chunk paths (app/(desk)/layout-....js), so a ")" ends a URL only when it closes a
// CSS url( that the path didn't open.
function trimUrl(url) {
  let trimmed = url;
  const count = (text, char) => text.split(char).length - 1;
  while (trimmed.endsWith(")") && count(trimmed, ")") > count(trimmed, "(")) trimmed = trimmed.slice(0, -1);
  return trimmed.replace(/&amp;/g, "&");
}

export function staticUrls(html) {
  const found = new Set();
  for (const match of html.matchAll(/\/_next\/static\/[^"'\s<>\\]+/g)) found.add(trimUrl(match[0]));
  for (const match of html.matchAll(/\\"(static\/(?:chunks|css|media)\/[^"'\s<>\\]+)\\"/g)) found.add(trimUrl(`/_next/${match[1]}`));
  return [...found];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function statusOf(url) {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    await response.arrayBuffer();
    return response.status;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function check(origin, waitSeconds) {
  const home = `${origin.replace(/\/$/, "")}/`;
  const until = Date.now() + waitSeconds * 1000;
  let last = "";
  let html = "";
  for (;;) {
    try {
      const response = await fetch(home, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
      const body = await response.text();
      if (response.status === 200) {
        html = body;
        break;
      }
      last = `answered ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    }
    if (Date.now() > until) {
      console.error(`${home} did not answer 200 within ${waitSeconds} seconds (last: ${last}).`);
      return false;
    }
    await sleep(2000);
  }
  console.log(`${home} answers 200.`);
  const urls = staticUrls(html);
  if (!urls.length) {
    console.error("The home page names no /_next/static files, so the build can't be checked.");
    return false;
  }
  const failed = [];
  for (let index = 0; index < urls.length; index += 8) {
    const batch = urls.slice(index, index + 8);
    const statuses = await Promise.all(batch.map((url) => statusOf(new URL(url, home).href)));
    statuses.forEach((status, at) => {
      if (status !== 200) failed.push(`${status} ${batch[at]}`);
    });
  }
  if (failed.length) {
    console.error(`${failed.length} of ${urls.length} build files the home page names did not answer 200:`);
    for (const line of failed.slice(0, 20)) console.error(`  ${line}`);
    return false;
  }
  console.log(`All ${urls.length} build files the home page names answer 200.`);
  return true;
}

async function main() {
  const [command, ...rest] = argv.slice(2);
  if (command === "web-app") {
    const roots = rest.filter(Boolean).map((root) => root.replace(/\/$/, ""));
    const item = webApp(pm2List(await readStdin()), roots);
    if (item) console.log(`${item.pm_id} ${item.name} ${portOf(item)}`.trim());
    return 0;
  }
  if (command === "check" && rest[0]) {
    const at = rest.indexOf("--wait");
    const wait = at >= 0 ? Number(rest[at + 1]) : 120;
    return (await check(rest[0], Number.isFinite(wait) && wait > 0 ? wait : 120)) ? 0 : 1;
  }
  console.error("Usage: node scripts/deploy-helpers.mjs web-app <checkout> [<real path>] < pm2-jlist.json | check <origin> [--wait <seconds>]");
  return 2;
}

// Run as a command; imported by the tests, it only exports. Real paths, so a symlinked checkout still runs it.
function runAsCommand() {
  try {
    return Boolean(argv[1]) && realpathSync(argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// No top-level await: the tests load this file through require.
if (runAsCommand()) {
  main().then(
    (code) => exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      exit(1);
    },
  );
}
