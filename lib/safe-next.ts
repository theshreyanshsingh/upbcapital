// Where sign-in and sign-up send someone back to: a path on this site, or the fallback. "//host", "/\host" and
// anything a browser would read as another origin fail, as do control characters and very long values, so a link
// can't turn the sign-in page into a way off the site.
export function safeNext(value: unknown, fallback: string) {
  const text = typeof value === "string" ? value : "";
  if (!text.startsWith("/") || text.length > 512 || /[\\\u0000-\u001f\u007f]/.test(text)) return fallback;
  if (text.startsWith("//")) return fallback;
  try {
    const base = "https://upb.invalid";
    const url = new URL(text, base);
    if (url.origin !== base) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
