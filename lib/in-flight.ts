// One read for everyone who asks at the same moment. A call made while the same read is still running gets that read's
// answer instead of starting its own, and once it settles the next call reads again. Nothing finished is kept, so an
// answer is never older than the read it joined (a round trip at most), unlike a cache.
//
// The home page's reads go through this. Each visit made five or six database calls, the MongoDB driver Prisma uses
// opens ten connections, and the live server's round trip to Atlas is a couple of hundred milliseconds, so 25 visitors
// at once queued behind each other: about 3 seconds each (QA, 28 November 2026).
const running = new Map<string, Promise<unknown>>();

export function joinInFlight<T>(key: string, read: () => Promise<T>): Promise<T> {
  const current = running.get(key);
  if (current) return current as Promise<T>;
  const started: Promise<T> = read().finally(() => {
    if (running.get(key) === started) running.delete(key);
  });
  running.set(key, started);
  return started;
}
