/* UPB Capital service worker: push notices, deep links on tap, and an offline page.
   It caches no page and no data. Desk pages carry borrower and deal data, so they always come from the network. */

const HOME = "/notifications";
const ICON = "/icon/192";
const BADGE = "/icons/badge";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Preload starts the page request while the worker boots, so the worker adds no wait to a page load.
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => undefined);
      await self.clients.claim();
    })(),
  );
});

// Only a path inside this site opens. Anything else opens the notices list.
function inAppUrl(value) {
  try {
    const url = new URL(typeof value === "string" && value ? value : HOME, self.location.origin);
    return url.origin === self.location.origin ? url.href : new URL(HOME, self.location.origin).href;
  } catch {
    return new URL(HOME, self.location.origin).href;
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 80) : "New notice";
  const body = typeof data.body === "string" ? data.body.slice(0, 160) : "Open UPB Capital to see it.";
  const url = inAppUrl(data.url);
  const work = [
    self.registration.showNotification(title, {
      body,
      icon: ICON,
      badge: BADGE,
      data: { url },
    }),
  ];
  // The app icon's badge is the unread count, on installed apps that support it.
  if (typeof data.badge === "number" && self.navigator && "setAppBadge" in self.navigator) {
    work.push((data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => undefined));
  }
  event.waitUntil(Promise.all(work));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = inAppUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          const focused = await client.focus();
          if (focused && "navigate" in focused) {
            await focused.navigate(target);
            return;
          }
        } catch {
          // An uncontrolled window can't be steered. A new one opens below.
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});

const OFFLINE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline · UPB Capital</title>
<style>
  :root { color-scheme: light dark; --bg: #f3f4f6; --card: #ffffff; --ink: #111827; --muted: #4b5563; --line: #e5e7eb; --button: #111111; --button-ink: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #101114; --card: #1c1f26; --ink: #f4f4f5; --muted: #a1a1aa; --line: #2c313a; --button: #f4f4f5; --button-ink: #111214; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink); font: 15px/1.5 Inter, system-ui, -apple-system, sans-serif; }
  main { max-width: 360px; margin: 16px; padding: 24px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; }
  .mark { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; background: var(--button); color: var(--button-ink); font-weight: 700; font-size: 14px; }
  h1 { margin: 16px 0 6px; font-size: 20px; letter-spacing: -0.01em; }
  p { margin: 0; color: var(--muted); }
  button { margin-top: 18px; height: 40px; padding: 0 16px; border: 0; border-radius: 8px; background: var(--button); color: var(--button-ink); font: inherit; font-weight: 500; cursor: pointer; }
</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true">U</div>
  <h1>You're offline.</h1>
  <p>The desk needs a connection. Nothing is saved on this device, so pages load again once you're back online.</p>
  <button type="button" onclick="location.reload()">Try again</button>
</main>
</body>
</html>`;

// Page loads go to the network. When there is none, the offline page answers instead of the browser's error.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.mode !== "navigate") return;
  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(request);
      } catch {
        return new Response(OFFLINE_PAGE, {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
    })(),
  );
});
