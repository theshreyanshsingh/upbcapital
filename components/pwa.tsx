"use client";

import { useEffect, useState } from "react";
import { checkPushDevice, sendTestPush, stopAllPush, subscribePush, unsubscribePush } from "@/actions/push";
import { Button } from "@/components/ui/button";

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
  standalone?: boolean;
};

const WORKER = "/sw.js";

async function registerWorker() {
  if (!("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.register(WORKER, { scope: "/" });
}

// Mounted once in the desk layout. It installs the service worker, keeps the app icon's badge at the unread count,
// and drops this browser's push address if another account turned it on here and has since signed out.
export function Pwa({ unread }: { unread: number }) {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const registration = await registerWorker();
        const subscription = await registration?.pushManager?.getSubscription();
        if (!subscription || cancelled) return;
        const { state } = await checkPushDevice(subscription.endpoint);
        if (state === "other") await subscription.unsubscribe();
      } catch {
        // A blocked or failed worker leaves the site working as before.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const nav = navigator as BadgeNavigator;
    try {
      const done = unread > 0 ? nav.setAppBadge?.(unread) : nav.clearAppBadge?.();
      done?.catch(() => undefined);
    } catch {
      // Badges only exist on some installed apps.
    }
  }, [unread]);

  return null;
}

function keyBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = window.atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function sameKey(current: ArrayBuffer | null | undefined, expected: Uint8Array) {
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index]);
}

function readyWorker(ms = 10_000) {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ms)),
  ]);
}

type Support = "checking" | "ready" | "unsupported" | "ios-install";
type Note = { tone: "ok" | "bad"; text: string } | null;

// The opt-in on the notice settings page. Permission is asked only from the button, as iOS requires.
export function PushControl({ publicKey, devices }: { publicKey: string | null; devices: number }) {
  const [support, setSupport] = useState<Support>("checking");
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [here, setHere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const nav = navigator as BadgeNavigator;
      const ios = /iPad|iPhone|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
      const standalone = window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
      const capable = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
      if (ios && !standalone) {
        if (!cancelled) setSupport("ios-install");
        return;
      }
      if (!capable) {
        if (!cancelled) setSupport("unsupported");
        return;
      }
      setPermission(Notification.permission);
      try {
        const registration = await registerWorker();
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription) {
          const { state } = await checkPushDevice(subscription.endpoint);
          if (!cancelled) setHere(state === "mine");
        }
      } catch {
        // Shown as off. Turning it on tries again.
      }
      if (!cancelled) setSupport("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function turnOn() {
    if (!publicKey) return;
    setBusy(true);
    setNote(null);
    try {
      // First, while the tap still counts as the user's own gesture.
      const answer = await Notification.requestPermission();
      setPermission(answer);
      if (answer !== "granted") {
        setNote({
          tone: "bad",
          text: answer === "denied" ? "Notifications are blocked for this site. Allow them in the browser's site settings, then try again." : "Push stays off. Nothing changed.",
        });
        return;
      }
      await registerWorker();
      const registration = await readyWorker();
      if (!registration) {
        setNote({ tone: "bad", text: "The app's worker didn't start. Reload the page and try again." });
        return;
      }
      const key = keyBytes(publicKey);
      let subscription = await registration.pushManager.getSubscription();
      // An address made with an older desk key can't take this desk's notices, so it is replaced.
      if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
        await subscription.unsubscribe().catch(() => undefined);
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const saved = await subscribePush(subscription.toJSON());
      if (!saved.ok) {
        await subscription.unsubscribe().catch(() => undefined);
        setNote({ tone: "bad", text: saved.error });
        return;
      }
      setHere(true);
      setNote({ tone: "ok", text: saved.message });
    } catch {
      setNote({ tone: "bad", text: "This browser couldn't turn on push. Try again, or use another browser." });
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setNote(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        const result = await unsubscribePush(subscription.endpoint);
        await subscription.unsubscribe().catch(() => undefined);
        setNote(result.ok ? { tone: "ok", text: result.message } : { tone: "bad", text: result.error });
      } else {
        setNote({ tone: "ok", text: "Push is off for this device." });
      }
      setHere(false);
    } catch {
      setNote({ tone: "bad", text: "Push couldn't be turned off here. Try again." });
    } finally {
      setBusy(false);
    }
  }

  async function offEverywhere() {
    setBusy(true);
    setNote(null);
    try {
      const result = await stopAllPush();
      const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration("/") : undefined;
      await (await registration?.pushManager?.getSubscription())?.unsubscribe().catch(() => undefined);
      setHere(false);
      setNote(result.ok ? { tone: "ok", text: result.message } : { tone: "bad", text: result.error });
    } catch {
      setNote({ tone: "bad", text: "Push couldn't be turned off. Try again." });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setNote(null);
    try {
      const result = await sendTestPush();
      setNote(result.ok ? { tone: "ok", text: result.message } : { tone: "bad", text: result.error });
    } catch {
      setNote({ tone: "bad", text: "The test didn't send. Try again." });
    } finally {
      setBusy(false);
    }
  }

  const others = Math.max(devices - (here ? 1 : 0), 0);
  return (
    <div className="space-y-4">
      {!publicKey ? (
        <p className="text-sm text-muted-foreground">Push isn&apos;t set up on this desk yet. Email and in-app notices still work.</p>
      ) : support === "checking" ? (
        <p className="text-sm text-muted-foreground">Checking this browser…</p>
      ) : support === "ios-install" ? (
        <p className="text-sm text-foreground">
          On iPhone and iPad, add UPB Capital to your home screen first. Tap Share, then Add to Home Screen. Open the app from your home screen and turn push on there.
        </p>
      ) : support === "unsupported" ? (
        <p className="text-sm text-muted-foreground">This browser can&apos;t take push notices. Email and in-app notices still work.</p>
      ) : (
        <>
          <p className="text-sm text-foreground">
            {here ? "Push is on for this device." : permission === "denied" ? "Notifications are blocked for this site in this browser. Allow them in the browser's site settings to turn push on." : "Push is off for this device."}
          </p>
          <div className="flex flex-wrap gap-2">
            {here ? (
              <>
                <Button type="button" variant="outline" className="h-10 text-[13px] font-medium" disabled={busy} onClick={turnOff}>
                  Turn off push on this device
                </Button>
                <Button type="button" variant="outline" className="h-10 text-[13px] font-medium" disabled={busy} onClick={test}>
                  Send a test notice
                </Button>
              </>
            ) : (
              <Button type="button" className="h-10 text-[13px] font-medium" disabled={busy || permission === "denied"} onClick={turnOn}>
                {busy ? "Turning on…" : "Turn on push for this device"}
              </Button>
            )}
          </div>
        </>
      )}
      {publicKey && devices > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
          <span>
            {others > 0 ? `${others} other device${others === 1 ? "" : "s"} also take${others === 1 ? "s" : ""} push for this account.` : here ? "No other device takes push for this account." : `${devices} device${devices === 1 ? "" : "s"} take${devices === 1 ? "s" : ""} push for this account.`}
          </span>
          <button type="button" className="font-medium text-link disabled:opacity-50" disabled={busy} onClick={offEverywhere}>
            Turn off on every device
          </button>
        </div>
      )}
      <p role="status" aria-live="polite" className={note?.tone === "bad" ? "text-sm text-bad" : "text-sm text-good"}>
        {note?.text ?? ""}
      </p>
    </div>
  );
}
