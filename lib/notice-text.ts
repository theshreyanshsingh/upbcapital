// Notices and errors arrive in the address bar, so anyone can put one in a link. Known notices use the copy
// table in components/notice.tsx. Free text from the desk's own redirects shows when it reads as a plain sentence. Anything that would
// send the reader somewhere (a link, an email address, a phone number), or runs long, is not repeated.
// Next has already decoded the value once, so decoding it again would break on a literal "%".
export function safeNoticeText(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || clean.length > 300) return null;
  if (/https?:|www\.|@|\b\d{3}[\s().-]*\d{3}[\s.-]*\d{4}\b/i.test(clean)) return null;
  return clean;
}
