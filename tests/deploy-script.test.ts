import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildDir } from "../next.config";
import { pm2List, portOf, staticUrls, webApp } from "../scripts/deploy-helpers.mjs";

const ROOT = "/root/upbcapital";

function proc(pm_id: number, name: string, cwd: string, exec: string, args: string[] | string, env: Record<string, unknown> = {}) {
  return { pm_id, name, pm2_env: { pm_cwd: cwd, pm_exec_path: exec, args, ...env } };
}

const WEB = proc(3, "upb-capital", ROOT, `${ROOT}/node_modules/.bin/next`, ["start", "-p", "3009", "-H", "0.0.0.0"]);
const JOBS = proc(4, "upb-jobs", ROOT, `${ROOT}/node_modules/.bin/tsx`, ["--env-file=.env", "scripts/jobs.ts"]);
const SYNERGY = proc(1, "synergyfund", "/root/synergyfund", "/root/synergyfund/node_modules/.bin/next", ["start", "-p", "3007"]);
const LENDHOUS = proc(2, "lendhous", "/root/lendhous", "/root/lendhous/node_modules/next/dist/bin/next", ["start", "-p", "3011"]);

test("deploy.sh finds the pm2 process serving this checkout, not upb-jobs or another app", () => {
  assert.equal(webApp([SYNERGY, LENDHOUS, JOBS, WEB], [ROOT])?.pm_id, 3);
  // Renamed, it is still the checkout's `next start`.
  const renamed = { ...WEB, name: "upb" };
  assert.equal(webApp([JOBS, renamed, SYNERGY], [ROOT])?.name, "upb");
  // Started from the checkout's real path behind a symlink.
  assert.equal(webApp([proc(5, "upb-capital", "/data/upbcapital", "/data/upbcapital/node_modules/next/dist/bin/next", "start -p 3010")], [ROOT, "/data/upbcapital"])?.pm_id, 5);
  // Started from elsewhere but named upb-capital.
  assert.equal(webApp([SYNERGY, proc(6, "upb-capital", "/srv/other", "/usr/bin/npm", ["start"])], [ROOT])?.pm_id, 6);
  assert.equal(webApp([SYNERGY, LENDHOUS, JOBS], [ROOT]), null, "upb-jobs alone is never the web process");
  assert.equal(webApp([], [ROOT]), null);
});

test("the web process's port comes from its arguments, then its PORT", () => {
  assert.equal(portOf(WEB), "3009");
  assert.equal(portOf(proc(1, "a", ROOT, "next", "start --port 3012")), "3012");
  assert.equal(portOf(proc(1, "a", ROOT, "next", ["start", "--port=3013"])), "3013");
  assert.equal(portOf(proc(1, "a", ROOT, "next", ["start"], { PORT: "3014" })), "3014");
  assert.equal(portOf(proc(1, "a", ROOT, "next", ["start"], { env: { PORT: 3015 } })), "3015");
  assert.equal(portOf(proc(1, "a", ROOT, "next", ["start"])), "");
});

test("pm2's list is read past any notice it prints first", () => {
  assert.equal(pm2List(`>>>> In-memory PM2 is out-of-date, do:\n>>>> $ pm2 update\n${JSON.stringify([WEB])}`).length, 1);
  assert.deepEqual(pm2List(""), []);
  assert.deepEqual(pm2List("[not json"), []);
});

test("the home page's build files are read from its tags and its React data", () => {
  const html = [
    '<link rel="stylesheet" href="/_next/static/css/876bd18aa4c4d55b.css" data-precedence="next"/>',
    '<script src="/_next/static/chunks/webpack-1a2b.js" async=""></script>',
    '<script src="/_next/static/chunks/main-app-3c4d.js?dpl=abc&amp;v=2" async=""></script>',
    '<link rel="preload" as="font" href="/_next/static/media/inter.woff2" crossorigin=""/>',
    '<script>self.__next_f.push([1,"2:I[1234,[\\"static/chunks/123-abc.js\\",\\"static/chunks/app/page-def.js\\"],\\"default\\"]"])</script>',
    '<script src="/_next/static/chunks/webpack-1a2b.js" async=""></script>',
    '<script src="/_next/static/chunks/app/(desk)/layout-9f8e.js" async=""></script>',
    "<style>@font-face{src:url(/_next/static/media/serif.woff2) format('woff2')}</style>",
    '<script>self.__next_f.push([1,"3:I[55,[\\"static/chunks/app/(desk)/admin/page-77.js\\"],\\"default\\"]"])</script>',
  ].join("\n");
  assert.deepEqual(staticUrls(html).sort(), [
    "/_next/static/chunks/123-abc.js",
    "/_next/static/chunks/app/(desk)/admin/page-77.js",
    "/_next/static/chunks/app/(desk)/layout-9f8e.js",
    "/_next/static/chunks/app/page-def.js",
    "/_next/static/chunks/main-app-3c4d.js?dpl=abc&v=2",
    "/_next/static/chunks/webpack-1a2b.js",
    "/_next/static/css/876bd18aa4c4d55b.css",
    "/_next/static/media/inter.woff2",
    "/_next/static/media/serif.woff2",
  ]);
  assert.deepEqual(staticUrls("<html>no build files</html>"), []);
});

test("only deploy.sh's .next-build may replace .next, and it type-checks with its own route types", () => {
  assert.equal(buildDir({}), ".next");
  assert.equal(buildDir({ UPB_BUILD_DIR: ".next-build" }), ".next-build");
  assert.throws(() => buildDir({ UPB_BUILD_DIR: "../elsewhere" }), /only be \.next-build/);
  const deploy = JSON.parse(readFileSync("tsconfig.deploy.json", "utf8")) as { include: string[] };
  // Next adds its build folder's types to the include list itself when they are missing, which would leave the
  // server's checkout with a changed file; and the live build's types beside them would clash.
  assert.ok(deploy.include.includes(".next-build/types/**/*.ts"));
  assert.ok(!deploy.include.some((entry) => entry.startsWith(".next/")));
  const script = readFileSync("scripts/deploy.sh", "utf8");
  assert.match(script, /UPB_BUILD_DIR=\.next-build npm run build/);
  assert.match(script, /git pull --ff-only/);
  assert.match(script, /npm run db:indexes/);
  assert.doesNotMatch(script, /pm2 (restart|reload|start|delete) [^\n]*upb-jobs/, "upb-jobs is never restarted");
});
