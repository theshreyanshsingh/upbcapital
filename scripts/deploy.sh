#!/usr/bin/env bash
# Puts the latest UPB Capital from GitHub live on this server under pm2. Run it from the checkout:
#
#   cd /root/upbcapital && bash scripts/deploy.sh
#
#   1. git pull --ff-only. Already up to date is fine; a pull that can't fast-forward stops here and changes nothing.
#   2. npm ci when package-lock.json changed since the last install here, or node_modules is missing (--install
#      forces it). npm ci empties node_modules while the live server runs, so it isn't repeated for nothing.
#   3. npm run db:indexes.
#   4. npm run build into .next-build. The live site keeps serving .next throughout, so a failed build, or a failed
#      step before it, leaves the site as it was.
#   5. Moves .next to .next-old and .next-build to .next, and restarts the web process at once: one restart, a few
#      seconds. (A server that keeps running while .next is replaced under it serves pages whose CSS and scripts
#      answer 400, because it still holds the old build's file list.)
#   6. Waits for http://127.0.0.1:<port>/ to answer 200 and fetches every /_next/static file the home page names.
#      Anything else prints the web process's pm2 logs, says how to put the build before back, and fails.
#
# The web process is the pm2 process started from this checkout that runs `next start`, else the one named
# upb-capital; none is started on PORT (default 3009). Its port comes from its -p argument, else PORT, else 3009.
# upb-jobs is left alone: pm2 starts it on its cron (13:00 UTC) and it runs scripts/jobs.ts from source, so its next
# run uses this code. Restarting it would run every daily job straight away.

# Node and pm2 are often only on a login shell's PATH.
if ! command -v node >/dev/null 2>&1 && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
fi

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REAL_ROOT="$(cd "$ROOT" && pwd -P)"
cd "$ROOT"
# Only the build below may build elsewhere; next start always serves .next (next.config.ts).
unset UPB_BUILD_DIR

WEB_NAME="upb-capital"
step() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '\nDeploy stopped: %s\n' "$*" >&2
  exit 1
}

INSTALL=""
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    *) fail "unknown option $arg (the only option is --install, which runs npm ci even when package-lock.json is unchanged)." ;;
  esac
done

for tool in git node npm pm2; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed or not on PATH."
done
[ -f package.json ] && [ -f next.config.ts ] || fail "$ROOT is not the UPB Capital checkout."

# One deploy at a time.
LOCK="$ROOT/.deploy.lock"
mkdir "$LOCK" 2>/dev/null || fail "another deploy is running. (If none is, one was cut short: remove $LOCK and run this again.)"
trap 'rm -rf "$LOCK" 2>/dev/null || true' EXIT

step "Getting the latest code"
git pull --ff-only || fail "git pull could not fast-forward, so nothing was changed. Run git status here: a change made on this server may be in the way."
git log -1 --format='%h %s' | cut -c1-110

step "Installing packages"
LOCK_SUM="$(node -e 'const fs = require("fs"); console.log(require("crypto").createHash("sha256").update(fs.readFileSync("package-lock.json")).digest("hex"))')"
MARKER="node_modules/.upb-deploy-lock-sum"
if [ -n "$INSTALL" ] || [ ! -d node_modules ] || [ "$(cat "$MARKER" 2>/dev/null || true)" != "$LOCK_SUM" ]; then
  npm ci || fail "npm ci failed (above). The site still runs the build before, but node_modules changed under it: fix the error and deploy again soon."
  printf '%s\n' "$LOCK_SUM" > "$MARKER"
else
  echo "package-lock.json is unchanged since the last install here, so npm ci was skipped (--install forces it)."
fi

step "Syncing the database indexes"
npm run db:indexes || fail "npm run db:indexes failed (above). Nothing was built, and the site still runs the build before."

step "Building into .next-build while the site keeps running"
# The build before last goes now, so the disk holds at most the live build, the one before it and this one.
rm -rf .next-build .next-old
# This server runs other apps too, and a build that runs out of memory is killed part-way, so say what's free first.
if command -v free >/dev/null 2>&1; then free -m | awk '/^Mem:/ { printf "Memory: %s MB available of %s MB.", $7, $2 } /^Swap:/ { printf " Swap: %s MB.\n", $2 }'; fi
BUILD_LOG="$(mktemp)"
set +e
UPB_BUILD_DIR=.next-build npm run build 2>&1 | tee "$BUILD_LOG"
BUILD_STATUS=${PIPESTATUS[0]}
set -e
if [ "$BUILD_STATUS" != 0 ]; then
  rm -rf .next-build
  if [ "$BUILD_STATUS" = 137 ] || grep -qE "heap out of memory|SIGKILL|ENOMEM|^Killed" "$BUILD_LOG"; then
    rm -f "$BUILD_LOG"
    fail "the build ran out of memory and was stopped. The site was not touched: it still serves the build before. Give the server swap space once, then deploy again:
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab"
  fi
  rm -f "$BUILD_LOG"
  fail "the build failed (above). The site was not touched: it still serves the build before."
fi
rm -f "$BUILD_LOG"
[ -f .next-build/BUILD_ID ] || fail "the build finished without .next-build/BUILD_ID. The site was not touched."
NEW_BUILD="$(cat .next-build/BUILD_ID)"

# The web process, found before anything moves.
APP="$(pm2 jlist 2>/dev/null | node scripts/deploy-helpers.mjs web-app "$ROOT" "$REAL_ROOT" || true)"
APP_ID=""
APP_NAME="$WEB_NAME"
APP_PORT=""
if [ -n "$APP" ]; then
  read -r APP_ID APP_NAME APP_PORT <<< "$APP"
fi
PORT_TO_CHECK="${APP_PORT:-${PORT:-3009}}"

step "Switching to build $NEW_BUILD and restarting $APP_NAME"
if [ -d .next ]; then
  mv .next .next-old || fail "could not move .next aside (above). The site still serves it; the new build is in .next-build."
fi
mv .next-build .next || fail "could not move .next-build to .next (above). Put the build before back with: mv .next-old .next && pm2 restart $APP_NAME"
if [ -n "$APP_ID" ]; then
  pm2 restart "$APP_ID" || fail "pm2 could not restart $APP_NAME (above). .next now holds the new build; run pm2 restart $APP_NAME."
else
  echo "No pm2 process serves this checkout yet, so $WEB_NAME is started on port $PORT_TO_CHECK."
  pm2 start node_modules/.bin/next --name "$WEB_NAME" -- start -p "$PORT_TO_CHECK" -H 0.0.0.0 || fail "pm2 could not start $WEB_NAME (above)."
  APP_NAME="$WEB_NAME"
fi
pm2 save >/dev/null || echo "pm2 save failed; the process list is not saved for a reboot."

step "Checking http://127.0.0.1:$PORT_TO_CHECK/ and its build files"
if ! node scripts/deploy-helpers.mjs check "http://127.0.0.1:$PORT_TO_CHECK" --wait 120; then
  printf '\npm2 logs for %s (last 80 lines):\n' "$APP_NAME" >&2
  pm2 logs "$APP_NAME" --lines 80 --nostream 2>&1 | tail -n 120 >&2 || true
  if [ -d .next-old ]; then
    printf '\nTo put the build before back (it then runs with the new checkout, packages and next.config.ts):\n  cd %s && rm -rf .next && mv .next-old .next && pm2 restart %s\n' "$ROOT" "$APP_NAME" >&2
  fi
  fail "the site on port $PORT_TO_CHECK is not serving build $NEW_BUILD cleanly. Its logs are above."
fi

step "Done: commit $(git log -1 --format='%h') is live as build $NEW_BUILD"
echo "The build before is kept in .next-old until the next deploy."
pm2 ls
